import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostDesktopRequestTrust} from '../apps/dsh-plugins/shared/desktop-request-trust.mjs';
import {actionsHandler} from '../apps/dsh-plugins/studio-controls/actions.mjs';
import {servicesHandler,serviceSettingsHandler} from '../apps/dsh-plugins/studio-services/index.mjs';

test('Web service mutations check the live listener and an exact JSON media type',async()=>{
  let origin='http://127.0.0.1:42001';
  const calls=[];
  const services=servicesHandler({manager:{submit:async input=>{calls.push(input);return {created:true};}},dshOrigin:()=>origin});
  const settings=serviceSettingsHandler({settings:{save:async input=>{calls.push(input);return {saved:true};}},dshOrigin:()=>origin});
  for(const [handler,marker] of [[services,'service'],[settings,'service-settings']]){
    const post=(source,contentType)=>handler(new Request('http://127.0.0.1:42001/api/local-studio/'+marker,{
      method:'POST',headers:{...(source?{origin:source}:{}),'content-type':contentType,[`x-local-studio-${marker}`]:'1'},body:'{}',
    }));
    assert.equal((await post(origin,'application/jsonp')).status,403);
    assert.equal((await post(null,'application/json')).status,403);
    assert.equal((await post('http://127.0.0.1:42002','application/json')).status,403);
    assert.equal((await post(origin,'Application/JSON; charset=utf-8')).status,handler===services?202:200);
    const before=origin;origin=null;
    assert.equal((await post(before,'application/json')).status,403);
    origin=before;
  }
  assert.equal(calls.length,2);
});

const origin='http://127.0.0.1:3085',cookie='dsh-auth-fixture=synthetic';
const routes=[
  {path:'/api/local-studio/actions',marker:'x-local-studio-action'},
  {path:'/api/local-studio/services',marker:'x-local-studio-service'},
  {path:'/api/local-studio/service-settings',marker:'x-local-studio-service-settings'},
];
const issue=(trust,path)=>trust.challenge(new Request(origin+'/api/local-studio/desktop-proof/test',{headers:{cookie,'x-local-studio-proof-request':'1'}}),{method:'POST',path});
const post=(path,marker,proof,overrides={})=>new Request(origin+path,{method:'POST',headers:{cookie,'content-type':'application/json',[marker]:'1',...(proof?{'x-local-studio-desktop-proof':proof}:{}),...overrides},body:'{}'});

test('Desktop operations require the route-bound proof and preserve handler guards',async()=>{
  const trust=createHostDesktopRequestTrust(()=>origin);let calls=0;
  const manager={submit:async()=>{calls++;return {created:true};}},settings={save:async()=>{calls++;return {saved:true};}};
  const handlers=[
    actionsHandler({sessionQuery:{},controllerRequest(){},dshOrigin:origin,mutationAllowed:r=>trust.mutationAllowed(r,{marker:routes[0].marker})}),
    servicesHandler({manager,dshOrigin:origin,mutationAllowed:r=>trust.mutationAllowed(r,{marker:routes[1].marker})}),
    serviceSettingsHandler({settings,dshOrigin:origin,mutationAllowed:r=>trust.mutationAllowed(r,{marker:routes[2].marker})}),
  ];
  const proofs=[];for(const route of routes)proofs.push((await (await issue(trust,route.path)).json()).proof);
  for(let i=0;i<routes.length;i++){
    const {path,marker}=routes[i],handler=handlers[i];
    assert.equal((await handler(post(path,marker,null))).status,403);
    assert.equal((await handler(post(path,marker,proofs[(i+1)%routes.length]))).status,403);
    assert.equal((await handler(post(path,marker,proofs[i],{origin:'https://other.example'}))).status,403);
    assert.equal((await handler(post(path,marker,proofs[i],{cookie:'dsh-auth-fixture=other'}))).status,403);
    assert.equal((await handler(post(path,marker,proofs[i]))).status,i===0?400:i===1?202:200);
  }
  assert.equal(calls,2);
});

test('proof is unavailable until a stable listener exists and fails closed if it changes',async()=>{
  let listener=null;const trust=createHostDesktopRequestTrust(()=>listener),path=routes[0].path;
  assert.equal((await issue(trust,path)).status,403);listener=origin;
  const proof=(await (await issue(trust,path)).json()).proof;
  assert.equal(trust.mutationAllowed(post(path,routes[0].marker,proof),{marker:routes[0].marker}),true);
  listener='http://127.0.0.1:3086';
  assert.equal((await issue(trust,path)).status,403);
  assert.equal(trust.mutationAllowed(post(path,routes[0].marker,proof),{marker:routes[0].marker}),false);
});
