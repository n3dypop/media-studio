// Read-only by default. A specific observed run can be reconciled only after an
// explicit operator command naming the snapshot fingerprint. No POST is retried.
import {createHash} from 'node:crypto';
import {mkdir,open,readFile,lstat} from 'node:fs/promises';
import {dirname,join,resolve,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {probeWindowsEpoch,validateEpochEvidence} from '../../apps/controller/epoch.mjs';
import {controllerNodeExecutable} from '../../apps/controller/service-paths.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
if(process.env.MEDIA_STUDIO_HOME&&!isAbsolute(process.env.MEDIA_STUDIO_HOME))throw Error('MEDIA_STUDIO_HOME must be absolute');
const root=resolve(process.env.MEDIA_STUDIO_HOME||resolve(dirname(fileURLToPath(import.meta.url)),'../..'));
const fail=message=>{throw new Error(message);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readPlan(request,runId){
  if(!uuid.test(runId??''))fail('有効なrun IDを指定してください。');
  const [health,status,body]=await Promise.all([request('/health'),request('/api/status'),request(`/api/runs/${runId}`)]);
  const run=body?.run;
  if(health?.service!=='local-image-controller'||health.ready!==true||!health.controllerId||status?.controllerId!==health.controllerId||!run||run.id!==runId||run.controllerId!==health.controllerId)fail('Controllerまたはrunの所有情報を確認できません。');
  if(!['needs_attention','recovery_required'].includes(run.phase)||status.activeRunId!==runId)fail('同じControllerで確認待ちのrunだけを照合できます。');
  if(typeof run.updatedAt!=='string'||!Number.isFinite(Date.parse(run.updatedAt))||typeof run.cancelRequested!=='boolean')fail('runの状態を確認できません。');
  const identity={controllerId:run.controllerId,id:run.id,phase:run.phase,updatedAt:run.updatedAt,promptId:run.promptId??null,cancelRequested:run.cancelRequested,accepted:run.accepted??null,serverEpoch:run.serverEpoch??null,specHash:run.specHash??null,productionId:run.productionId??null};
  return {runId,controllerId:run.controllerId,phase:run.phase,updatedAt:run.updatedAt,promptSubmitted:!!run.promptId,cancelRequested:run.cancelRequested,productionId:run.productionId??null,snapshot:digest(identity)};
}

export async function reconcileOnce({request,runId,snapshot,claim}){
  if(!sha.test(snapshot??''))fail('確認したsnapshotを指定してください。');
  const plan=await readPlan(request,runId);
  if(plan.snapshot!==snapshot)fail('runの状態が変わりました。読み取りをやり直してください。');
  const receipt=await claim(plan); // durable exclusive claim before the first byte is sent
  try {
    const result=await request(`/api/runs/${runId}/reconcile`,{method:'POST',body:{}});
    if(result?.run?.id!==runId)throw new Error('Unexpected response');
    await receipt.finish('accepted');
    return {runId,snapshot,accepted:true,message:'照合の受付を確認しました。実行結果はrunを再読取して確認してください。'};
  } catch {
    await receipt.finish('unknown').catch(()=>{});
    fail('照合の受付結果を確認できません。同じ状態で再送せず、runとreceiptを確認してください。');
  }
}

export async function claimReceipt(workspace,plan){
  if(!uuid.test(plan.runId??'')||!sha.test(plan.snapshot??''))fail('receipt identity is invalid');
  const base=resolve(workspace),directory=join(base,'data','controller','maintenance-reconcile');
  if(!directory.startsWith(base+sep))fail('receipt directory escaped workspace');
  for(const component of [base,join(base,'data'),join(base,'data','controller')]){
    const entry=await lstat(component);if(!entry.isDirectory()||entry.isSymbolicLink())fail('receipt parent is not a safe directory');
  }
  await mkdir(directory,{recursive:true});const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())fail('receipt directory is not a safe directory');
  const path=join(directory,`${plan.runId}-${plan.snapshot}.json`);
  let handle;
  try{handle=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('同じrun・状態で照合を既に試みています。自動再送せずreceiptとrunを確認してください。');throw e;}
  const record={schema:1,runId:plan.runId,snapshot:plan.snapshot,controllerId:plan.controllerId,at:new Date().toISOString(),status:'sending'};
  try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}
  return {async finish(status){
    // Preserve the exclusive receipt if this update fails. The filename still
    // prevents a second send against the same snapshot.
    const out=await open(path,'r+');try{await out.truncate(0);await out.writeFile(JSON.stringify({...record,status,updatedAt:new Date().toISOString()})+'\n');await out.sync();}finally{await out.close();}
  }};
}

