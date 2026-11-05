// Candidate integration, enabled only for explicitly configured fixtures.
// Controller proof, single-send behavior and actual DSH delivery remain the
// responsibility of the caller and must be independently verified.
import {createHash} from 'node:crypto';
import {durableToolResult} from './durable-delivery.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>{const text=JSON.stringify(value);if(typeof text!=='string')throw Error('Mutation input is not JSON serializable');return hash(text);};

export async function acknowledgeVisibleReceipts({journal,session,sessions,persistence,mapSessionId,currentCallId,wireProof}){
  const scope=mapSessionId(session.id),pending=journal.pending(scope);
  for(const intent of pending){
    if(intent.state!=='receipt')throw Error('A previous mutation has no verified receipt and remains unresolved');
    const delivery=await durableToolResult({session,sessions,persistence,binding:intent,currentCallId,mapSessionId});
    let result;try{result=JSON.parse(delivery.text);}catch{throw Error('Stored tool result is not valid JSON');}
    const proofs=Array.isArray(result?.journalReceipts)?result.journalReceipts:result?.journalReceipt?[result.journalReceipt]:[];
    const matches=proofs.filter(proof=>proof?.id===intent.id),proof=matches[0];
    if(matches.length!==1||Object.keys(proof).sort().join(',')!=='ackNonce,id,receiptHash'||proof.receiptHash!==intent.receiptHash||typeof proof.ackNonce!=='string')throw Error('Stored tool result does not identify the pending receipt');
    if(typeof wireProof!=='function'||await wireProof({sessionId:scope,intentId:intent.id,receiptHash:intent.receiptHash,receiptNonceHash:hash(proof.ackNonce),priorCallIdHash:hash(delivery.resultCallId),nextCallIdHash:hash(currentCallId)})!==true)throw Error('Provider-wire delivery evidence is unavailable; keep the operation unresolved');
    journal.acknowledge({sessionId:scope,id:intent.id,receiptHash:intent.receiptHash,ackNonce:proof.ackNonce});
  }
}

export async function performDurableMutation({journal,session,sessions,persistence,mapSessionId,currentCallId,toolName,operation,requestId=null,input,correlationHash=null,lane='normal',targetId=null,parentIntentId=null,send,verifyReceipt,wireProof}){
  if(!journal||!session||typeof mapSessionId!=='function'||typeof send!=='function'||typeof verifyReceipt!=='function'||typeof currentCallId!=='string'||!currentCallId)throw Error('Mutation dependencies are incomplete');
  const sessionId=mapSessionId(session.id),events=session.snapshotEvents();
  const calls=events.filter(e=>e.type==='tool/call'&&e.data?.callId===currentCallId);
  if(calls.length!==1||calls[0].data?.name!==toolName||!Number.isSafeInteger(calls[0].data.turn)||calls[0].data.turn<1||!Number.isSafeInteger(calls[0].data.step)||calls[0].data.step<1)throw Error('Current DSH tool identity is unavailable or duplicated');
  if(lane==='normal')await acknowledgeVisibleReceipts({journal,session,sessions,persistence,mapSessionId,currentCallId,wireProof});
  // If this transaction fails, send() is never called. Once it succeeds a
  // crash is always conservatively unknown, including before actual dispatch.
  const intent=journal.begin({sessionId,lane,operation,requestId,inputHash:digest(input),correlationHash,targetId,parentIntentId,callIdHash:hash(currentCallId),toolName,turn:calls[0].data.turn,step:calls[0].data.step});
  const value=await send();
  // The caller must reject missing, foreign, malformed or ambiguous receipts.
  // A thrown error intentionally leaves the saved intent unresolved.
  const proof=await verifyReceipt(value,{sessionId,intent,input});
  if(!proof||!['applied','rejected'].includes(proof.outcome)||typeof proof.receiptHash!=='string'||!/^[a-f0-9]{64}$/.test(proof.receiptHash))throw Error('Controller receipt is not verified');
  const recorded=journal.recordReceipt({sessionId,id:intent.id,receiptHash:proof.receiptHash,source:'controller-response',outcome:proof.outcome});
  return {value,journalReceipt:{id:intent.id,receiptHash:proof.receiptHash,ackNonce:recorded.ackNonce}};
}
