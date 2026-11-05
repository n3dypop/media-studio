import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localHostOrigin,createPlanningSender,planningReceiptFromHost} from '../apps/dsh-plugins/studio-controls/index.mjs';
import {actionsHandler,ACTIONS_PATH} from '../apps/dsh-plugins/studio-controls/actions.mjs';

const host=port=>({host:'127.0.0.1',protocol:'http:',port,getOrigin(){return `http://127.0.0.1:${this.port}`;}});
const disposed=events=>({events,[Symbol.dispose](){}});

test('the origin is resolved from the bound loopback Host each time',()=>{
  const current=host(43001);
  assert.equal(localHostOrigin(current),'http://127.0.0.1:43001');
  current.port=43002;assert.equal(localHostOrigin(current),'http://127.0.0.1:43002');
  for(const invalid of [null,{},host(0),host(65536),{...host(42),host:'0.0.0.0'},{...host(42),host:'192.0.2.1'},{...host(42),protocol:'https:'},{...host(42),getOrigin:()=> 'http://127.0.0.1:9999'},{...host(42),getOrigin(){throw Error('not listening');}}])assert.equal(localHostOrigin(invalid),null);
});

test('planning uses the injected Host session API without forwarding cookies',async()=>{
  const calls=[],controller={async prompt(request,signal){calls.push({request,signal});return {accepted:true};}};
  const send=createPlanningSender(controller),request=new Request('http://fixture/',{headers:{cookie:'fixture-secret'}});
  await send(request,'owner',{requestId:'id',text:'planning'});
  assert.deepEqual(calls[0].request,{sessionId:'owner',requestId:'id',mode:'queue',content:[{type:'text',text:'planning'}],clientTimeZone:'Asia/Tokyo'});
  assert.ok(calls[0].signal instanceof AbortSignal);assert.equal(JSON.stringify(calls).includes('fixture-secret'),false);
  await assert.rejects(send(new Request('http://fixture/'),'owner',{requestId:'id',text:'planning'}),e=>e.definitelyNotSent===true);
  await assert.rejects(createPlanningSender(null)(request,'owner',{requestId:'id',text:'planning'}),e=>e.definitelyNotSent===true);
  assert.equal(calls.length,1);
  await assert.rejects(createPlanningSender({prompt:async()=>{throw Error('uncertain');}})(request,'owner',{requestId:'id',text:'planning'}),e=>!e.definitelyNotSent);
  await assert.rejects(createPlanningSender({prompt:async()=>({accepted:false})})(request,'owner',{requestId:'id',text:'planning'}),e=>!e.definitelyNotSent);
});

test('distinct Host listeners cannot submit to each other and missing origin fails closed',async()=>{
  const productionId=randomUUID(),runId=randomUUID(),requestId=randomUUID();
  const production={id:productionId,sessionId:'same-id',phase:'revising',latestRunId:runId,latestUserDecision:{decision:'reject',sourceRunId:runId,artifactSha256:'a'.repeat(64),planningRequestId:requestId}};
  function setup(port){
    const server=host(port),prompts=[];let claims=0;
    const handler=actionsHandler({dshOrigin:()=>localHostOrigin(server),sessionQuery:{observeSession:async()=>disposed([])},controllerRequest:async(path,options)=>{
      if(path===`/api/productions/${productionId}`)return {production};
      if(path.endsWith('/planning-delivery')){if(options.body.state==='sending')claims++;return {claimed:true};}
      throw Error('unexpected');
    },sendPlanning:createPlanningSender({async prompt(input){prompts.push(input);return {accepted:true};}})});
    return {server,handler,prompts,claims:()=>claims};
  }
  const a=setup(43001),b=setup(43002),body={action:'plan-production',sessionId:'same-id',productionId,planningRequestId:requestId};
  const req=(url,origin)=>new Request(url+ACTIONS_PATH,{method:'POST',headers:{...(origin?{origin}:{}),cookie:'fixture-owner','content-type':'application/json','x-local-studio-action':'1'},body:JSON.stringify(body)});
  assert.equal((await a.handler(req('http://127.0.0.1:43001','http://127.0.0.1:43002'))).status,403);
  assert.equal((await a.handler(req('http://127.0.0.1:43001',null))).status,403);
  assert.equal((await a.handler(req('http://127.0.0.1:43001','http://127.0.0.1:43001'))).status,202);
  assert.equal(a.prompts.length,1);assert.equal(b.prompts.length,0);
  assert.equal((await b.handler(req('http://127.0.0.1:43002','http://127.0.0.1:43002'))).status,202);
  assert.equal(a.prompts.length,1);assert.equal(b.prompts.length,1);
  a.server.port=undefined;
  assert.equal((await a.handler(req('http://127.0.0.1:43001','http://127.0.0.1:43001'))).status,403);
  assert.equal(a.claims(),1);assert.equal(a.prompts.length,1);
});

test('a receipt must match exact user content, including consumed inbox splices',async()=>{
  const id=randomUUID(),planning={text:'expected'},message=(kind,text,rpcId=id)=>({source:{kind,rpcId},content:[{type:'text',text}]});
  const fixture=events=>({agents:{get:()=>undefined},sessionQuery:{observeSession:async()=>disposed(events)}});
  const read=events=>planningReceiptFromHost(fixture(events),'session',id,new AbortController().signal,planning);
  assert.equal(await read([{type:'user/message',data:message('user','expected')}]),true);
  assert.equal(await read([{type:'agent/inbox/spliced',data:{inserted:[message('user','expected')]}}]),true);
  assert.equal(await read([{type:'agent/inbox/spliced',data:{inserted:[message('user','different')]}}]),'conflict');
  assert.equal(await read([{type:'user/message',data:message('other','expected')}]),'conflict');
  assert.equal(await read([{type:'user/message',data:message('user','expected',randomUUID())}]),false);
  assert.equal(await read([{type:'unrelated/event',data:message('user','expected')}]),false);
  assert.equal(await read([{type:'user/message',data:message('user','expected')},{type:'user/message',data:message('user','different')}]),'conflict');
  await assert.rejects(planningReceiptFromHost({agents:{get:()=>({inbox:{nextTurn:[message('user','expected')],nextStep:[]}})},sessionQuery:{observeSession:async()=>{throw Error('observation unavailable');}}},'session',id,new AbortController().signal,planning),/observation unavailable/);
});

test('receipt conflict or failed observation never claims or sends planning',async()=>{
  const productionId=randomUUID(),runId=randomUUID(),requestId=randomUUID();
  const production={id:productionId,sessionId:'owner',phase:'revising',latestRunId:runId,latestUserDecision:{decision:'reject',sourceRunId:runId,artifactSha256:'a'.repeat(64),planningRequestId:requestId}};
  for(const [receipt,status] of [[async()=> 'conflict',409],[async()=>{throw Error('offline');},503]]){
    let claims=0,sends=0;
    const handler=actionsHandler({dshOrigin:'http://127.0.0.1:43001',sessionQuery:{observeSession:async()=>disposed([])},controllerRequest:async(path)=>{if(path===`/api/productions/${productionId}`)return {production};claims++;return {claimed:true};},sendPlanning:async()=>{sends++;},planningReceipt:receipt});
    const body={action:'plan-production',sessionId:'owner',productionId,planningRequestId:requestId};
    const request=new Request('http://127.0.0.1:43001'+ACTIONS_PATH,{method:'POST',headers:{origin:'http://127.0.0.1:43001','content-type':'application/json','x-local-studio-action':'1'},body:JSON.stringify(body)});
    assert.equal((await handler(request)).status,status);assert.equal(claims,0);assert.equal(sends,0);
  }
});
