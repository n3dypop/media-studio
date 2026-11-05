// Single-request graceful shutdown for the already-verified managed
// Controller. The candidate fixed entry calls this module while its wrapper
// owns the launch lock. Deployment and live-runtime execution are unverified.
import {join,isAbsolute,resolve,sep} from 'node:path';
import {safeEvidencePath,stableEvidenceRead} from './cutover-evidence-files.mjs';
import {createEpochVerifier} from '../epoch.mjs';
import {createStrataEpochVerifier} from '../strata-epoch.mjs';
import {strataPythonExecutable} from '../service-paths.mjs';
import {StrataClient} from '../strata.mjs';

export async function assertObservedServicesIdle({verifyComfy,readQueue,readStrataStatus}){
 if(typeof verifyComfy!=='function'||typeof readQueue!=='function'||typeof readStrataStatus!=='function')throw Error('External service observation is unavailable');
 let queue,status;try{await verifyComfy();queue=await readQueue();await verifyComfy();status=await readStrataStatus();}catch{throw Error('External service observation is unavailable');}
 if(!Array.isArray(queue?.queue_running)||!Array.isArray(queue?.queue_pending)||queue.queue_running.length!==0||queue.queue_pending.length!==0||!Number.isSafeInteger(status?.activity?.in_flight)||status.activity.in_flight!==0)throw Error('External services have active, queued, or unconfirmed work');
}

// Read only the managed runtime's own configuration and confirm both service
// process generations around their status calls. No external origin is accepted.
export async function assertManagedServicesIdle({runtimeRoot}){
 const root=await safeEvidencePath(runtimeRoot,true);
 const paths=await Promise.all(['config/environment.json','config/strata.json','data/strata/installation.json'].map(p=>safeEvidencePath(join(root,p),false)));
 const raw=await Promise.all(paths.map(p=>stableEvidenceRead(p,65536)));let environment,config,receipt;try{[environment,config,receipt]=raw.map(b=>JSON.parse(b));}catch{throw Error('External service configuration is unavailable');}
 if(!Number.isInteger(environment.comfyPort)||environment.comfyPort<1||environment.comfyPort>65535||typeof config.tokenFile!=='string'||isAbsolute(config.tokenFile))throw Error('External service configuration is unavailable');
 const tokenPath=resolve(root,config.tokenFile);if(!tokenPath.toLowerCase().startsWith(root.toLowerCase()+sep))throw Error('External service configuration is unavailable');
 const tokenBytes=await stableEvidenceRead(await safeEvidencePath(tokenPath,false),4096);let token=tokenBytes.toString('utf8').trim();tokenBytes.fill(0);if(!/^[a-f0-9]{64}$/.test(token))throw Error('Strata authentication is unavailable');
 const comfyUrl=`http://127.0.0.1:${environment.comfyPort}`,verifyComfy=createEpochVerifier({runtimePath:join(root,'runtime/ComfyUI.json'),expectedExecutable:environment.comfyPythonExecutable,baseUrl:comfyUrl}),verifyStrata=createStrataEpochVerifier({root,expectedExecutable:strataPythonExecutable(environment,receipt),baseUrl:config.baseUrl});
 const strata=new StrataClient({baseUrl:config.baseUrl,model:config.model,token,verifyIdentity:verifyStrata,timeoutMs:10000});token='';
 try{await assertObservedServicesIdle({verifyComfy,readQueue:async()=>{const response=await fetch(comfyUrl+'/queue',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();const text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw Error();return JSON.parse(text);},readStrataStatus:()=>strata.status()});}
 finally{strata.token=null;}
 for(let i=0;i<paths.length;i++)if(!(await stableEvidenceRead(paths[i],65536)).equals(raw[i]))throw Error('External service configuration changed');
}

// A point-in-time preflight, not an admission freeze. Shutdown still checks
// activity after the Host has stopped; a later request can race this snapshot.
export async function assertControllerIdleForCutover({runtimeRoot,controllerFence}){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||typeof controllerFence?.verifyLive!=='function'||!controllerFence.identity||await controllerFence.verifyLive()!==true)throw Error('Managed Controller live identity is unavailable');
 const root=await safeEvidencePath(runtimeRoot,true),tokenPath=await safeEvidencePath(join(root,'data/controller/auth-token'),false),raw=await stableEvidenceRead(tokenPath,4096);let token=raw.toString('utf8').trim();raw.fill(0);if(!/^[a-f0-9]{64}$/.test(token))throw Error('Controller authentication is unavailable');
 let status;try{
  const response=await fetch(controllerFence.identity.url+'/api/host-switch-status',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(response.status!==200)throw Error();const text=await response.text();if(Buffer.byteLength(text)>16384)throw Error();status=JSON.parse(text);
 }catch{throw Error('Controller activity is unavailable');}finally{token='';}
 if(status?.scope!=='controller-only'||status.controllerId!==controllerFence.identity.controllerId||status.processId!==controllerFence.identity.pid||status.state!=='idle'||!Array.isArray(status.busy)||status.busy.length!==0||!Array.isArray(status.unknown)||status.unknown.length!==0)throw Error('Controller has active, unresolved, or unconfirmed work');
 if(await controllerFence.verifyLive()!==true)throw Error('Controller identity changed during activity observation');
}

export async function shutdownOwnedController({runtimeRoot,controllerFence}){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||typeof controllerFence?.verifyLive!=='function'||typeof controllerFence?.holdStopped!=='function'||!controllerFence.identity||await controllerFence.verifyLive()!==true)throw Error('Managed Controller live identity is unavailable');
 const root=await safeEvidencePath(runtimeRoot,true),tokenPath=await safeEvidencePath(join(root,'data/controller/auth-token'),false),raw=await stableEvidenceRead(tokenPath,4096);let token=raw.toString('utf8').trim();raw.fill(0);if(!/^[a-f0-9]{64}$/.test(token))throw Error('Controller authentication is unavailable');
 try{if(await controllerFence.verifyLive()!==true)throw Error();}catch{token='';throw Error('Controller identity changed before shutdown');}
 let response,body;try{
  // This POST is intentionally never retried, even after a timeout or reset.
  response=await fetch(controllerFence.identity.url+'/api/shutdown',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(5000)});
  if(response.status===409)throw Error('Controller has active or unresolved work');
  if(response.status!==200)throw Error('Controller shutdown was declined or its outcome is uncertain');
  body=await response.json();if(body?.stopping!==true)throw Error('Controller shutdown outcome is uncertain');
 }catch(error){if(error?.message==='Controller has active or unresolved work')throw error;throw Error('Controller shutdown was declined or its outcome is uncertain; do not retry automatically');}finally{token='';}
 const deadline=Date.now()+10000;let absent=false;while(Date.now()<deadline){try{process.kill(controllerFence.identity.pid,0);}catch(error){if(error?.code==='ESRCH'){absent=true;break;}throw Error('Controller exit could not be observed');}await new Promise(resolve=>setTimeout(resolve,100));}
 if(!absent)throw Error('Controller exit is unconfirmed; do not retry automatically');return controllerFence.holdStopped();
}
