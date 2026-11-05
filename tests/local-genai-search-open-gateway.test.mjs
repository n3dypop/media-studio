import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createSearchOpenGateway} from '../apps/dsh-plugins/local-genai/search-open-gateway.mjs';
import {searchOpenKey,searchOpenRequestMac,searchOpenResponseMac} from '../apps/controller/search/open-handshake-codec.mjs';

test('loopback open confirmation binds host, session, turn, operation, proposal and fresh challenge',async()=>{
 const token='x'.repeat(64),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',proposalId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',key=searchOpenKey(token,hostId);let state='active';const gateway=await createSearchOpenGateway({token,hostId,isOpen:(session,turn)=>session==='synthetic'&&turn===1&&['active','completed'].includes(state)});
 const payload=(overrides={})=>({v:1,sessionId:'synthetic',turn:1,hostId,operation:'fetch',proposalId,challenge:randomBytes(32).toString('hex'),...overrides});
 async function send(p,mac=searchOpenRequestMac(key,p)){return fetch('http://127.0.0.1:'+gateway.port+'/open-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...p,requestMac:mac})});}
 try{const p=payload(),response=await send(p);assert.equal(response.status,200);assert.deepEqual(await response.json(),{v:1,challenge:p.challenge,open:true,responseMac:searchOpenResponseMac(key,p)});assert.equal((await send(p)).status,403,'A captured challenge cannot be replayed');
  assert.equal((await send(payload({sessionId:'other'}))).status,403);assert.equal((await send(payload({turn:2}))).status,403);assert.equal((await send(payload({hostId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}))).status,403);assert.equal((await send(payload(),'0'.repeat(64))).status,403);
  assert.equal((await fetch('http://127.0.0.1:'+gateway.port+'/open-check',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(5000)})).status,403);assert.equal((await fetch('http://127.0.0.1:'+gateway.port+'/other',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const original=payload(),changed={...original,operation:'claim'};assert.equal((await send(changed,searchOpenRequestMac(key,original))).status,403);state='completed';assert.equal((await send(payload({operation:'approve'}))).status,200);state='blocked';assert.equal((await send(payload())).status,403);
 }finally{await gateway.close();}
});
test('challenge capacity fails closed without expiry or eviction',async()=>{
 const token='x'.repeat(64),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',key=searchOpenKey(token,hostId),gateway=await createSearchOpenGateway({token,hostId,isOpen:()=>true,maxChallenges:1});
 async function send(){const payload={v:1,sessionId:'synthetic',turn:1,hostId,operation:'fetch',proposalId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',challenge:randomBytes(32).toString('hex')};return fetch('http://127.0.0.1:'+gateway.port+'/open-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestMac:searchOpenRequestMac(key,payload)})});}
 try{assert.equal((await send()).status,200);assert.equal((await send()).status,403);}finally{await gateway.close();}
});
