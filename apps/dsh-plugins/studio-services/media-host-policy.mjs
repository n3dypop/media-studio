import {readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createSystemAdapter} from './service-manager.mjs';
import {readJson} from '../shared/runtime-files.mjs';

const fault=(message,status=409)=>Object.assign(Error(message),{status});
const sessionId=agent=>agent.session?.id??agent.id;
export const MEDIA_GENERATION_TOOLS=new Set(['local_prepared_render','local_production_render','local_moss_pe_start','local_qwen_pe_start']);
const generationBoundary=()=>fault('生成またはプロンプト拡張の実行中は、その処理を保護するためDSHを強制再起動できません。完了を待つか、その制作を明示的に停止してから再確認してください。');

// Optional integration for the generic DSH host-control package. A Media Studio
// profile requires this module explicitly; missing/invalid policy fails loading.
export async function createHostRestartPolicy({root,ctx,settings,fetcher=fetch,systemAdapter}={}){
  root=resolve(root);settings??=JSON.parse(await readFile(join(root,'config/environment.json'),'utf8'));
  const system=systemAdapter??await createSystemAdapter({root});
  async function requestJson(address,options={}){const target=new URL(address);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw Error('Unexpected restart service address');const response=await fetcher(address,{...options,signal:AbortSignal.timeout(8000),redirect:'error'});if(!response.ok)throw fault('再起動前のサービス状態を照合できません。');return response.json();}
  async function controllerRequest(path,body){const configuration=await readJson(root,join(root,'config/controller.json')),token=(await readFile(join(root,'data/controller/auth-token'),'utf8')).trim();if(!Number.isInteger(configuration?.port)||configuration.port<1024||configuration.port>65535||!/^[a-f0-9]{64}$/.test(token))throw Error('Controller restart credentials unavailable');return requestJson(`http://127.0.0.1:${configuration.port}`+path,{headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});}
  async function forceResources(services,{allowCore=false,coreOwners=new Set(ctx.agents.list().filter(a=>a.status==='running').map(sessionId))}={}){
    if(services.services.some(s=>!['running','stopped'].includes(s.state)))throw fault('サービスの所有状態が不明です。');let scope=null;
    if(services.services.find(s=>s.id==='Controller')?.state==='running'){
      const [status,state,runs]=await Promise.all([controllerRequest('/api/status'),controllerRequest('/api/production-state'),controllerRequest('/api/runs')]),gate=status.resources;scope=state.inferenceScope;
      if(!gate||!Array.isArray(state.productions)||!Array.isArray(runs.runs)||runs.runs.some(run=>!['completed','failed','cancelled'].includes(run.phase))||status.activeRunId||gate.generationRunId||gate.blocked!==false||!['none','core'].includes(gate.owner))throw generationBoundary();
      if(!Number.isSafeInteger(gate.activeCore)||gate.activeCore<0)throw fault('中核推論の状態を確認できません。');
      if(scope&&(!allowCore||!coreOwners.has(scope.sessionId))||gate.activeCore>0&&(!allowCore||!scope))throw fault('DSHが所有する推論以外の処理があります。再起動を保留します。');
    }else{
      const path=join(root,'data/controller/controller.db');try{const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile())throw fault('Controllerの記録を確認できません。');const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path,{readOnly:true});try{const active=db.prepare("SELECT count(*) AS n FROM runs WHERE phase NOT IN ('completed','failed','cancelled')").get().n,row=db.prepare("SELECT value FROM meta WHERE key='resourceGate'").get(),gate=row?JSON.parse(row.value):null;if(active||gate&&(gate.activeCore!==0||gate.blocked||gate.generationRunId||!['none','core'].includes(gate.owner)))throw generationBoundary();}finally{db.close();}}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(services.services.find(s=>s.id==='ComfyUI')?.state==='running'){const queue=await requestJson(`http://127.0.0.1:${settings.comfyPort}/queue`);if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)throw generationBoundary();}
    if(services.services.find(s=>s.id==='Strata')?.state==='running'){const configuration=await readJson(root,join(root,'config/strata.json')),token=(await readFile(join(root,'data/strata/api-token'),'utf8')).trim(),status=await requestJson(configuration.baseUrl+'/v1/status',{headers:{Authorization:'Bearer '+token}});if(!Number.isSafeInteger(status.activity?.in_flight)||status.activity.in_flight<0||status.activity.in_flight>0&&(!allowCore||!scope))throw fault('所有者を確認できないStrata推論があります。');}
    return scope;
  }
  async function verifyExternal(context,{mode='normal',quiescent=false}={}){
    const services=await system.snapshot();
    if(mode==='force')await forceResources(services,{allowCore:!quiescent});
    else await system.assertIdle(services,context.cookie);
    const journal=await readJson(root,join(root,'data/service-manager/operations.json'));
    if(journal?.operations?.some(operation=>['unknown','running'].includes(operation.state)))throw fault('サービス操作が実行中または結果不明です。受付記録を確認してください。');
  }
  async function cancelOwnedInference({agents,observations}){
    const services=await system.snapshot(),scope=await forceResources(services,{allowCore:true,coreOwners:new Set(agents.map(sessionId))});
    if(!scope)return;
    const observed=observations.get(scope.sessionId),turns=observed?.events.filter(event=>event.type==='turn/start').map(event=>event.data.turn).filter(turn=>Number.isSafeInteger(turn)&&turn>0),searchTurn=turns?.length?Math.max(...turns):null;
    if(!searchTurn)throw fault('中核推論の会話世代を確認できません。');
    try{await controllerRequest('/api/core-scope/cancel',{id:scope.id,searchTurn});}catch{await forceResources(await system.snapshot());}
  }
  return {protectedTools:new Set(MEDIA_GENERATION_TOOLS),blockedMessage:generationBoundary().message,verifyExternal,cancelOwnedInference};
}
