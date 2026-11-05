// Unconnected experiment: a bounded buffered inference response. Do not use
// as a streaming replacement in production without independently reviewing the
// latency, cancellation and downstream middleware contracts. The exact input
// must already have been sent to the configured owned Strata instance.
import {ToolCallSseEvidence} from './durable-wire-evidence.mjs';
const LIMIT=8*1024*1024;

export async function bufferAttestedResponse({sessionId,input,upstream,wireStore,readReceipts,signal}){
  if(!upstream||typeof upstream.arrayBuffer!=='function'||!wireStore||typeof wireStore.record!=='function')throw Error('Wire transport dependencies are incomplete');
  const contentType=upstream.headers.get('content-type')??'';
  let receipts=[];try{if(typeof readReceipts==='function')receipts=await readReceipts({sessionId,messages:input?.messages});}catch{/* ambiguous or unavailable journal cannot prove delivery */}
  signal?.throwIfAborted();
  const declared=Number(upstream.headers.get('content-length'));if(Number.isFinite(declared)&&declared>LIMIT)throw Error('Buffered response exceeds the evidence limit');
  const reader=upstream.body?.getReader(),chunks=[];let size=0,parser=receipts.length&&upstream.ok&&contentType.toLowerCase().startsWith('text/event-stream')?new ToolCallSseEvidence():null;
  if(reader){const abort=()=>{reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>LIMIT)throw Error('Buffered response exceeds the evidence limit');chunks.push(Buffer.from(value));if(parser)try{parser.push(value);}catch{parser=null;}}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}}
  signal?.throwIfAborted();
  let proofRecorded=false;
  if(parser)try{const nextCallIdHashes=parser.finish();recordBatches(wireStore,sessionId,receipts,nextCallIdHashes);proofRecorded=true;}catch{/* malformed, incomplete or unrecorded evidence stays unresolved */}
  return {status:upstream.status,contentType,bytes:Buffer.concat(chunks),proofRecorded};
}
function recordBatches(wireStore,sessionId,receipts,nextCallIdHashes){
  for(let i=0;i<receipts.length;i+=16)for(let j=0;j<nextCallIdHashes.length;j+=16)wireStore.record({sessionId,receipts:receipts.slice(i,i+16),nextCallIdHashes:nextCallIdHashes.slice(j,j+16)});
}

function endOfEvent(bytes){
  let best=null;for(const [mark,length] of [['\n\n',2],['\r\n\r\n',4],['\n\r\n',3],['\r\n\n',3]]){const index=bytes.indexOf(mark);if(index>=0&&(!best||index<best.index))best={index,length};}return best;
}
function containsToolCall(frame){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(frame),data=text.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).replace(/^ /,'')).join('\n');
  if(!data||data==='[DONE]')return false;
  const parsed=JSON.parse(data);return Array.isArray(parsed?.choices)&&parsed.choices.some(choice=>(Array.isArray(choice?.delta?.tool_calls)&&choice.delta.tool_calls.length>0)||choice?.finish_reason==='tool_calls');
}

// Streaming experiment: forward completed text events as they arrive; defer
// the first tool-call event and all later bytes until the complete upstream SSE
// has been checked and evidence committed. `write` must wait for downstream
// drain and reject on disconnect. On malformed or oversized evidence, bytes are
// transparently forwarded but no proof is recorded; subsequent mutation stays
// blocked. No conversation text, image or bearer token is persisted.
export async function relayAttestedSse({sessionId,input,upstream,wireStore,readReceipts,write,signal}){
  if(!upstream||typeof upstream.arrayBuffer!=='function'||!wireStore||typeof wireStore.record!=='function'||typeof write!=='function')throw Error('Wire transport dependencies are incomplete');
  let receipts=[];try{if(typeof readReceipts==='function')receipts=await readReceipts({sessionId,messages:input?.messages});}catch{/* No evidence on ambiguous or unavailable journal. */}
  let parser=receipts.length&&upstream.ok&&(upstream.headers.get('content-type')??'').toLowerCase().startsWith('text/event-stream')?new ToolCallSseEvidence():null;
  const reader=upstream.body?.getReader();if(!reader)return {proofRecorded:false};
  let pending=Buffer.alloc(0),held=[],heldBytes=0,holding=false,proofRecorded=false;
  const output=async bytes=>{if(bytes.length){signal?.throwIfAborted();await write(bytes);}};
  const discardEvidence=async()=>{parser=null;holding=false;for(const frame of held)await output(frame);held=[];heldBytes=0;};
  const abort=()=>{reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      if(!parser){await output(Buffer.from(value));continue;}
      try{parser.push(value);}catch{await discardEvidence();await output(pending);pending=Buffer.alloc(0);await output(Buffer.from(value));continue;}
      pending=Buffer.concat([pending,Buffer.from(value)]);
      for(;;){const boundary=endOfEvent(pending);if(!boundary)break;const frame=pending.subarray(0,boundary.index+boundary.length);pending=pending.subarray(boundary.index+boundary.length);
        let tool;try{tool=containsToolCall(frame);}catch{await discardEvidence();await output(frame);await output(pending);pending=Buffer.alloc(0);break;}
        if(tool)holding=true;if(holding){held.push(frame);heldBytes+=frame.length;}else await output(frame);
        if(heldBytes>LIMIT){await discardEvidence();await output(pending);pending=Buffer.alloc(0);break;}
      }
      if(parser&&pending.length>LIMIT){await discardEvidence();await output(pending);pending=Buffer.alloc(0);}
    }
    signal?.throwIfAborted();
    if(parser&&holding)try{const nextCallIdHashes=parser.finish();recordBatches(wireStore,sessionId,receipts,nextCallIdHashes);proofRecorded=true;}catch{/* Fail closed; forward bytes without claiming evidence. */}
    for(const frame of held)await output(frame);await output(pending);
    return {proofRecorded};
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
