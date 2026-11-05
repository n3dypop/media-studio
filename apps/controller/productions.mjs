import {randomUUID} from 'node:crypto';
import {ApiError,digest,normalizeRequest,terminalPhases} from './store.mjs';
import {validateEnhancementSpec} from './enhancer.mjs';
import {MODEL_PROFILES} from './workflows.mjs';
import {mediaIntent,assertModeProfile,assertActiveProfile,MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS,UUID} from './media-modes.mjs';
const officialInputProfile=id=>[...MOSS_OFFICIAL_IDS,...QWEN21_OFFICIAL_IDS].includes(id);

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text=(value,max,label)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max) throw new ApiError(400,`${label}が不正です。`);
  return value.trim();
};
const textList=(value,label,{min=0,max=20}={})=>{
  if(!Array.isArray(value)||value.length<min||value.length>max)throw new ApiError(400,`${label}が不正です。`);
  return value.map(item=>text(item,1000,label));
};
export function validateSession(session) { return text(session,160,'DSH session'); }
function validateBrief(brief) {
  if(!brief||!Array.isArray(brief.criteria)||brief.criteria.length<1||brief.criteria.length>12||!Array.isArray(brief.invariants)||brief.invariants.length>20) throw new ApiError(400,'依頼・評価条件・固定条件を指定してください。');
  const criteria=brief.criteria.map(c=>({id:text(c.id,64,'criterion id'),description:text(c.description,1000,'criterion')}));
  if(new Set(criteria.map(c=>c.id)).size!==criteria.length) throw new ApiError(400,'評価条件IDが重複しています。');
  if(!Object.hasOwn(MODEL_PROFILES,brief.modelProfile))throw new ApiError(400,'指定した画像モデルは登録されていません。');
  const media=mediaIntent(brief);assertModeProfile(media.mode,brief.modelProfile);
  const peInputAssetIds=brief.peInputAssetIds;
  if(peInputAssetIds!==undefined&&(!MOSS_OFFICIAL_IDS.includes(brief.modelProfile)||!['t2i','layout'].includes(media.mode)||!Array.isArray(peInputAssetIds)||peInputAssetIds.length>1||peInputAssetIds.some(id=>typeof id!=='string'||!UUID.test(id))||peInputAssetIds.some(id=>[...(media.inputAssetIds??(media.inputAssetId?[media.inputAssetId]:[])),...media.referenceAssetIds].includes(id))))throw new ApiError(400,'PE専用画像は生成入力・観察参照と分けて明示してください。');
  const structured={};
  for(const field of ['requiredConditions','preferredConditions','avoid','steps'])if(brief[field]!==undefined)structured[field]=textList(brief[field],field);
  if(brief.usage!==undefined)structured.usage=text(brief.usage,2000,'usage');
  return {request:text(brief.request,8000,'request'),criteria,invariants:brief.invariants.map(s=>text(s,1000,'invariant')),modelProfile:brief.modelProfile,...media,...(peInputAssetIds!==undefined?{peInputAssetIds:[...peInputAssetIds]}:{}),...structured};
}
export class ProductionStore {
  constructor(store,{defaultModelProfile='qwen-photo-v1',assets=null}={}) {
    if(!Object.hasOwn(MODEL_PROFILES,defaultModelProfile))throw new Error('Invalid default model profile');
    this.defaultModelProfile=defaultModelProfile;
    this.store=store;this.db=store.db;
    this.assets=assets;
    this.db.exec(`CREATE TABLE IF NOT EXISTS productions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(session_id,request_id));
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,production_id TEXT NOT NULL,run_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL);`);
  }
  get(id,session) {
    const row=this.db.prepare('SELECT session_id,json FROM productions WHERE id=?').get(id);
    if(!row||row.session_id!==validateSession(session)) throw new ApiError(404,'この会話の制作記録がありません。');
    return JSON.parse(row.json);
  }
  latestCompletedRun(id,session){
    const p=this.get(id,session),attempts=p.attempts;
    if(!Array.isArray(attempts)||!attempts.length||new Set(attempts).size!==attempts.length||typeof p.latestRunId!=='string'||attempts.at(-1)!==p.latestRunId)throw new ApiError(409,'最新の生成を一意に確認できません。対象runを明示してください。');
    const run=this.store.get(p.latestRunId);
    if(!run||run.id!==p.latestRunId||run.productionId!==p.id||run.sessionId!==session||run.phase!=='completed'||run.cancelRequested===true||p.cancelRequested===true||!Array.isArray(run.artifacts)||!run.artifacts.some(a=>typeof a?.mime==='string'&&(a.mime.startsWith('image/')||a.mime==='video/mp4')))throw new ApiError(409,'最新の完了済み成果物を一意に確認できません。対象runを明示してください。');
    return {production:p,run};
  }
  list(session,requestId) {
    validateSession(session);
    return (requestId?this.db.prepare('SELECT json FROM productions WHERE session_id=? AND request_id=?').all(session,requestId):this.db.prepare('SELECT json FROM productions WHERE session_id=? ORDER BY rowid DESC LIMIT 50').all(session)).map(row=>JSON.parse(row.json));
  }
  findRenderByRequest(id,session,requestId) {
    const production=this.get(id,session);
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'生成要求IDが不正です。');
    const row=this.db.prepare('SELECT json FROM runs WHERE request_id=?').get(requestId);
    if(!row)throw new ApiError(404,'生成要求を確認できません。未存在は送信失敗の証明ではありません。');
    const run=JSON.parse(row.json);
    if(run.requestId!==requestId||run.sessionId!==session||run.productionId!==id||typeof run.id!=='string'||!Array.isArray(production.attempts)||!production.attempts.includes(run.id))throw new ApiError(404,'この会話の制作に属する生成要求を確認できません。');
    return {run,production};
  }
  listAll() {
    return this.db.prepare('SELECT json FROM productions ORDER BY rowid DESC LIMIT 50').all().map(row=>{
      const p=JSON.parse(row.json);
      const run=p.latestRunId?this.store.get(p.latestRunId):null;
      if(p.cancelRequested&&(!run||terminalPhases.has(run.phase))) p.phase='cancelled';
      else if(!p.cancelRequested&&p.phase==='generating'&&run&&terminalPhases.has(run.phase)) p.phase=this.failedWithoutImage(p)?'needs_user':'awaiting_evaluation';
      return p;
    });
  }
  ownerOf(id) {return this.db.prepare('SELECT session_id FROM productions WHERE id=?').get(id)?.session_id??null;}
  failedWithoutImage(production) {
    const run=production.latestRunId?this.store.get(production.latestRunId):null;
    // Only a confirmed terminal failure may be corrected without fabricating an
    // image evaluation. Unknown submission/cleanup always remains non-terminal.
    return run?.phase==='failed'&&run.artifacts.length===0;
  }
  resourceAdmissionRetryable(production, run) {
    // This narrow case never handed a prompt to ComfyUI. Do not treat a
    // timeout, unknown submission, cancelled job, or missing cleanup as safe.
    if(!run || run.id!==production.latestRunId || run.productionId!==production.id || run.sessionId!==production.sessionId ||
      run.phase!=='failed' || run.cancelRequested!==false || run.promptId!==null || !Array.isArray(run.artifacts) || run.artifacts.length!==0 ||
      run.resourceAdmission?.decision!=='rejected' || run.resourceAdmission?.code!=='GENERATOR_RESOURCES_UNAVAILABLE' ||
      run.coreRestored?.owner!=='core' || run.coreRestored?.blocked!==false || run.coreRestored?.generationRunId!==null || run.coreRestored?.activeCore!==0 ||
      run.submittedAt!=null || run.submitIntent!=null || run.submission!=null || run.accepted===true || run.definitelyRejected===true || run.enhancerStartIntent!=null) return false;
    // Require the recorded refusal followed by restoration; missing or
    // contradictory durable evidence is not proof of a safe retry. A submit
    // event anywhere in this run also makes the outcome unsafe to repeat.
    const events=this.db.prepare("SELECT seq,type,json FROM events WHERE run_id=? AND type IN ('generator_admission_rejected','core_restored','submit_intent','submit_ack','submit_unknown','submit_rejected') ORDER BY seq").all(run.id);
    if(events.some(event=>event.type.startsWith('submit_'))) return false;
    let rejectedSeq=null,restored=false;
    for(const event of events){
      let data;try{data=JSON.parse(event.json);}catch{return false;}
      if(event.type==='generator_admission_rejected'){
        if(data.resourceAdmission?.decision!=='rejected'||data.resourceAdmission?.code!=='GENERATOR_RESOURCES_UNAVAILABLE') return false;
        rejectedSeq=event.seq;restored=false;
      }
      if(event.type==='core_restored'){
        if(rejectedSeq===null||event.seq<=rejectedSeq||data.coreRestored?.owner!=='core'||data.coreRestored?.blocked!==false||data.coreRestored?.generationRunId!==null||data.coreRestored?.activeCore!==0) return false;
        restored=true;
      }
    }
    return restored;
  }
  mayRevise(production) {
    return production.evaluations.some(e=>e.runId===production.latestRunId&&e.decision==='revise')||
      (production.phase!=='completed'&&production.activeFeedback?.afterRunId===production.latestRunId);
  }
  write(production,type,data={}) {
    production.updatedAt=new Date().toISOString();
    this.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(production),production.id);
    this.store.event(production.id,type,{revision:production.revision,...data});
    return production;
  }
  check(production,revision) {
    if(production.cancelRequested) throw new ApiError(409,'この制作は停止済みです。');
    if(production.phase==='completed') throw new ApiError(409,'この制作は完了しています。新しい要望は別の制作で開始してください。');
    if(production.revision!==revision) throw new ApiError(409,'制作記録が更新されています。読み直してください。');
  }
  create(session,input) {
    validateSession(session);
    if(input.modelProfile&&input.brief?.modelProfile&&input.modelProfile!==input.brief.modelProfile)throw new ApiError(400,'画像モデル指定が一致しません。');
    assertActiveProfile(input.modelProfile??input.brief?.modelProfile??this.defaultModelProfile);
    const requestId=text(input.requestId,160,'requestId'),brief=validateBrief({...input.brief,modelProfile:input.modelProfile??input.brief?.modelProfile??this.defaultModelProfile}),hash=digest(brief);
    for(const [id,kind] of [[brief.inputAssetId,'input'],...(brief.inputAssetIds??[]).map(id=>[id,'input']),...(brief.peInputAssetIds??[]).map(id=>[id,'input']),...brief.referenceAssetIds.map(id=>[id,'reference'])])if(id){if(!this.assets||this.assets.get(id,session).purpose!==kind)throw new ApiError(409,'画像がこの会話に属していないか、登録用途が一致しません。');}
    return this.store.transaction(()=>{
      const existing=this.db.prepare('SELECT json,payload_hash FROM productions WHERE session_id=? AND request_id=?').get(session,requestId);
      if(existing) {if(existing.payload_hash!==hash) throw new ApiError(409,'同じrequestIdの依頼内容を変更できません。');return {production:JSON.parse(existing.json),created:false};}
      assertActiveProfile(brief.modelProfile);
      const now=new Date().toISOString();
      const production={id:randomUUID(),sessionId:session,requestId,brief,briefHash:hash,revision:0,phase:'planning',cancelRequested:false,workflowId:null,latestRunId:null,bestRunId:null,iterationPlans:[],attempts:[],evaluations:[],createdAt:now,updatedAt:now};
      this.db.prepare('INSERT INTO productions VALUES(?,?,?,?,?)').run(production.id,session,requestId,hash,JSON.stringify(production));
      this.store.event(production.id,'production_created',{briefHash:hash});
      return {production,created:true};
    });
  }
  bindWorkflow(id,session,revision,workflow,mossPeAdoption=null) {
    return this.store.transaction(()=>{
      const p=this.get(id,session);this.check(p,revision);
      if(workflow.modelProfile!==(p.brief.modelProfile??'qwen-photo-v1'))throw new ApiError(409,'指定モデルを別モデルへ変更できません。新しい制作で指定してください。');
      if((workflow.mode??'t2i')!==(p.brief.mode??'t2i')||(officialInputProfile(workflow.modelProfile)?JSON.stringify(workflow.inputAssetIds)!==JSON.stringify(p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[])):(workflow.inputAsset?.id??null)!==(p.brief.inputAssetId??null)))throw new ApiError(409,'workflowのモードまたは入力画像が制作と一致しません。');
      if(p.latestRunId&&!this.failedWithoutImage(p)&&!this.mayRevise(p)) throw new ApiError(409,'直前の画像を評価するか利用者の追加指示を記録してから次の変更を作成してください。');
      if(mossPeAdoption!==null&&(!mossPeAdoption||!['moss','qwen'].includes(mossPeAdoption.family)||mossPeAdoption.workflowId!==workflow.id||mossPeAdoption.workflowSha256!==workflow.sha256||mossPeAdoption.briefHash!==p.briefHash))throw new ApiError(409,'PE adoption and workflow do not match');
      p.workflowId=workflow.id;p.workflowSha256=workflow.sha256;p.workflowEnhancement=mossPeAdoption;p.revision++;p.phase='ready';
      return this.write(p,'workflow_selected',{workflowId:workflow.id,sha256:workflow.sha256,rationale:workflow.rationale,...(mossPeAdoption?{mossPeAdoption}:{})});
    });
  }
  renderPrepared(id,session,input,workflow){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','workflowId','expectedRevision'].includes(key)))throw new ApiError(400,'保存済みworkflowの生成にはworkflowId、revision、requestIdのみを指定してください。条件変更は新しいdraftを作成してください。');
    const current=this.get(id,session);
    const previous=typeof input.requestId==='string'?this.db.prepare('SELECT json FROM runs WHERE request_id=?').get(input.requestId):null;
    if(previous){const run=JSON.parse(previous.json);if(run.productionId!==id||run.sessionId!==session||run.spec?.workflow?.id!==input.workflowId||run.spec?.workflow?.sha256!==workflow.sha256||workflow.productionId!==id)throw new ApiError(409,'同じrequestIdは別の制作またはworkflowに使われています。');return {run,production:current,created:false};}
    if(!officialInputProfile(current.brief.modelProfile)||![4,5].includes(workflow.schemaVersion)||workflow.productionId!==id||workflow.id!==input.workflowId||workflow.id!==current.workflowId||workflow.sha256!==current.workflowSha256||workflow.modelProfile!==current.brief.modelProfile)throw new ApiError(409,'保存済みworkflowと制作の紐付けが一致しません。');
    const request=workflow.request,output=workflow.output;
    if(!request||typeof request!=='object'||!output||typeof output!=='object')throw new ApiError(409,'保存済みworkflowの生成条件を確認できません。');
    const qwen=workflow.schemaVersion===5,mode=workflow.mode;
    const derived={requestId:input.requestId,workflowId:input.workflowId,expectedRevision:input.expectedRevision,prompt:request.prompt,negativePrompt:request.negativePrompt??'',seed:request.seed??'42',width:output.width,height:output.height,steps:request.steps??(qwen&&request.variant==='turbo'?8:mode==='edit'&&!qwen?30:25),enhancer:false};
    return this.render(id,session,derived,workflow);
  }
  render(id,session,input,workflow) {
    const current=this.get(id,session),mode=current.brief.mode??'t2i';
    assertActiveProfile(current.brief.modelProfile);
    if((input.mode!==undefined&&input.mode!==mode)||(input.inputAssetId!==undefined&&input.inputAssetId!==(current.brief.inputAssetId??null)))throw new ApiError(409,'生成モードまたは入力画像を制作途中で変更できません。');
    if(input.inputAssetIds!==undefined&&JSON.stringify(input.inputAssetIds)!==JSON.stringify(current.brief.inputAssetIds??[]))throw new ApiError(409,'生成入力の順序を制作途中で変更できません。');
    const normalized=normalizeRequest({...input,mode,inputAssetId:current.brief.inputAssetId??null,...(current.brief.inputAssetIds?{inputAssetIds:current.brief.inputAssetIds}:{}),referenceAssetIds:current.brief.referenceAssetIds??[],modelProfile:workflow.modelProfile});
    if(![undefined,false,true].includes(input.enhancer)) throw new ApiError(400,'enhancerはbooleanです。');
    if(workflow.productionId!==id) throw new ApiError(409,'別制作のworkflowです。');
    if(workflow.modelProfile!==(current.brief.modelProfile??'qwen-photo-v1')||(input.modelProfile!==undefined&&input.modelProfile!==workflow.modelProfile))throw new ApiError(409,'生成モデルが依頼の指定と一致しません。');
    // Replay may return its existing run even after the production revision advanced.
    const existing=this.db.prepare('SELECT json FROM runs WHERE request_id=?').get(normalized.requestId);
    if(existing&&JSON.parse(existing.json).productionId!==id) throw new ApiError(409,'requestIdが別の制作に使われています。');
    if((workflow.mode??'t2i')!==mode||(officialInputProfile(workflow.modelProfile)?JSON.stringify(workflow.inputAssetIds)!==JSON.stringify(current.brief.inputAssetIds??(current.brief.inputAssetId?[current.brief.inputAssetId]:[])):(workflow.inputAsset?.id??null)!==(current.brief.inputAssetId??null)))throw new ApiError(409,'workflowと制作の画像入力が一致しません。');
    const referenceAssets=(current.brief.referenceAssetIds??[]).map(id=>{const asset=this.assets?.get(id,session);if(!asset||asset.purpose!=='reference')throw new ApiError(409,'参照画像を確認できません。');return {id:asset.id,purpose:asset.purpose,sha256:asset.sha256,width:asset.width,height:asset.height};});
    if(current.workflowEnhancement&&(current.workflowEnhancement.workflowId!==workflow.id||current.workflowEnhancement.workflowSha256!==workflow.sha256||current.workflowEnhancement.briefHash!==current.briefHash))throw new ApiError(409,'Selected PE adoption and workflow no longer match');
    const spec={...normalized.spec,modelProfile:workflow.modelProfile,workflow,inputAsset:workflow.inputAsset??null,...(workflow.schemaVersion===4?{inputAssets:workflow.request.inputAssets.map(x=>x.binding)}:workflow.schemaVersion===5?{inputAssets:workflow.request.inputAssets}:{}),referenceAssets,assetSessionId:session,enhancer:input.enhancer??false,invariants:current.brief.invariants,briefHash:current.briefHash,...(current.workflowEnhancement?{[current.workflowEnhancement.family==='qwen'?'qwenPeAdoption':'mossPeAdoption']:current.workflowEnhancement}:{})};
    if(officialInputProfile(workflow.modelProfile)&&spec.enhancer)throw new ApiError(400,'公式フローのプロンプト強化は、書換え内容の記録と評価が完成するまで利用できません。');
    if(spec.enhancer&&mode!=='t2i')throw new ApiError(400,'プロンプト補助は現在t2iだけで使用できます。');
    if(spec.enhancer) {
      try {validateEnhancementSpec(spec);}
      catch(error) {throw new ApiError(400,'プロンプト補助の入力条件を確認してください。 '+error.message);}
    }
    const result=this.store.create({...normalized,spec},{decorate:run=>{
      const p=this.get(id,session);this.check(p,input.expectedRevision);
      if(p.workflowId!==workflow.id||p.workflowSha256!==workflow.sha256) throw new ApiError(409,'現在選択されているworkflowと一致しません。');
      let resourceRetryOf=null;
      if(p.latestRunId) {
        if(!this.mayRevise(p)&&!this.failedWithoutImage(p)) throw new ApiError(409,'評価結果または利用者の追加指示が再生成を要求していません。');
        const previous=this.store.get(p.latestRunId),old=previous.spec;
        const signature=s=>digest({prompt:s.prompt,negativePrompt:s.negativePrompt,width:s.width,height:s.height,steps:s.steps,workflowHash:s.workflow.sha256,enhancer:s.enhancer,mode:s.mode??'t2i',inputAsset:s.inputAsset,referenceAssets:s.referenceAssets,denoise:s.denoise,frames:s.frames,fps:s.fps});
        if(signature(old)===signature(spec)) {
          if(old.seed!==spec.seed||!this.resourceAdmissionRetryable(p,previous)) throw new ApiError(409,'前回から具体的な変更がありません。seedだけの変更を改善として再実行しません。');
          resourceRetryOf=previous.id;
        }
      }
      const feedbackId=p.activeFeedback?.id??null;
      if(feedbackId){const item=p.feedbackRequests.find(feedback=>feedback.id===feedbackId);if(item)item.resultRunId=run.id;p.activeFeedback=null;}
      p.revision++;p.phase='generating';p.latestRunId=run.id;p.attempts.push(run.id);
      this.write(p,'render_requested',{runId:run.id,attempt:p.attempts.length,...(feedbackId?{feedbackId}:{}),...(resourceRetryOf?{resourceRetryOf}:{})});
      return {productionId:id,productionRevision:p.revision,sessionId:session,attempt:p.attempts.length,...(feedbackId?{feedbackId}:{}),...(resourceRetryOf?{resourceRetryOf}:{})};
    }});
    return {...result,production:this.get(id,session)};
  }
  evaluate(id,session,input) {
    return this.store.transaction(()=>{
      const p=this.get(id,session);this.check(p,input.expectedRevision);
      const run=this.store.get(input.runId);
      if(!run||run.productionId!==id||p.latestRunId!==run.id||!terminalPhases.has(run.phase)) throw new ApiError(409,'評価対象の生成が完了していません。');
      if(p.evaluations.some(e=>e.runId===run.id)) throw new ApiError(409,'この生成の評価は記録済みです。');
      if(run.specHash!==input.specHash||!run.artifacts.some(a=>a.sha256===input.artifactSha256)) throw new ApiError(409,'評価対象の画像・生成条件が一致しません。');
      if(run.spec.mode==='video'){
        const primary=run.artifacts.find(a=>a.mime==='video/mp4'),frames=run.artifacts.filter(a=>a.role==='evaluation_frame').map(a=>a.sha256).sort();
        if(!primary||primary.sha256!==input.artifactSha256||frames.length!==3||!Array.isArray(input.evaluationFrameSha256s)||digest([...input.evaluationFrameSha256s].sort())!==digest(frames))throw new ApiError(409,'動画本体と全評価フレームを確認してから評価してください。');
      }
      if(!Array.isArray(input.criteria)||input.criteria.length!==p.brief.criteria.length) throw new ApiError(400,'全評価条件への判定が必要です。');
      const criteria=input.criteria.map(c=>{
        if(!c||typeof c!=='object'||Array.isArray(c))throw new ApiError(400,'評価条件が不正です。');
        const status=c.status??(c.met===true?'met':c.met===false?'unmet':null);
        if(!['met','unmet','unverified'].includes(status)||(c.met!==undefined&&(typeof c.met!=='boolean'||status!==(c.met?'met':'unmet'))))throw new ApiError(400,'判定には met / unmet / unverified を指定してください。');
        const kind=c.kind??'unspecified';if(!['technical','visual','unspecified'].includes(kind))throw new ApiError(400,'評価の種類が不正です。');
        const item={id:text(c.id,64,'criterion id'),met:status==='unverified'?null:status==='met',status,kind,evidence:text(c.evidence,2000,'評価根拠')};
        if(c.location!==undefined)item.location=text(c.location,1000,'位置・時刻');
        if(c.severity!==undefined){if(!['low','medium','high'].includes(c.severity))throw new ApiError(400,'重要度が不正です。');item.severity=c.severity;}
        return item;
      });
      if(new Set(criteria.map(c=>c.id)).size!==criteria.length||p.brief.criteria.some(c=>!criteria.some(e=>e.id===c.id))) throw new ApiError(400,'評価条件の集合が依頼と一致しません。');
      if(!['complete','revise','needs_user'].includes(input.decision)) throw new ApiError(400,'評価後の判断が不正です。');
      if(input.decision==='complete'&&criteria.some(c=>c.status!=='met')) throw new ApiError(400,'未達または未確認の条件があるため完成にはできません。');
      // The current media delivery exposes only three stills to the reviewer.
      // A claim of full temporal review is not proof of actual video access.
      if(run.spec.mode==='video'&&input.decision==='complete')throw new ApiError(400,'動画は抜粋3フレームのみ評価可能です。全編の時間的品質は未確認のため完成にはできません。');
      const nextChange=input.decision==='revise'?text(input.nextChange,3000,'次回の具体的変更'):String(input.nextChange??'').slice(0,3000);
      const strengths=input.strengths===undefined?[]:textList(input.strengths,'保持すべき長所');
      if(input.bestRunId!==undefined)this.assertBestCandidate(p,input.bestRunId,run.id);
      const evaluation={id:randomUUID(),productionId:id,runId:run.id,briefHash:p.briefHash,specHash:run.specHash,artifactSha256:input.artifactSha256,...(run.spec.mode==='video'?{evaluationFrameSha256s:input.evaluationFrameSha256s,videoCoverage:{kind:'sampled_frames',frameSha256s:input.evaluationFrameSha256s,unverified:['continuous motion','temporal consistency','flicker','camera movement across the complete video']}}:{}),criteria,strengths,decision:input.decision,nextChange,at:new Date().toISOString()};
      this.db.prepare('INSERT INTO evaluations VALUES(?,?,?,?)').run(evaluation.id,id,run.id,JSON.stringify(evaluation));
      if(input.bestRunId!==undefined)p.bestRunId=input.bestRunId;
      p.evaluations.push(evaluation);p.revision++;p.phase=input.decision==='complete'?'completed':input.decision==='revise'?'revising':'needs_user';
      this.write(p,'image_evaluated',{evaluation});return {production:p,evaluation};
    });
  }
  assertBestCandidate(p,runId,currentEvaluationRunId=null) {
    if(typeof runId!=='string'||!p.attempts.includes(runId))throw new ApiError(409,'最良候補はこの制作の成果物から選んでください。');
    const run=this.store.get(runId);
    if(!run||run.productionId!==p.id||run.phase!=='completed'||!run.artifacts?.length||
      (runId!==currentEvaluationRunId&&!p.evaluations.some(e=>e.runId===runId)))throw new ApiError(409,'最良候補は評価済みの成功した成果物に限ります。');
  }
  planIteration(id,session,input) {
    return this.store.transaction(()=>{
      const p=this.get(id,session);this.check(p,input.expectedRevision);
      const feedback=p.activeFeedback?.afterRunId===p.latestRunId?p.activeFeedback:null;
      const expectedSource=feedback?.sourceRunId??p.latestRunId;
      const previous=p.evaluations.find(e=>e.runId===expectedSource);
      if(input.sourceRunId!==expectedSource||!previous||(!feedback&&previous.decision!=='revise'))throw new ApiError(409,'直前の評価または利用者の追加指示に対応する成果物へ計画を結び付けてください。');
      if(!['prompt','conditioning','workflow','model','execution','other'].includes(input.category)||!['partial_edit','regenerate','change_model','ask_user'].includes(input.action))throw new ApiError(400,'改善分類または処理が不正です。');
      if(input.bestRunId!==undefined)this.assertBestCandidate(p,input.bestRunId);
      const plan={id:randomUUID(),sourceRunId:input.sourceRunId,sourceSpecHash:previous.specHash,sourceArtifactSha256:previous.artifactSha256,category:input.category,action:input.action,hypothesis:text(input.hypothesis,3000,'改善仮説'),preserve:textList(input.preserve,'維持点',{min:1}),changes:textList(input.changes,'変更点',{min:1}),comparison:text(input.comparison,3000,'比較方法'),at:new Date().toISOString()};
      if(input.bestRunId!==undefined){p.bestRunId=input.bestRunId;plan.bestRunId=input.bestRunId;}
      (p.iterationPlans??=[]).push(plan);p.revision++;
      this.write(p,'iteration_planned',{plan});return {production:p,plan};
    });
  }
  resumeWithFeedback(id,session,input) {
    const requestId=text(input?.requestId,160,'requestId');
    const sourceRunId=text(input?.sourceRunId,160,'sourceRunId');
    const feedback=text(input?.feedback,4000,'利用者の追加指示');
    const hash=digest({sourceRunId,feedback});
    return this.store.transaction(()=>{
      const p=this.get(id,session);
      const existing=(p.feedbackRequests??[]).find(item=>item.requestId===requestId);
      if(existing){
        if(existing.hash!==hash)throw new ApiError(409,'同じrequestIdの追加指示を変更できません。');
        return {production:p,feedback:existing,created:false};
      }
      if(p.cancelRequested)throw new ApiError(409,'停止済みの制作には追加指示を登録できません。');
      if(p.revision!==input.expectedRevision)throw new ApiError(409,'制作記録が更新されています。読み直してください。');
      if(!['completed','needs_user'].includes(p.phase))throw new ApiError(409,'完了または利用者の判断待ちの制作への追加指示だけを受け付けます。');
      // An old evaluated candidate does not authorize bypassing an unresolved or
      // image-less latest attempt. The latest run must itself be evaluated.
      this.assertBestCandidate(p,p.latestRunId);
      this.assertBestCandidate(p,sourceRunId);
      const record={id:randomUUID(),requestId,hash,sourceRunId,afterRunId:p.latestRunId,feedback,at:new Date().toISOString()};
      (p.feedbackRequests??=[]).push(record);p.activeFeedback=record;p.phase='revising';p.revision++;
      this.write(p,'user_feedback_recorded',{feedback:record});return {production:p,feedback:record,created:true};
    });
  }
  userDecision(id,session,input) {
    const requestId=text(input?.requestId,160,'requestId'),sourceRunId=text(input?.sourceRunId,160,'sourceRunId');
    if(!['accept','reject'].includes(input?.decision)||typeof input.artifactSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactSha256))throw new ApiError(400,'採否と対象画像を指定してください。');
    const feedback=input.feedback===undefined?'':typeof input.feedback==='string'&&input.feedback.length<=4000?input.feedback.trim():null;
    if(feedback===null)throw new ApiError(400,'修正要望が不正です。');
    const hash=digest({sourceRunId,artifactSha256:input.artifactSha256,decision:input.decision,feedback});
    return this.store.transaction(()=>{
      const p=this.get(id,session),existing=(p.userDecisions??[]).find(item=>item.requestId===requestId);
      if(existing){if(existing.hash!==hash)throw new ApiError(409,'同じrequestIdの採否を変更できません。');return {production:p,decision:existing,created:false};}
      if(p.revision!==input.expectedRevision||p.cancelRequested||!['needs_user','completed'].includes(p.phase)||p.latestRunId!==sourceRunId)throw new ApiError(409,'確認対象の制作状態が変わりました。');
      this.assertBestCandidate(p,sourceRunId);
      const run=this.store.get(sourceRunId),evaluation=p.evaluations.find(e=>e.runId===sourceRunId&&e.artifactSha256===input.artifactSha256);
      if(!evaluation||run.specHash!==evaluation.specHash||!run.artifacts.some(a=>a.sha256===input.artifactSha256))throw new ApiError(409,'確認対象の成果物と評価が一致しません。');
      if(p.latestUserDecision?.sourceRunId===sourceRunId)throw new ApiError(409,'この候補の採否は記録済みです。追加の要望は会話で伝えてください。');
      const record={id:randomUUID(),requestId,hash,sourceRunId,artifactSha256:input.artifactSha256,decision:input.decision,feedback,productionRevision:p.revision+1,at:new Date().toISOString(),...(input.decision==='reject'?{planningRequestId:randomUUID()}: {})};
      (p.userDecisions??=[]).push(record);p.latestUserDecision=record;
      if(input.decision==='reject'){
        const note=feedback||'この候補を採用しません。元の要求と成果物を照合し、次に検討すべき工程を提案してください。';
        const item={id:randomUUID(),requestId:'user-decision:'+requestId,hash:digest({sourceRunId,feedback:note}),sourceRunId,afterRunId:p.latestRunId,feedback:note,at:record.at,source:'user-decision'};
        (p.feedbackRequests??=[]).push(item);p.activeFeedback=item;p.phase='revising';
      }
      // User adoption is separate from the agent's criteria and phase. In
      // particular, accepting an unverified criterion never changes it to met.
      p.revision++;this.write(p,'user_decision_recorded',{decision:record});
      return {production:p,decision:record,created:true};
    });
  }
  planningDelivery(id,session,input){
    if(!['sending','accepted','unsent'].includes(input?.state)||!uuid.test(input?.planningRequestId??''))throw new ApiError(400,'検討依頼の送信状態が不正です。');
    return this.store.transaction(()=>{
      const p=this.get(id,session),d=p.latestUserDecision;
      if(!d||d.decision!=='reject'||d.planningRequestId!==input.planningRequestId)throw new ApiError(409,'検討依頼の対象が一致しません。');
      if(input.state==='sending'&&(p.cancelRequested||p.phase!=='revising'||d.sourceRunId!==p.latestRunId||p.activeFeedback?.requestId!=='user-decision:'+d.requestId))throw new ApiError(409,'検討依頼の制作は停止済み、または別の工程へ進みました。');
      if(input.state==='sending'&&d.planningDelivery&&!['unsent'].includes(d.planningDelivery.state))return {claimed:false,state:d.planningDelivery.state};
      if(input.state==='unsent'&&d.planningDelivery?.state!=='sending')throw new ApiError(409,'送信状態が変わりました。');
      const delivery={state:input.state,at:new Date().toISOString()};d.planningDelivery=delivery;
      const recorded=p.userDecisions.find(x=>x.id===d.id);recorded.planningDelivery=delivery;
      // Transport receipt only; it does not change production authoring rights
      // or invalidate a concurrently planned draft's revision.
      this.write(p,'planning_delivery_recorded',{planningRequestId:d.planningRequestId,delivery});
      return {claimed:input.state==='sending',state:input.state};
    });
  }
  cancel(id,session,{expectedRunId,expectedRevision}={}) {
    // The flag and current-attempt cancellation are one durable transaction.
    return this.store.transaction(()=>{
      const p=this.get(id,session);
      if(expectedRevision!==undefined&&p.revision!==expectedRevision||expectedRunId!==undefined&&p.latestRunId!==expectedRunId)throw new ApiError(409,'停止対象の生成または制作の状態が変わりました。');
      if(p.cancelRequested||p.phase==='completed') return p;
      p.cancelRequested=true;p.cancelRequestedAt=new Date().toISOString();p.revision++;p.phase='cancelled';
      for(const runId of p.attempts) {
        const run=this.store.get(runId);
        if(run&&!terminalPhases.has(run.phase)) {
          p.phase='cancelling';
          run.cancelRequested=true;run.cancelRequestedAt=p.cancelRequestedAt;run.updatedAt=p.cancelRequestedAt;
          this.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);
          this.store.event(run.id,'cancel_requested',{productionId:id});
        }
      }
      return this.write(p,'production_cancelled');
    });
  }
}
