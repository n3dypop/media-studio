import {createHash} from 'node:crypto';
// Authenticated DSH connection route. The browser never receives the controller
// administrator token, and the agent is not given an approval tool.
export const ACTIONS_PATH='/api/local-studio/actions';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validSession=s=>typeof s==='string'&&s.length>0&&s.length<=150&&!/[\x00-\x1f\x7f]/.test(s);
const error=(status,message)=>new Response(JSON.stringify({error:message}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const ok=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function actionsHandler({sessionQuery,controllerRequest,dshOrigin,sendPlanning,planningReceipt=async()=>false,controllerSession=sessionId=>sessionId,mutationAllowed}) {
  const planningSends=new Map();
  const planningFor=(p,decision)=>({requestId:decision.planningRequestId,text:`利用者がMedia & Resourcesで制作 ${p.id} の候補run ${decision.sourceRunId}（画像SHA-256 ${decision.artifactSha256}）を否認しました。制作が停止済み、または対象runが変更済みなら検討を開始せず、その状態を伝えてください。記録済みfeedbackと元の制作仕様・評価を読み、同じ制作で次に検討すべき工程を提案してください。利用者の修正要望: ${decision.feedback||'指定なし。勝手に条件を追加せず、必要なら利用者へ確認してください。'}。今回は計画・相談のみです。新規制作の作成、追加生成、モデル変更は実行しないでください。`});
  async function verifySession(sessionId,signal){
    if(!validSession(sessionId))throw Object.assign(new Error('会話を確認できません。'),{status:400});
    let observed;
    try{
      observed=await sessionQuery.observeSession(sessionId,{signal,projectionMode:'none'});
      const turns=(observed.events??[]).filter(event=>event?.type==='turn/start').map(event=>event?.data?.turn).filter(turn=>Number.isSafeInteger(turn)&&turn>0);
      return turns.length?Math.max(...turns):null;
    }
    catch{throw Object.assign(new Error('会話を確認できません。'),{status:404});}
    finally{observed?.[Symbol.dispose]();}
  }
  async function ownedProposal(sessionId,id,signal){
    if(!uuid.test(id??''))throw Object.assign(new Error('検索提案が不正です。'),{status:400});
    const {proposal,enabled}=await controllerRequest(`/api/search-proposals/${id}`,{signal});
    if(!proposal||proposal.sessionId!==controllerSession(sessionId))throw Object.assign(new Error('この会話の検索提案はありません。'),{status:404});
    return {...proposal,searchEnabled:enabled!==false};
  }
  async function ownedProduction(sessionId,id,signal){
    if(!uuid.test(id??''))throw Object.assign(new Error('制作IDが不正です。'),{status:400});
    const {production}=await controllerRequest(`/api/productions/${id}`,{signal});
    if(!production||production.sessionId!==controllerSession(sessionId))throw Object.assign(new Error('この会話の制作はありません。'),{status:404});
    return production;
  }
  async function stopTarget(sessionId,signal,sessionOnly=false){
    const controllerId=controllerSession(sessionId);
    const [state,status]=await Promise.all([controllerRequest('/api/production-state',{signal}),controllerRequest('/api/status',{signal})]);
    if(status.activeRunId&&!sessionOnly){
      const p=(state.productions??[]).find(x=>x.sessionId===controllerId&&!x.cancelRequested&&(x.attempts??[]).includes(status.activeRunId));
      if(p)return {kind:'production',id:p.id,runId:status.activeRunId,revision:p.revision};
    }
    if(state.inferenceScope?.sessionId===controllerId&&!state.inferenceScope.cancelRequested)return {kind:'scope',id:state.inferenceScope.id};
    const {proposals}=await controllerRequest('/api/search-proposals',{signal});
    const pending=(proposals??[]).filter(p=>p.sessionId===controllerId&&['awaiting_approval','approved','running'].includes(p.phase)).map(p=>p.id).sort();
    if(pending.length)return {kind:'search-session',id:createHash('sha256').update(JSON.stringify(pending)).digest('hex')};
    return null;
  }
  return async request=>{
    try {
      const url=new URL(request.url);
      if(request.method==='GET'){
        if([...url.searchParams.keys()].some(k=>!['sessionId','proposalId','sessionOnly'].includes(k))||url.searchParams.getAll('sessionId').length!==1||url.searchParams.getAll('proposalId').length>1||url.searchParams.getAll('sessionOnly').length>1)return error(400,'要求が不正です。');
        const sessionId=url.searchParams.get('sessionId');const searchTurn=await verifySession(sessionId,request.signal);
        const id=url.searchParams.get('proposalId');
        if(id){const p=await ownedProposal(sessionId,id,request.signal);return ok({proposal:Object.fromEntries(['id','kind','phase','engine','purpose','queries','urls','proposalHash','items','error'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]])),searchEnabled:p.searchEnabled});}
        const target=await stopTarget(sessionId,request.signal,url.searchParams.get('sessionOnly')==='1');
        if(target&&!searchTurn)return error(409,'停止対象の会話世代を確認できません。');
        return ok({stopTarget:target?{...target,searchTurn}:null});
      }
      if(request.method!=='POST')return error(405,'未対応の操作です。');
      const hostOrigin=typeof dshOrigin==='function'?dshOrigin():dshOrigin;
      if(mutationAllowed ? !mutationAllowed(request) : !hostOrigin||request.headers.get('origin')!==hostOrigin||request.headers.get('x-local-studio-action')!=='1'||!(request.headers.get('content-type')??'').startsWith('application/json')||request.headers.get('sec-fetch-site')==='cross-site')return error(403,'DSH画面からの本人操作を確認できません。');
      const input=await request.json();if(!input||typeof input!=='object'||Array.isArray(input))return error(400,'要求が不正です。');
      const searchTurn=await verifySession(input.sessionId,request.signal);
      if(input.action==='stop'||input.action==='stop-session'){
        const target=await stopTarget(input.sessionId,request.signal,input.action==='stop-session');
        if(!target||!searchTurn||input.searchTurn!==searchTurn||input.kind!==target.kind||input.id!==target.id||input.runId!==target.runId||input.revision!==target.revision)return error(409,'停止対象が変わりました。状態を確認してください。');
        const path=target.kind==='scope'?'/api/core-scope/cancel':target.kind==='search-session'?'/api/search-proposals/cancel-session':`/api/productions/${target.id}/cancel`;
        await controllerRequest(path,{method:'POST',body:target.kind==='scope'?{id:target.id,searchTurn}:target.kind==='search-session'?{sessionId:controllerSession(input.sessionId),searchTurn}:{expectedRunId:target.runId,expectedRevision:target.revision,searchTurn},signal:request.signal});
        return ok({accepted:true});
      }
      if(input.action==='stop-production'){
        const p=await ownedProduction(input.sessionId,input.productionId,request.signal);
        if(!Number.isSafeInteger(input.expectedRevision)||p.revision!==input.expectedRevision||(p.latestRunId??null)!==input.expectedRunId)return error(409,'制作の停止対象が変わりました。状態を確認してください。');
        await controllerRequest(`/api/productions/${p.id}/cancel-owned`,{method:'POST',body:{expectedRunId:input.expectedRunId,expectedRevision:input.expectedRevision},signal:request.signal});
        return ok({accepted:true},202);
      }
      if(input.action==='production-decision'){
        const p=await ownedProduction(input.sessionId,input.productionId,request.signal);
        if(!uuid.test(input.requestId??'')||!['accept','reject'].includes(input.decision)||!Number.isSafeInteger(input.expectedRevision))return error(400,'採否の指定が不正です。');
        const result=await controllerRequest(`/api/productions/${p.id}/user-decision`,{method:'POST',body:{requestId:input.requestId,expectedRevision:input.expectedRevision,sourceRunId:input.sourceRunId,artifactSha256:input.artifactSha256,decision:input.decision,feedback:input.feedback},signal:request.signal});
        const decision=result.decision;
        return ok({accepted:true,decision:{decision:decision.decision,sourceRunId:decision.sourceRunId},planning:input.decision==='reject'?{requestId:decision.planningRequestId}:null},202);
      }
      if(input.action==='plan-production'){
        const p=await ownedProduction(input.sessionId,input.productionId,request.signal),decision=p.latestUserDecision;
        if(!decision||decision.decision!=='reject'||!uuid.test(input.planningRequestId??'')||input.planningRequestId!==decision.planningRequestId||decision.sourceRunId!==p.latestRunId||p.phase!=='revising'||p.cancelRequested)return error(409,'次工程の検討対象が変わりました。状態を確認してください。');
        if(typeof sendPlanning!=='function')return error(503,'検討依頼の送信機能を確認できません。否認記録は保存されています。');
        if(decision.planningDelivery?.state==='accepted')return ok({accepted:true,planningRequestId:decision.planningRequestId,reconciled:true},202);
        const key=input.sessionId+':'+decision.planningRequestId;
        const planning=planningFor(p,decision);
        const receipt=await planningReceipt(input.sessionId,decision.planningRequestId,request.signal,planning);
        if(receipt==='conflict')return error(409,'同じ受付IDに別の会話内容が記録されています。再送せず確認してください。');
        if(receipt===true){
          await controllerRequest(`/api/productions/${p.id}/planning-delivery`,{method:'POST',body:{state:'accepted',planningRequestId:decision.planningRequestId},signal:request.signal});
          return ok({accepted:true,planningRequestId:decision.planningRequestId,reconciled:true},202);
        }
        if(!planningSends.has(key)){
          // The durable claim prevents duplicate admission across reloads;
          // the shared promise coalesces in-process requests while sending.
          const claim=await controllerRequest(`/api/productions/${p.id}/planning-delivery`,{method:'POST',body:{state:'sending',planningRequestId:decision.planningRequestId},signal:request.signal});
          if(!claim.claimed)return error(409,'検討依頼は送信済み、または受付結果が不明です。既存会話を確認し、自動再送はしません。');
          planningSends.set(key,(async()=>{try{await sendPlanning(request,input.sessionId,planning);await controllerRequest(`/api/productions/${p.id}/planning-delivery`,{method:'POST',body:{state:'accepted',planningRequestId:decision.planningRequestId}});}catch(e){if(e.definitelyNotSent)await controllerRequest(`/api/productions/${p.id}/planning-delivery`,{method:'POST',body:{state:'unsent',planningRequestId:decision.planningRequestId}});throw e;}finally{planningSends.delete(key);}})());
        }
        await planningSends.get(key);return ok({accepted:true,planningRequestId:decision.planningRequestId},202);
      }
      if(input.action==='approve-search'){
        const p=await ownedProposal(input.sessionId,input.proposalId,request.signal);
        if(!['awaiting_approval','approved'].includes(p.phase)||input.proposalHash!==p.proposalHash||input.engine!==p.engine)return error(409,'検索提案が変わりました。再確認してください。');
        const field=p.kind==='pages'?'urls':'queries';
        if(!['pages','queries'].includes(p.kind)||!Array.isArray(input[field])||JSON.stringify(input[field])!==JSON.stringify(p[field]))return error(409,'確認した検索語またはURLが一致しません。');
        const action=p.phase==='approved'?'run':'approve';
        await controllerRequest(`/api/search-proposals/${p.id}/${action}`,{method:'POST',body:{proposalHash:p.proposalHash,engine:p.engine,[field]:p[field]},signal:request.signal});
        return ok({accepted:true},202);
      }
      if(input.action==='cancel-search'){
        const p=await ownedProposal(input.sessionId,input.proposalId,request.signal);
        if(!['awaiting_approval','approved','running'].includes(p.phase)||input.proposalHash!==p.proposalHash)return error(409,'検索提案が変わりました。再確認してください。');
        await controllerRequest(`/api/search-proposals/${p.id}/cancel`,{method:'POST',body:{},signal:request.signal});
        return ok({accepted:true},202);
      }
      return error(400,'未対応の操作です。');
    } catch(e){return error(Number.isInteger(e?.status)?e.status:503,e?.status?e.message:'操作の状態を確認できません。自動で再送しません。');}
  };
}
