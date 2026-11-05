// A single passive ComfyUI socket for the dashboard. New managed prompts carry
// a prompt-unique client_id; this observer never submits or resubmits work.
import {isDeepStrictEqual} from 'node:util';
import {MONITOR_INSTANCE_ID} from './monitor-identity.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function promptFor(run){
  if(!run||!['generating','enhancing'].includes(run.phase))return null;
  const id=run.promptId??run.mossPe?.promptId??run.qwenPe?.promptId;
  return UUID.test(id??'')?id:null;
}
function subscriptionFor(run,instanceId){
  const promptId=promptFor(run),stage=run?.mossPe??run?.qwenPe;
  const record=run?.phase==='enhancing'?stage:run;
  if(!promptId||record?.progressClientId!==promptId||record?.progressInstanceId!==instanceId)return null;
  return {promptId,clientId:promptId};
}
const validNumber=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000000000;
export function parseProgressMessage(raw,promptId){
  if(typeof raw!=='string'||raw.length>65536||!UUID.test(promptId??''))return null;
  let x;try{x=JSON.parse(raw);}catch{return null;}
  const data=x?.data;
  if(data?.prompt_id!==promptId)return null;
  if(x.type==='executing')return {kind:'node',nodes:[]};
  if(x.type!=='progress_state'||!data.nodes||typeof data.nodes!=='object'||Array.isArray(data.nodes))return null;
  const nodes=[];
  for(const [id,node] of Object.entries(data.nodes)){
    if(nodes.length>=16)return null;
    if(!node||node.state!=='running')continue;
    if(typeof id!=='string'||id.length>160||/[\x00-\x1f]/.test(id)||node.prompt_id!==promptId||!validNumber(node.value)||!validNumber(node.max)||node.max<=0||node.value>node.max)return null;
    nodes.push({nodeId:id,value:node.value,max:node.max});
  }
  return {kind:'nodes',nodes};
}

export function createComfyProgressMonitor({store,gate,verifyEpoch,baseUrl,WebSocketImpl=globalThis.WebSocket,clock=()=>Date.now(),lifecycleMs=30000,verifyTimeoutMs=10000,instanceId=MONITOR_INSTANCE_ID}={}){
  if(!store||!gate||typeof verifyEpoch!=='function'||typeof WebSocketImpl!=='function'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)||!UUID.test(store.controllerId??'')||!UUID.test(instanceId??'')||!Number.isSafeInteger(lifecycleMs)||lifecycleMs<1||!Number.isSafeInteger(verifyTimeoutMs)||verifyTimeoutMs<1)throw new TypeError('Invalid progress monitor dependencies');
  let socket=null,current=null,last=null,handshake=false,lifecycleTimer=null,revision=0,disposed=false;
  // ComfyUI removes a sid unconditionally in the old socket's finally block.
  // Never reconnect with a previously used sid: waiting for the client-side
  // close event does not prove that server-side cleanup has completed.
  const usedClients=new Set(),MAX_CLIENTS=4096;
  const close=()=>{revision++;if(lifecycleTimer)clearTimeout(lifecycleTimer);lifecycleTimer=null;const old=socket;socket=null;current=null;last=null;handshake=false;try{old?.close();}catch{}};
  const dispose=()=>{disposed=true;close();};
  const verifyBounded=()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Epoch verification timed out')),verifyTimeoutMs);timer.unref?.();
    Promise.resolve().then(verifyEpoch).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
  // Keep one socket while its owned run is active, even if the UI closes.
  // This read-only periodic check ends the subscription without reusing its sid.
  const checkLifecycle=async ws=>{
    if(socket!==ws)return;
    const observed=current;
    const valid=()=>{const run=store.active(),lease=gate.status();return !!run&&run.id===observed.runId&&run.controllerId===store.controllerId&&subscriptionFor(run,instanceId)?.clientId===observed.clientId&&isDeepStrictEqual(run.serverEpoch,observed.epoch)&&lease.generationRunId===run.id&&['generator','enhancer'].includes(lease.owner);};
    try{
      if(!observed||!valid())throw Error('Subscription no longer active');
      const epoch=await verifyBounded();
      if(socket!==ws)return;
      if(!isDeepStrictEqual(epoch,observed.epoch)||!valid())throw Error('Subscription epoch changed');
      lifecycleTimer=setTimeout(()=>{lifecycleTimer=null;void checkLifecycle(ws);},lifecycleMs);lifecycleTimer.unref?.();
    }catch{if(socket===ws)close();}
  };
  const connect=(run,promptId,clientId,epoch)=>{
    close();if(usedClients.has(clientId)||usedClients.size>=MAX_CLIENTS)return false;
    usedClients.add(clientId);
    const url=new URL('/ws',baseUrl);url.protocol='ws:';url.searchParams.set('clientId',clientId);
    const ws=new WebSocketImpl(url.href);socket=ws;current={runId:run.id,promptId,clientId,epoch};handshake=false;last=null;
    ws.addEventListener('message',event=>{
      if(socket!==ws||typeof event.data!=='string'||event.data.length>65536)return;
      if(!handshake){try{const x=JSON.parse(event.data);if(x.type==='status'&&x.data?.sid===clientId)handshake=true;}catch{}return;}
      const active=store.active();if(!active||active.id!==current?.runId||promptFor(active)!==current.promptId||active.controllerId!==store.controllerId)return;
      const item=parseProgressMessage(event.data,current.promptId);if(item)last={...item,observedAt:new Date(clock()).toISOString(),at:clock()};
    });
    ws.addEventListener('close',()=>{if(socket===ws)close();});
    ws.addEventListener('error',()=>{if(socket===ws)close();});
    lifecycleTimer=setTimeout(()=>{lifecycleTimer=null;void checkLifecycle(ws);},lifecycleMs);lifecycleTimer.unref?.();return true;
  };
  return {
    close,dispose,
    async snapshot(sessionId){
      if(disposed)return null;
      const active=store.active();if(!active||active.sessionId!==sessionId)return null;
      const subscription=subscriptionFor(active,instanceId),promptId=subscription?.promptId,clientId=subscription?.clientId,lease=gate.status();
      if(!promptId||active.controllerId!==store.controllerId||!active.serverEpoch||lease.generationRunId!==active.id||!['generator','enhancer'].includes(lease.owner)){if(current?.runId===active.id)close();return null;}
      const observedRevision=revision;
      let epoch;try{epoch=await verifyBounded();}catch{if(!disposed&&revision===observedRevision&&current?.runId===active.id&&current.clientId===clientId)close();return null;}
      if(disposed||revision!==observedRevision)return null;
      const fresh=store.get(active.id),freshLease=gate.status();
      if(!isDeepStrictEqual(epoch,active.serverEpoch)||!fresh||fresh.id!==active.id||store.active()?.id!==active.id||fresh.sessionId!==sessionId||!isDeepStrictEqual(epoch,fresh.serverEpoch)||subscriptionFor(fresh,instanceId)?.clientId!==clientId||freshLease.generationRunId!==active.id||!['generator','enhancer'].includes(freshLease.owner)){if(current?.runId===active.id&&current.clientId===clientId)close();return null;}
      if(!current||current.runId!==active.id||current.promptId!==promptId||!isDeepStrictEqual(current.epoch,epoch)){try{if(!connect(active,promptId,clientId,epoch))return null;}catch{close();return null;}}
      if(!handshake||!last||clock()-last.at>30000)return null;
      return {runId:active.id,observedAt:last.observedAt,kind:last.kind,nodes:structuredClone(last.nodes),source:'comfyui-websocket-current-node'};
    }
  };
}
