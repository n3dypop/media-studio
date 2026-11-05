import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ApiError, normalizeRequest, terminalPhases } from './store.mjs';
import { productionRoute, inferenceRoute } from './production-http.mjs';
import { validateSession } from './productions.mjs';
import { searchRoute } from './search-http.mjs';
import {assetRoute} from './assets.mjs';
import {mossPeRoute} from './moss-pe-http.mjs';
import {monitorSnapshot} from './monitor-snapshot.mjs';
import {controllerSwitchStatus} from './host-switch-status.mjs';

const equal = (a,b) => typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req, limit = 32768) {
  if (!(req.headers['content-type']??'').startsWith('application/json')) throw new ApiError(415,'JSON形式で送信してください。');
  const chunks=[]; let size=0;
  for await(const chunk of req) { size+=chunk.length; if(size>limit) throw new ApiError(413,'入力が大きすぎます。'); chunks.push(chunk); }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'JSONを読み取れません。');}
}
export function createControllerServer({store,engine,token,dshToken,productions,workflows,gate,strata,search,assets,mossPe,mossPeEnabled=false,qwenPe,qwenPeEnabled=false,monitorTelemetry=null,monitorProgress=null,outputRoot,port,comfyUrl,profile,onShutdown=()=>{},experimentalHostIsolation=false}) {
  // Host isolation is not complete. Do not silently run the legacy API if an
  // operator attempts to enable it before storage and recovery are ready.
  if(experimentalHostIsolation!==false)throw new Error('Host isolation is incomplete; strict Controller startup is disabled.');
  const inferenceBySession=new Map();
  const searches=new Set();
  function backgroundSearch(id,sessionId){
    const task=search.run(id,{sessionId});searches.add(task);
    task.catch(error=>console.error('search failed:',error.code??'SEARCH_FAILURE')).finally(()=>searches.delete(task));
  }
  let inferenceScope=null;
  let closing=false,mutations=0,resourceOperation=false;
  function registerInference(session,controller) {
    if(!session) return ()=>{};
    if(!inferenceBySession.has(session)) inferenceBySession.set(session,new Set());
    const set=inferenceBySession.get(session);set.add(controller);
    return ()=>{set.delete(controller);if(!set.size)inferenceBySession.delete(session);};
  }
  function abortSession(session,searchTurn) {
    let failure;
    try {if(search?.cancelSession)search.cancelSession(session,searchTurn);
      else for(const proposal of search?.list({sessionId:session})??[])search.cancel(proposal.id);
    } catch(error) {failure=error;}
    if(inferenceScope?.sessionId===session)inferenceScope.cancelRequested=true;
    for(const controller of inferenceBySession.get(session)??[])controller.abort(new Error('Production cancelled'));
    if(failure)throw failure;
  }
  const productionState=()=> (productions?.listAll()??[]).map(p=>p.cancelRequested&&(inferenceBySession.get(p.sessionId)?.size||inferenceScope?.sessionId===p.sessionId||search?.list({productionId:p.id}).some(r=>search.active.has(r.id)))?{...p,phase:'cancelling'}:p);
  const origin=`http://127.0.0.1:${port}`;
  function json(res,status,value,headers={}) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers}); res.end(JSON.stringify(value)); }
  function authenticated(req) {
    const auth=req.headers.authorization;
    if(auth?.startsWith('Bearer ')&&equal(auth.slice(7),token)) return 'admin';
    if(dshToken&&auth?.startsWith('Bearer ')&&equal(auth.slice(7),dshToken)) return 'dsh';
    return false;
  }
  const server=http.createServer(async(req,res)=>{
    const mutation=req.method==='POST'&&req.url!=='/api/shutdown';
    if(mutation)mutations++;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if(req.headers.host!==`127.0.0.1:${port}`) throw new ApiError(403,'Hostが一致しません。');
      if(req.headers.origin&&req.headers.origin!==origin) throw new ApiError(403,'別のサイトからの操作は受け付けません。');
      if(req.headers['sec-fetch-site']==='cross-site') throw new ApiError(403,'別のサイトからの操作は受け付けません。');
      const url=new URL(req.url,origin), path=url.pathname;
      if(req.method==='GET'&&path==='/health') return json(res,200,{service:'local-image-controller',ready:!closing,pid:process.pid,controllerId:store.controllerId,activeRunId:store.active()?.id??null});
      if(closing)throw new ApiError(503,'コントローラを終了中です。新しい処理は受け付けません。');
      const role=authenticated(req);
      if(!role) throw new ApiError(401,'認証が必要です。');
      if(req.method==='GET'&&path==='/api/host-switch-status') {
        if(role!=='admin')throw new ApiError(403,'切替状態の照合は本人画面だけが使用できます。');
        return json(res,200,controllerSwitchStatus({controllerId:store?.controllerId,closing,mutations,resourceOperation,store,engine,gate,inferenceScope,inferenceBySession,searches,search,mossPe,qwenPe,isIdle:()=>server.isIdle()}));
      }
      if(req.method==='POST'&&resourceOperation)throw new ApiError(409,'資源を解放中です。完了後に操作してください。');
      if(path==='/api/resources/unload'&&req.method==='POST'){
        if(role!=='admin')throw new ApiError(403,'資源の明示的解放は本人画面だけが使用できます。');
        const input=await body(req);
        if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='service')||!['Strata','ComfyUI'].includes(input.service))throw new ApiError(400,'資源解放の対象が不正です。');
        if(!gate||typeof gate.unloadIdle!=='function')throw new ApiError(503,'資源管理が有効ではありません。');
        if(mutations!==1||store.active()||engine.work.size||mossPe?.work.size||qwenPe?.work.size||inferenceScope||inferenceBySession.size||searches.size||search?.active.size)throw new ApiError(409,'生成・推論または他の操作が実行中です。');
        resourceOperation=true;
        try{
          const assertGeneratorIdle=async()=>{
            await engine.verifyEpoch();
            const queue=await engine.adapter.request('/queue');
            if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)throw new ApiError(409,'ComfyUIに実行中または待機中のジョブがあります。');
            await engine.verifyEpoch();
          };
          const result=await gate.unloadIdle(input.service,{assertGeneratorIdle,releaseGenerator:()=>engine.adapter.release({assertEpoch:()=>engine.verifyEpoch(),minFreeBytes:0})});
          return json(res,200,result);
        }catch(error){return json(res,error.status??503,{error:error.message,uncertain:error.uncertain===true});}
        finally{resourceOperation=false;}
      }
      if(path==='/api/model-profiles'&&req.method==='GET'){
        if(!workflows)throw new ApiError(503,'画像生成モデルの確認準備が完了していません。');
        const catalog=await workflows.catalog();
        return json(res,200,{profiles:catalog.modelProfiles,defaultProfile:catalog.modelProfile});
      }
      if(role==='dsh'&&path.startsWith('/api/')) validateSession(req.headers['x-dsh-session']);
      if(path==='/api/studio-monitor'&&req.method==='GET'){
        const sessionId=validateSession(req.headers['x-dsh-session']);
        if(!productions)throw new ApiError(503,'制作状況を確認できません。');
        return json(res,200,await monitorSnapshot({sessionId,store,productions,gate,inferenceScope,telemetry:monitorTelemetry,progress:monitorProgress}));
      }
      if(await assetRoute({req,res,path,assets,body,json}))return;
      if(await mossPeRoute({req,res,path,url,body,json,mossPe,enabled:mossPeEnabled}))return;
      if(await mossPeRoute({req,res,path,url,body,json,mossPe:qwenPe,enabled:qwenPeEnabled,basePath:'/api/qwen-pe'}))return;
      if(path==='/api/core-scope/start'&&req.method==='POST') {
        const sessionId=validateSession(req.headers['x-dsh-session']);
        const input=await body(req);
        if(typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)) throw new ApiError(400,'推論要求IDが不正です。');
        if(inferenceScope) {
          if(inferenceScope.requestId===input.requestId&&inferenceScope.sessionId===sessionId) return json(res,200,{scope:inferenceScope});
          throw new ApiError(409,'前の中核推論が終了していません。');
        }
        inferenceScope={id:randomUUID(),sessionId,requestId:input.requestId,createdAt:new Date().toISOString()};
        return json(res,201,{scope:inferenceScope});
      }
      if(path==='/api/core-scope/end'&&req.method==='POST') {
        const input=await body(req);
        if(!inferenceScope) return json(res,200,{ended:true});
        if(input.id!==inferenceScope.id||req.headers['x-dsh-session']!==inferenceScope.sessionId) throw new ApiError(409,'中核推論の会話が一致しません。');
        if(inferenceBySession.get(inferenceScope.sessionId)?.size) throw new ApiError(409,'中核推論の通信が終了していません。');
        inferenceScope=null;return json(res,200,{ended:true});
      }
      if(path==='/api/core-scope/cancel'&&req.method==='POST') {
        if(role!=='admin')throw new ApiError(403,'推論全体の停止は本人画面だけが使用できます。');
        const input=await body(req);
        if(!inferenceScope||input.id!==inferenceScope.id)throw new ApiError(409,'停止対象の推論は既に変わっています。');
        search?.validateStopTurn?.(inferenceScope.sessionId,input.searchTurn);
        inferenceScope.cancelRequested=true;
        // The active model stream does not identify a production.  Cancelling
        // every unfinished production in this conversation would also cancel
        // unrelated historical or needs-user work. Owned generation is stopped
        // separately through its revision- and run-bound production endpoint.
        abortSession(inferenceScope.sessionId,input.searchTurn);
        return json(res,202,{scope:inferenceScope,stopping:true});
      }
      if(path==='/v1/chat/completions'&&role==='dsh'&&!inferenceScope) throw new ApiError(409,'DSH中核ゲートの会話登録が必要です。');
      if(path==='/v1/chat/completions'&&role==='dsh'&&inferenceScope.cancelRequested)throw new ApiError(409,'この中核推論は停止を受け付けています。');
      if(await inferenceRoute({req,res,path,role,body,json,gate,strata,registerInference:(session,controller)=>registerInference(role==='dsh'?inferenceScope?.sessionId:session,controller)})) return;
      if(path==='/api/production-state'&&req.method==='GET') {
        if(role!=='admin')throw new ApiError(403,'制作全体の一覧は本人画面だけが使用できます。');
        return json(res,200,{productions:productionState(),inferenceSession:inferenceScope?.sessionId??null,inferenceScope});
      }
      if(await productionRoute({req,res,path,url,role,store,engine,productions,workflows,mossPe,qwenPe,body,json,abortSession,cancelProductionPe:(production,session)=>{mossPe?.cancelProduction(production,session);qwenPe?.cancelProduction(production,session);},validateStopTurn:(session,turn)=>search?.validateStopTurn?.(session,turn)})) return;
      if(await searchRoute({req,res,path,url,role,productions,search,body,json,backgroundSearch}))return;
      if(req.method==='GET'&&path==='/api/status') return json(res,200,{profile,activeRunId:store.active()?.id??null,comfyUrl,scope:productions?'dsh-strata-production':'standalone-photo',controllerId:store.controllerId,resources:gate?.status()??null,search:{enabled:search?.enabled!==false&&Boolean(search)}});
      if(path==='/api/runs'&&req.method==='GET') return json(res,200,{runs:store.list().filter(run=>role==='admin'||run.sessionId===req.headers['x-dsh-session'])});
      if(path==='/api/runs'&&req.method==='POST') {
        if(role!=='admin') throw new ApiError(403,'DSHからの生成は制作APIを使用してください。');
        const input=await body(req);input.modelProfile??=workflows?.profileId??profile;
        const result=store.create(normalizeRequest(input));
        if(result.created) setImmediate(()=>engine.launch(result.run.id));
        return json(res,result.created?202:200,{run:result.run});
      }
      const match=path.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|events|artifacts|reconcile|recover-server)(?:\/([a-zA-Z0-9_.-]+))?)?$/);
      if(match) {
        const [,id,action,name]=match;
        const run=store.get(id);
        if(!run) throw new ApiError(404,'生成記録がありません。');
        if(role==='dsh'&&(!run.sessionId||run.sessionId!==req.headers['x-dsh-session'])) throw new ApiError(404,'この会話の生成記録がありません。');
        if(!action&&req.method==='GET') return json(res,200,{run:run.productionId?{...run,productionRevision:productions.get(run.productionId,run.sessionId).revision}:run});
        if(action==='events'&&req.method==='GET') {
          const after=Number(url.searchParams.get('after')??0);
          if(!Number.isSafeInteger(after)||after<0) throw new ApiError(400,'afterが不正です。');
          const events=store.events(id,after); return json(res,200,{events,latest:events.at(-1)?.seq??after});
        }
        if(action==='cancel'&&req.method==='POST') {
          if(role==='dsh') throw new ApiError(403,'制作全体の停止APIを使用してください。');
          const input=await body(req);let stopError;
          if(run.productionId) {search?.validateStopTurn?.(run.sessionId,input.searchTurn);productions.cancel(run.productionId,run.sessionId);try{abortSession(run.sessionId,input.searchTurn);}catch(error){stopError=error;}}
          const next=store.cancel(id);
          if(!terminalPhases.has(next.phase)&&!engine.work.has(id)) setImmediate(()=>engine.launch(id,true));
          if(stopError)throw stopError;
          return json(res,202,{run:next});
        }
        if(action==='reconcile'&&req.method==='POST') {
          if(role!=='admin') throw new ApiError(403,'再照合は本人操作が必要です。');
          await body(req);
          if(terminalPhases.has(run.phase)) return json(res,200,{run});
          if(!engine.work.has(id)) setImmediate(()=>engine.launch(id,true));
          return json(res,202,{run});
        }
        if(action==='recover-server'&&req.method==='POST') {
          if(role!=='admin')throw new ApiError(403,'サーバー再起動後の復旧は本人操作が必要です。');
          const input=await body(req);
          if(run.productionId&&(!productions||!productions.get(run.productionId,run.sessionId).cancelRequested))throw new ApiError(409,'制作全体の停止要求を先に確定してください。');
          const recovery=engine.recoverServer(id,input);
          recovery.catch(error=>console.error('Server recovery failed:',String(error?.message??error).slice(0,200)));
          return json(res,202,{run:store.get(id)});
        }
        if(action==='artifacts'&&name&&req.method==='GET') {
          const artifact=run.artifacts.find(item=>item.name===name);
          if(!artifact) throw new ApiError(404,'画像がありません。');
          const outputs=await realpath(resolve(outputRoot));
          const root=await realpath(resolve(outputRoot,id));
          if(!root.startsWith(outputs+sep)) throw new ApiError(403,'出力先が不正です。');
          const file=await realpath(join(root,name));
          if(!file.startsWith(root+sep)) throw new ApiError(403,'出力先が不正です。');
          if((await stat(file)).size>64*1024*1024) throw new ApiError(413,'画像が大きすぎます。');
          if(!['image/png','video/mp4'].includes(artifact.mime??'image/png'))throw new ApiError(415,'未対応の成果物形式です。');
          res.writeHead(200,{'Content-Type':artifact.mime??'image/png','Content-Disposition':`inline; filename="${name}"`});return res.end(await readFile(file));
        }
      }
      if(path==='/api/shutdown'&&req.method==='POST') {
        if(role!=='admin') throw new ApiError(403,'この認証ではサービスを終了できません。');
        await body(req);
        if(!server.beginShutdown()) throw new ApiError(409,'生成・推論または確認待ちの記録があります。停止・照合を完了してから終了してください。');
        json(res,200,{stopping:true});setImmediate(onShutdown);return;
      }
      throw new ApiError(404,'見つかりません。');
    } catch(error) {
      if(!res.headersSent) json(res,error.status??500,{error:error.status?error.message:'内部エラーが発生しました。ローカルログを確認してください。'});
      else res.destroy();
      if(!error.status) console.error('request failed:',error.message);
    } finally {if(mutation)mutations--;}
  });
  server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=5000;
  server.isIdle=()=>!mutations&&!store.active()&&!engine.work.size&&!mossPe?.work.size&&!qwenPe?.work.size&&!gate?.status().activeCore&&!inferenceScope&&!searches.size&&!search?.active.size;
  server.beginShutdown=()=>{if(!server.isIdle())return false;closing=true;return true;};
  return server;
}
