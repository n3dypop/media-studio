import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute,relative,sep} from 'node:path';
import {RunStore} from '../apps/controller/store.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';

test('wire proof persists only hashes, remains session-bound and rejects changed call or nonce',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wire-evidence-')),file=join(root,'controller.db');
 t.after(async()=>{const r=relative(tmpdir(),root);assert.ok(r&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
 let store=new RunStore(file),wire=new DurableWireStore(store);
 const row={sessionId:'session-1',intentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',receiptHash:'a'.repeat(64),receiptNonceHash:'b'.repeat(64),priorCallIdHash:'c'.repeat(64),secretPrompt:'never persist this text'},next='d'.repeat(64);
 assert.equal(wire.record({sessionId:row.sessionId,receipts:[row],nextCallIdHashes:[next]}),1);assert.equal(wire.record({sessionId:row.sessionId,receipts:[row],nextCallIdHashes:[next]}),0);store.close();
 store=new RunStore(file);wire=new DurableWireStore(store);const proof={...row,nextCallIdHash:next};assert.equal(wire.has(proof),true);
 for(const value of [{...proof,sessionId:'session-2'},{...proof,receiptNonceHash:'e'.repeat(64)},{...proof,nextCallIdHash:'f'.repeat(64)},{...proof,priorCallIdHash:'0'.repeat(64)}])assert.equal(wire.has(value),false);
 assert.throws(()=>wire.record({sessionId:'session-2',receipts:[row],nextCallIdHashes:[next]}));
 assert.throws(()=>wire.record({sessionId:'session-1',receipts:[row,row],nextCallIdHashes:[next]}));
 store.close();assert.equal((await readFile(file)).includes(Buffer.from(row.secretPrompt)),false);
});
