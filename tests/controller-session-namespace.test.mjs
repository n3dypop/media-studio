import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {controllerSessionId,controllerSessionMode} from '../apps/dsh-plugins/shared/controller-session.mjs';
import {actionsHandler} from '../apps/dsh-plugins/studio-controls/actions.mjs';
import {originalHandler} from '../apps/dsh-plugins/media-results/original.mjs';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';

test('Web IDs are retained and reserved Desktop IDs cannot be used by Web',()=>{
  assert.equal(controllerSessionMode({}),'web');
  assert.equal(controllerSessionId('session-1'),'session-1');
  assert.equal(controllerSessionId('session-1','desktop'),'desktop:session-1');
  assert.equal(controllerSessionId('__auxiliary__','desktop'),'desktop:__auxiliary__');
  assert.throws(()=>controllerSessionId('desktop:session-1'));
  assert.equal(controllerSessionId('x'.repeat(142),'desktop').length,150);
  assert.throws(()=>controllerSessionId('x'.repeat(143),'desktop'));
  assert.throws(()=>controllerSessionId('x'.repeat(153),'desktop'));
  assert.throws(()=>controllerSessionId('a\nb','desktop'));
  assert.throws(()=>controllerSessionMode({controllerSessionNamespace:'other'}));
});

test('Desktop gateway consistently namespaces inference scope and search turn requests',async()=>{
  const hooks=new Map(),sent=[];
  const gateway=await createGateway({on(event,handler){hooks.set(event,handler);return ()=>{};}},{runtimeRoot:process.cwd(),controllerSessionNamespace:'desktop'},{
    loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3000',token:'synthetic-credential'}),
    loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'synthetic'}),
    isManagedAgent:()=>true,createOwnerContext:async()=>({birth:{},owner:{activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}}),pinSearchStopDatabase:()=>({stop(){}}),
    fetch:async(url,options)=>{
      const path=new URL(url).pathname,sessionId=options.headers['X-DSH-Session'],body=JSON.parse(options.body);sent.push({path,sessionId,body});
      const value=path.endsWith('/start')?{scope:{id:'scope',sessionId}}:path.endsWith('/gateway-register')?{sessionId,hostId:body.hostId,registered:true}:path.endsWith('/user-turn')?{sessionId,turn:body.turn}:{};
      return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
    }
  });
  const agent={options:{provider:'local-strata',model:'strata-core'},session:{id:'session-1',snapshotEvents:()=>[{type:'turn/start',data:{turn:3}}]}};
  await hooks.get('agent/pre-step')({agent,turn:3,step:1,messages:[{source:{kind:'user'}}]},()=>{});
  const iterator=gateway.stream({provider:'local-strata',model:'strata-core',sessionId:'session-1',messages:[]},()=> (async function*(){yield 'ok';})());
  assert.deepEqual(await iterator.next(),{value:'ok',done:false});await iterator.return();
  assert.deepEqual(sent.map(row=>row.path),['/api/search-proposals/gateway-register','/api/search-proposals/user-turn','/api/core-scope/start','/api/core-scope/end']);
  assert.ok(sent.every(row=>row.sessionId==='desktop:session-1'));
  await gateway.dispose();
});

test('Desktop controls query the raw DSH session, but scope cancellation uses its mapped Controller identity',async()=>{
  const observations=[],requests=[];
  const handler=actionsHandler({sessionQuery:{observeSession:async id=>{observations.push(id);return {events:[{type:'turn/start',data:{turn:1}}],[Symbol.dispose](){}};}},dshOrigin:'http://127.0.0.1:3000',controllerSession:id=>controllerSessionId(id,'desktop'),controllerRequest:async(path,options={})=>{
    requests.push({path,...options});
    if(path==='/api/production-state')return {productions:[],inferenceScope:null};
    if(path==='/api/status')return {};
    if(path==='/api/search-proposals')return {proposals:[{id:'p',phase:'running',sessionId:'desktop:session-1'},{id:'other',phase:'running',sessionId:'session-1'}]};
    if(path==='/api/search-proposals/cancel-session')return {};
    throw Error('unexpected controller request');
  }});
  const base='http://127.0.0.1:3000/api/local-studio/actions';
  const first=await handler(new Request(base+'?sessionId=session-1&sessionOnly=1'));
  const {stopTarget}=await first.json();
  assert.equal(stopTarget.kind,'search-session');
  const second=await handler(new Request(base,{method:'POST',headers:{Origin:'http://127.0.0.1:3000','X-Local-Studio-Action':'1','Content-Type':'application/json'},body:JSON.stringify({sessionId:'session-1',action:'stop-session',...stopTarget})}));
  assert.equal(second.status,200);
  assert.deepEqual(observations,['session-1','session-1']);
  assert.equal(requests.find(item=>item.path==='/api/search-proposals/cancel-session').body.sessionId,'desktop:session-1');
});

test('original image ownership compares the mapped identity while reading the raw conversation',async()=>{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const sha=createHash('sha256').update(bytes).digest('hex');
  const runId='00000000-0000-0000-0000-000000000001',name='image.png',seen=[];
  const image={name,artifactSha256:sha},attachment={attachmentId:`sha256:${sha}`,mediaType:'image/png',bytes:bytes.length,width:1,height:1};
  const handler=originalHandler({controllerSession:id=>controllerSessionId(id,'desktop'),sessionQuery:{observeSession:async id=>{seen.push(id);return {events:[{type:'tool/call',data:{name:'local_render_result',callId:'c'}},{type:'tool/result',surfaceOp:'append',data:{message:{source:{callId:'c'},content:[{type:'text',text:JSON.stringify({runId,images:[image]})},{type:'image',attachment}]}}}],[Symbol.dispose](){}};}},fetchRun:async()=>({run:{id:runId,sessionId:'desktop:session-1',artifacts:[{...image,sha256:sha,mime:'image/png'}]}}),fetchArtifact:async()=>new Response(bytes,{headers:{'Content-Type':'image/png'}})});
  const response=await handler(new Request('http://localhost/api/local-studio/original-image?'+new URLSearchParams({sessionId:'session-1',runId,name,sha256:sha})));
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.deepEqual(seen,['session-1']);
});
