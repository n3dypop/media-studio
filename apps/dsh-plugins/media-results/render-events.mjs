const outputTools=new Set(['local_production_render','local_prepared_render','local_render_result']);

export function* successfulRenderContent(events){
  const calls=new Map();
  for(const event of events??[]){
    if(event?.type==='tool/call'&&typeof event.data?.callId==='string'){
      calls.set(event.data.callId,event.data.name);
      continue;
    }
    const message=event?.data?.message;
    if(event?.type==='tool/result'&&event.surfaceOp==='append'&&!event.data.isError&&!message?.isError&&
      outputTools.has(calls.get(message?.source?.callId))&&Array.isArray(message.content))yield message.content;
  }
}
