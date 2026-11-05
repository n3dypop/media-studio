// Candidate parsing only. This module neither forwards inference nor writes a
// journal. Its caller must bind the authenticated Controller inference scope,
// ensure the exact bytes were sent to Strata, and commit a proof before letting
// DSH execute a tool. Unknown, short-circuited or partial streams prove nothing.
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=/^[a-f0-9]{64}$/,nonce=/^[A-Za-z0-9_-]{43}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// DSH's provider projection can append image descriptions after the first
// JSON text block. Parse only the leading complete object, respecting quoted
// braces and escapes; never search arbitrary later text for a receipt marker.
function leadingObject(text){
  let i=0;while(i<text.length&&/\s/.test(text[i]))i++;if(text[i]!=='{')return null;
  const start=i,stack=[],pairs={'}':'{',']':'['};let quoted=false,escape=false;
  for(;i<text.length;i++){const c=text[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')stack.push(c);else if(c==='}'||c===']'){if(stack.pop()!==pairs[c])return null;if(!stack.length){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}}}
  return null;
}

// Return only hashes and opaque receipt IDs. Prompt text, image bytes and the
// receipt nonce are not returned or persisted. verify must perform a read-only
// comparison against the current, still-pending owned journal row.
export function wireInputReceipts({sessionId,messages,verify}){
  if(typeof sessionId!=='string'||!sessionId||!Array.isArray(messages)||typeof verify!=='function')throw Error('Wire evidence dependencies are incomplete');
  const seenCalls=new Map(),seenResults=new Set(),output=[];
  for(const m of messages){
    if(m?.role==='assistant'&&Array.isArray(m.tool_calls))for(const call of m.tool_calls){if(typeof call?.id!=='string'||!call.id||call.id.length>256||seenCalls.has(call.id))throw Error('Assistant tool call is ambiguous');seenCalls.set(call.id,true);}
    if(m?.role!=='tool')continue;
    const callId=m.tool_call_id;if(typeof callId!=='string'||!seenCalls.has(callId)||seenResults.has(callId))throw Error('Tool response is missing its unique preceding call');seenResults.add(callId);
    const text=typeof m.content==='string'?m.content:null;if(text===null||text.length>1048576)continue;
    const parsed=leadingObject(text);if(!parsed)continue;
    const proofs=Array.isArray(parsed?.journalReceipts)?parsed.journalReceipts:parsed?.journalReceipt?[parsed.journalReceipt]:[];
    for(const proof of proofs){
      if(!proof||Object.keys(proof).sort().join(',')!=='ackNonce,id,receiptHash'||!uuid.test(proof.id??'')||!sha.test(proof.receiptHash??'')||!nonce.test(proof.ackNonce??''))throw Error('Malformed wire receipt');
      const record={sessionId,intentId:proof.id,receiptHash:proof.receiptHash,receiptNonceHash:hash(proof.ackNonce),priorCallIdHash:hash(callId)};
      const verdict=verify(record);if(verdict==='not-current')continue;
      if(verdict!==true)throw Error('Wire receipt does not match its pending owner');
      if(output.some(x=>x.intentId===record.intentId))throw Error('Receipt appears multiple times');
      output.push(record);
    }
  }
  return output;
}

// This parser never modifies or forwards SSE bytes. Call finish only after the
// complete upstream stream ends normally; it rejects truncation, ambiguous
// choices/IDs and malformed SSE rather than inventing a delivery proof.
export class ToolCallSseEvidence {
  constructor(){this.decoder=new TextDecoder('utf-8',{fatal:true});this.buffer='';this.data=[];this.calls=new Map();this.indices=new Set();this.finished=false;this.done=false;this.invalid=false;this.bytes=0;}
  push(bytes){
    if(this.done||this.invalid)throw Error('SSE evidence is already closed');
    this.bytes+=bytes.byteLength;if(this.bytes>8*1024*1024){this.invalid=true;throw Error('SSE evidence exceeds limit');}
    try{this.buffer+=this.decoder.decode(bytes,{stream:true});this.lines();}catch(e){this.invalid=true;throw e;}
  }
  lines(){
    for(;;){const n=this.buffer.indexOf('\n');if(n<0)return;let line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);if(line.endsWith('\r'))line=line.slice(0,-1);
      if(line===''){if(this.data.length)this.event();continue;}if(line.startsWith(':'))continue;
      if(line.startsWith('data:'))this.data.push(line.slice(5).replace(/^ /,''));
      else if(line.startsWith('event:')&&line.slice(6).trim()==='error')throw Error('Upstream reported an SSE error');
    }
  }
  event(){
    const raw=this.data.join('\n');this.data=[];
    if(raw==='[DONE]'){if(this.done)throw Error('Duplicate SSE completion');this.done=true;return;}
    if(this.done)throw Error('Data after SSE completion');
    let value;try{value=JSON.parse(raw);}catch{throw Error('Malformed SSE event');}
    if(value?.error)throw Error('Upstream reported an inference error');
    if(!Array.isArray(value?.choices))throw Error('Ambiguous inference choice');
    if(value.choices.length===0&&this.finished&&value.usage)return;
    if(value.choices.length!==1||value.choices[0]?.index!==0)throw Error('Ambiguous inference choice');
    const choice=value.choices[0],alreadyFinished=this.finished;if(choice.finish_reason!=null){if(this.finished||choice.finish_reason!=='tool_calls')throw Error('Inference did not end with tool calls');this.finished=true;}
    for(const call of choice.delta?.tool_calls??[]){
      if(alreadyFinished||!Number.isSafeInteger(call?.index)||call.index<0)throw Error('Invalid streamed tool index');this.indices.add(call.index);
      if(call.id!==undefined&&call.id!==null){if(typeof call.id!=='string'||!call.id||call.id.length>256)throw Error('Invalid streamed tool identity');const old=this.calls.get(call.index);if(old&&old!==call.id)throw Error('Streamed tool identity changed');this.calls.set(call.index,call.id);}
    }
  }
  finish(){
    if(this.invalid)throw Error('SSE evidence is invalid');
    try{this.buffer+=this.decoder.decode();this.lines();if(this.buffer||this.data.length||!this.done||!this.finished||!this.calls.size||this.indices.size!==this.calls.size||new Set(this.calls.values()).size!==this.calls.size)throw Error('SSE tool call evidence is incomplete');return [...this.calls.values()].map(hash);}
    catch(error){this.invalid=true;throw error;}
  }
}
