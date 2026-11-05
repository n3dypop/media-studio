import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnOwnerLifecycle} from '../apps/dsh-plugins/local-genai/turn-owner-lifecycle.mjs';

const options=owner=>({owner,mapSessionId:id=>'web:'+id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessions:{},persistence:{}});
test('normal end is completed before next turn even when the end callback is not awaited',async()=>{
 const log=[],owner={async begin({turn}){log.push('begin:'+turn);},async complete({turn}){await new Promise(resolve=>setTimeout(resolve,10));log.push('complete:'+turn);}},lifecycle=createTurnOwnerLifecycle(options(owner)),session={id:'s'};
 await lifecycle.begin(session,1);const ended=lifecycle.end(session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});const next=lifecycle.begin(session,2);await Promise.all([ended,next]);assert.deepEqual(log,['begin:1','complete:1','begin:2']);assert.deepEqual(await lifecycle.drain(),{active:1,failed:0});
});
test('abnormal end and storage failure block later ownership instead of claiming completion',async()=>{
 for(const reason of ['aborted','completed']){let completions=0;const owner={async begin(){},async complete(){completions++;throw Error('storage unavailable');}},lifecycle=createTurnOwnerLifecycle(options(owner)),session={id:'s'};await lifecycle.begin(session,1);await assert.rejects(lifecycle.end(session,{type:'turn/end',data:{turn:1,reason:{kind:reason}}}));await assert.rejects(lifecycle.begin(session,2));assert.equal(completions,reason==='completed'?1:0);assert.deepEqual(await lifecycle.drain(),{active:1,failed:1});}
});
test('other sessions can progress and unrelated stale end events do not complete an owner',async()=>{
 const log=[],owner={async begin({session,turn}){log.push('begin:'+session.id+':'+turn);},async complete({session,turn}){log.push('complete:'+session.id+':'+turn);}},lifecycle=createTurnOwnerLifecycle(options(owner)),a={id:'a'},b={id:'b'};
 await Promise.all([lifecycle.begin(a,1),lifecycle.begin(b,1)]);assert.equal(await lifecycle.end(a,{type:'turn/end',data:{turn:9,reason:{kind:'completed'}}}),false);assert.equal(await lifecycle.end(b,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}),true);assert.ok(!log.includes('complete:a:1'));assert.ok(log.includes('complete:b:1'));
});
