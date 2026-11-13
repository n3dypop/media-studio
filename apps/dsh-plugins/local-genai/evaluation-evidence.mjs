// DSH's tool/result observer fires before the result is appended to the
// session. Capture only an already logged call; prove the result and the
// subsequent model step at evaluation time against the official session APIs.
export function deliveryPosition(session, callId) {
  try {
    const events=session.snapshotEvents(), start=events.findLastIndex(e=>e.type==='turn/start'),turn=events[start]?.data?.turn;
    if(start<0||events.slice(start+1).some(e=>e.type==='turn/end'))return null;
    const call=events.findLast(e=>e.type==='tool/call'&&e.data?.callId===callId);
    if(!Number.isSafeInteger(turn)||turn<1||call?.data?.turn!==turn||!Number.isSafeInteger(call.data.step)||call.data.step<1)return null;
    return {turn,step:call.data.step,callId};
  } catch { return null; }
}

export function visibleDelivery(session, evaluationCallId, binding, artifactSha256) {
  try {
    const events=session.snapshotEvents(), messages=session.deriveMessages();
    if(!Array.isArray(events)||!Array.isArray(messages))return false;
    const {turn,step,callId}=binding.position??{};
    const start=events.findLastIndex(e=>e.type==='turn/start');
    if(start<0||events[start].data?.turn!==turn||events.slice(start+1).some(e=>e.type==='turn/end'))return false;
    const resultIndex=events.findLastIndex(e=>e.type==='tool/result'&&e.data?.turn===turn&&e.data?.step===step&&e.data?.message?.source?.callId===callId);
    const evaluateIndex=events.findLastIndex(e=>e.type==='tool/call'&&e.data?.callId===evaluationCallId&&e.data?.turn===turn);
    if(resultIndex<0||evaluateIndex<=resultIndex||events[evaluateIndex].data.step<=step)return false;
    const resultSeq=events[resultIndex].seq,nodes=session.surface?.nodes;
    if(!Number.isSafeInteger(resultSeq)||!Array.isArray(nodes)||!nodes.includes(resultSeq))return false;
    const evalStep=events[evaluateIndex].data.step;
    if(!events.slice(resultIndex+1,evaluateIndex).some(e=>e.type==='assistant/message'&&e.data?.turn===turn&&e.data?.step===evalStep&&e.data?.message?.source?.kind==='model'&&Array.isArray(e.data.message.content)&&e.data.message.content.some(block=>block.type==='tool-call'&&block.id===evaluationCallId)))return false;
    // A compaction can replace unrelated older nodes while preserving this
    // result. Only the current projected message and its non-offloaded image
    // occurrences can prove it remains in the model-facing surface.
    const found=messages.filter(m=>m.role==='tool'&&m.source?.kind==='tool'&&m.source.callId===callId);
    if(found.length!==1||found[0].toolCallId!==callId||!Array.isArray(found[0].content))return false;
    const counts=new Map();
    for(const block of found[0].content)if(block.type==='image'&&block.offloaded!==true&&typeof block.attachment?.attachmentId==='string')counts.set(block.attachment.attachmentId,(counts.get(block.attachment.attachmentId)??0)+1);
    const needed=artifactSha256===binding.videoHash?binding.frameAttachments:binding.imageAttachments.filter(i=>i.hash===artifactSha256).slice(0,1);
    if(!Array.isArray(needed)||needed.length!==(artifactSha256===binding.videoHash?3:1))return false;
    return needed.every(({id})=>{const count=counts.get(id)??0;if(!count)return false;counts.set(id,count-1);return true;});
  } catch { return false; }
}

// Resolve only a single, still-visible image result from this exact turn.
// A previous session, another candidate, video, or a compacted image requires
// the caller to select and reopen the intended production explicitly.
export function singleVisibleImageDelivery(session, evaluationCallId, bindings) {
  const matches = [];
  for (const binding of bindings) {
    const hashes = [...binding.hashes];
    if (hashes.some(hash => visibleDelivery(session, evaluationCallId, binding, hash))) matches.push(binding);
    if (matches.length > 1) return null;
  }
  const [binding] = matches;
  return binding && !binding.videoHash && binding.imageAttachments.length === 1 && binding.hashes.size === 1 ? binding : null;
}