export function parseArgs(args){
  let runId,snapshot,execute=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--run'&&runId===undefined)runId=args[++i];
    else if(args[i]==='--snapshot'&&snapshot===undefined)snapshot=args[++i];
    else if(args[i]==='--execute'&&!execute)execute=true;
    else fail('Usage: node reconcile-run.mjs --run <run-id> [--execute --snapshot <observed-hash>]');
  }
  if(!uuid.test(runId??'')||(execute?!sha.test(snapshot??''):snapshot!==undefined))fail('有効なrun IDと、実行時は確認したsnapshotが必要です。');
  return {runId,snapshot,execute};
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  const config=JSON.parse(await readFile(join(root,'config/controller.json'),'utf8'));
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)fail('Controller設定が不正です。');
  const token=(await readFile(join(root,'data/controller/auth-token'),'utf8')).trim();
  if(!sha.test(token))fail('Controller認証を確認できません。');
  const environment=JSON.parse(await readFile(join(root,'config/environment.json'),'utf8'));
  const expectedExecutable=controllerNodeExecutable(root,environment).toLowerCase();
  if(process.platform!=='win32')fail('管理対象Controllerの配置を確認できません。');
  const verify=async()=>{
    const record=JSON.parse(await readFile(join(root,'runtime/Controller.json'),'utf8'));
    if(record.service!=='Controller'||record.url!==`http://127.0.0.1:${config.port}`||resolve(record.executable).toLowerCase()!==expectedExecutable||!Number.isSafeInteger(record.processId)||typeof record.startTimeUtcTicks!=='string'||!record.controllerId)fail('Controllerの管理記録を確認できません。');
    const identity={pid:record.processId,startTimeUtcTicks:record.startTimeUtcTicks,executable:expectedExecutable,url:record.url,port:config.port};
    const actual=validateEpochEvidence(identity,await probeWindowsEpoch({pid:identity.pid,port:identity.port}));
    if(actual.listenerPid!==actual.pid)fail('Controllerの待受所有者を確認できません。');
    return record;
  };
  const request=async(path,{method='GET',body}={})=>{
    const record=await verify();
    let response;
    try{response=await fetch(`http://127.0.0.1:${config.port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});}
    catch{fail('Controllerの応答を確認できません。');}
    if(!response.ok)fail(`Controllerが操作を受け付けませんでした (HTTP ${response.status})。`);
    let result;try{result=await response.json();}catch{fail('Controller応答を読み取れません。');}
    const after=await verify();
    if(record.processId!==after.processId||record.startTimeUtcTicks!==after.startTimeUtcTicks||record.controllerId!==after.controllerId)fail('Controllerの実行世代が変わりました。');
    if(path==='/health'&&(result.pid!==record.processId||result.controllerId!==record.controllerId))fail('Controller応答の識別情報が一致しません。');
    return result;
  };
  const result=args.execute?await reconcileOnce({request,runId:args.runId,snapshot:args.snapshot,claim:plan=>claimReceipt(root,plan)}):await readPlan(request,args.runId);
  console.log(JSON.stringify({mode:args.execute?'execute':'plan',...result},null,2));
}
if(import.meta.main)main().catch(e=>{console.error(e.message);process.exitCode=1;});
