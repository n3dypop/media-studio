// Prototype only: prove one tool result is in the current model-facing session
// surface and in storage after an awaited DSH durability barrier. It does not
// issue requests, validate Controller receipts, or acknowledge a journal.
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function durableToolResult({session,sessions,persistence,binding,currentCallId,mapSessionId}){
  if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function'||typeof session.deriveMessages!=='function'||typeof sessions?.flush!=='function'||typeof persistence?.open!=='function'||typeof persistence?.flush!=='function')throw Error('Official DSH session persistence is unavailable');
  const fields=[binding?.deliveryCallIdHash,binding?.deliveryToolName,binding?.deliveryTurn,binding?.deliveryStep],hasDelivery=fields.some(x=>x!=null);
  if(hasDelivery&&fields.some(x=>x==null))throw Error('Reconciliation delivery identity is incomplete');
  const callIdHash=hasDelivery?fields[0]:binding?.callIdHash,toolName=hasDelivery?fields[1]:binding?.toolName,turn=hasDelivery?fields[2]:binding?.turn,step=hasDelivery?fields[3]:binding?.step;
  if(typeof mapSessionId!=='function'||!binding||binding.sessionId!==mapSessionId(session.id)||typeof callIdHash!=='string'||!/^[a-f0-9]{64}$/.test(callIdHash)||typeof toolName!=='string'||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(step)||step<1||typeof currentCallId!=='string'||!currentCallId)throw Error('Saved DSH call identity is incomplete or belongs to another session');
  const events=session.snapshotEvents(),messages=session.deriveMessages(),nodes=session.surface?.nodes;
  if(!Array.isArray(events)||!Array.isArray(messages)||!Array.isArray(nodes))throw Error('Session surface is unavailable');
  const originalCalls=events.filter(e=>e.type==='tool/call'&&typeof e.data?.callId==='string'&&hash(e.data.callId)===callIdHash);
  if(originalCalls.length!==1)throw Error('Saved DSH call is missing or duplicated');
  const original=originalCalls[0],resultCallId=original.data.callId;
  if(original.data.name!==toolName||original.data.turn!==turn||original.data.step!==step||resultCallId===currentCallId)throw Error('Saved DSH call identity differs');
  const matches=events.filter(e=>e.type==='tool/result'&&e.data?.message?.source?.callId===resultCallId);
  const calls=events.filter(e=>e.type==='tool/call'&&e.data?.callId===currentCallId);
  if(matches.length!==1||calls.length!==1)throw Error('Result or subsequent call is not unique');
  const result=matches[0],call=calls[0];
  if(!Number.isSafeInteger(original.seq)||!Number.isSafeInteger(result.seq)||result.seq<=original.seq||result.data?.turn!==turn||result.data?.step!==step||result.data?.message?.role!=='tool'||result.data?.message?.source?.kind!=='tool'||result.data?.message?.toolCallId!==resultCallId||result.data?.message?.isError!==false||!Array.isArray(result.sourceEventSeqs)||!result.sourceEventSeqs.includes(original.seq)||!Number.isSafeInteger(call.seq)||call.seq<=result.seq||!nodes.includes(result.seq))throw Error('Result is absent, erroneous, unbound, or order is invalid');
  const modelCall=events.find(e=>e.type==='assistant/message'&&e.data?.turn===call.data?.turn&&e.data?.step===call.data?.step&&e.data?.message?.source?.kind==='model'&&e.data.message.content?.some?.(b=>b.type==='tool-call'&&b.id===currentCallId));
  if(!modelCall||modelCall.seq<=result.seq||modelCall.seq>=call.seq)throw Error('A subsequent model call was not confirmed');
  const shown=messages.filter(m=>m.role==='tool'&&m.source?.kind==='tool'&&m.source.callId===resultCallId&&m.toolCallId===resultCallId);
  if(shown.length!==1||!Array.isArray(shown[0].content))throw Error('Prior tool result is not visible to the current model');
  const text=result.data?.message?.content?.find(b=>b.type==='text')?.text;
  const shownText=shown[0].content.find(b=>b.type==='text'&&b.offloaded!==true)?.text;
  if(typeof text!=='string'||shownText!==text)throw Error('Visible result differs from the recorded result');
  if(await sessions.flush(session)!==true)throw Error('No DSH durability listener participated');
  // sessions.flush() only establishes that *some* listener participated.
  // The independently injected backend must also complete its own barrier.
  await persistence.flush();
  const reader=await persistence.open(session.id,'read');let storedCall,stored;
  try{
    if(reader.id!==session.id||reader.access!=='read')throw Error('Stored session identity differs');
    storedCall=(await reader.read(original.seq,1))?.events;
    stored=(await reader.read(result.seq,1))?.events;
  }finally{await reader.close();}
  if(!Array.isArray(storedCall)||storedCall.length!==1)throw Error('Durable tool call is missing');
  const prior=storedCall[0];
  if(prior.seq!==original.seq||prior.type!=='tool/call'||prior.data?.callId!==resultCallId||prior.data?.name!==toolName||prior.data?.turn!==turn||prior.data?.step!==step)throw Error('Durable tool call differs from the saved identity');
  if(!Array.isArray(stored)||stored.length!==1)throw Error('Durable result is missing');
  const row=stored[0];
  if(row.seq!==result.seq||row.type!=='tool/result'||row.data?.turn!==turn||row.data?.step!==step||row.data?.message?.role!=='tool'||row.data?.message?.source?.kind!=='tool'||row.data?.message?.toolCallId!==resultCallId||row.data?.message?.isError!==false||!row.sourceEventSeqs?.includes(original.seq)||row.data?.message?.source?.callId!==resultCallId||row.data.message.content?.find(b=>b.type==='text')?.text!==text)throw Error('Durable result differs from the current session');
  return {seq:result.seq,resultCallId,text};
}
