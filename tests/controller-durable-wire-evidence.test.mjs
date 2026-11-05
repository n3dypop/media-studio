import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {wireInputReceipts,ToolCallSseEvidence} from '../apps/controller/durable-wire-evidence.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),receipt={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',receiptHash:'a'.repeat(64),ackNonce:'b'.repeat(43)};
const request=()=>[{role:'assistant',tool_calls:[{id:'old-call',type:'function',function:{name:'local_workflow_draft',arguments:'{}'}}]},{role:'tool',tool_call_id:'old-call',content:JSON.stringify({journalReceipt:receipt})}];
const verify=x=>x.sessionId==='session-1'&&x.intentId===receipt.id&&x.receiptHash===receipt.receiptHash&&x.receiptNonceHash===hash(receipt.ackNonce)&&x.priorCallIdHash===hash('old-call');
const encode=x=>Buffer.from(x),event=x=>'data: '+JSON.stringify(x)+'\n\n',chunk=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const complete=event(chunk({tool_calls:[{index:0,id:'new-call',type:'function',function:{name:'local_create',arguments:'{'}}]}))+event(chunk({tool_calls:[{index:0,function:{arguments:'}'}}]}))+event(chunk({},'tool_calls'))+'data: [DONE]\n\n';
function parse(input,split=3){const parser=new ToolCallSseEvidence(),bytes=encode(input);for(let i=0;i<bytes.length;i+=split)parser.push(bytes.subarray(i,i+split));return parser.finish();}

test('wire input binds unique owned tool receipt and returns no nonce or conversation content',()=>{
 const evidence=wireInputReceipts({sessionId:'session-1',messages:request(),verify});assert.deepEqual(evidence,[{sessionId:'session-1',intentId:receipt.id,receiptHash:receipt.receiptHash,receiptNonceHash:hash(receipt.ackNonce),priorCallIdHash:hash('old-call')}]);assert.ok(!JSON.stringify(evidence).includes(receipt.ackNonce));
 assert.throws(()=>wireInputReceipts({sessionId:'other',messages:request(),verify}),/owner/);
 const duplicate=request();duplicate.push(duplicate[1]);assert.throws(()=>wireInputReceipts({sessionId:'session-1',messages:duplicate,verify}),/unique/);
 const foreign=request();foreign[1].tool_call_id='other';assert.throws(()=>wireInputReceipts({sessionId:'session-1',messages:foreign,verify}),/preceding/);
 const changed=request();changed[1].content=JSON.stringify({journalReceipt:{...receipt,ackNonce:'c'.repeat(43)}});assert.throws(()=>wireInputReceipts({sessionId:'session-1',messages:changed,verify}),/owner/);
 const image=request();image[1].content=JSON.stringify({text:'brace } and quote "',journalReceipt:receipt})+'\nImage "test.png" (sha256:fixture)';assert.equal(wireInputReceipts({sessionId:'session-1',messages:image,verify}).length,1);
 const injected=request();injected[1].content='not-json\n'+JSON.stringify({journalReceipt:receipt});assert.equal(wireInputReceipts({sessionId:'session-1',messages:injected,verify}).length,0);
});
test('SSE parser waits for complete unambiguous tool calls across arbitrary chunk boundaries',()=>{
 for(const n of [1,2,7,128,4096])assert.deepEqual(parse(complete,n),[hash('new-call')]);
 const multi=event(chunk({tool_calls:[{index:0,id:'one'},{index:1,id:'two'}]}))+event(chunk({},'tool_calls'))+'data: [DONE]\n\n';assert.deepEqual(new Set(parse(multi)),new Set([hash('one'),hash('two')]));
});
test('short-circuited, malformed, partial or ambiguous SSE never proves delivery',()=>{
 const bad=[complete.slice(0,-5),event(chunk({tool_calls:[{index:0,id:'one'}]}))+event(chunk({},'tool_calls')),event(chunk({tool_calls:[{index:0,id:'one'}]}))+event(chunk({},'stop'))+'data: [DONE]\n\n',event(chunk({tool_calls:[{index:0,id:'one'},{index:1}]}))+event(chunk({},'tool_calls'))+'data: [DONE]\n\n',event(chunk({tool_calls:[{index:0,id:'same'},{index:1,id:'same'}]}))+event(chunk({},'tool_calls'))+'data: [DONE]\n\n','data: {broken}\n\n','event: error\ndata: {}\n\n'];
 for(const value of bad)assert.throws(()=>parse(value));
});
