import {createHash} from 'node:crypto';

export const ORIGINAL_PATH='/api/local-studio/original-image';
const MAX_PNG_BYTES=64*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const safeName=value=>typeof value==='string'&&value.length<=200&&/^[a-zA-Z0-9_.-]+\.png$/i.test(value)&&!value.includes('..');
const contentType={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};

/** Only a successfully appended, actually delivered image can authorize a download. */
export function recordedOriginal(events,{runId,name,sha256}){
  const calls=new Set();
  for(const event of events??[]){
    if(event.type==='tool/call'&&['local_production_render','local_prepared_render','local_render_result'].includes(event.data?.name))calls.add(event.data.callId);
    if(event.type!=='tool/result'||event.surfaceOp!=='append'||event.data?.message?.isError||!calls.has(event.data?.message?.source?.callId))continue;
    const content=event.data.message.content;
    if(!Array.isArray(content))continue;
    const text=content.find(part=>part?.type==='text'&&typeof part.text==='string')?.text;
    if(!text||text.length>1024*1024)continue;
    let meta;try{meta=JSON.parse(text);}catch{continue;}
    if(meta?.runId!==runId||!Array.isArray(meta.images))continue;
    const shown=content.filter(part=>part?.type==='image');
    if(meta.images.length!==shown.length)continue;
    for(let i=0;i<shown.length;i++){
      const image=meta.images[i],attachment=shown[i]?.attachment;
      if(image?.name===name&&image.artifactSha256===sha256&&attachment&&/^sha256:[a-f0-9]{64}$/.test(attachment.attachmentId??'')&&['image/png','image/jpeg','image/webp','image/gif'].includes(attachment.mediaType)&&Number.isSafeInteger(attachment.bytes)&&attachment.bytes>0&&Number.isSafeInteger(attachment.width)&&attachment.width>0&&Number.isSafeInteger(attachment.height)&&attachment.height>0)return true;
    }
  }
  return false;
}

/** Session-authenticated DSH route; no arbitrary path/URL or admin credential is accepted. */
export function originalHandler({sessionQuery,fetchRun,fetchArtifact,controllerSession=sessionId=>sessionId}){
  return async request=>{
    const fail=(status,message)=>new Response(message,{status,headers:{...contentType,'Content-Type':'text/plain; charset=utf-8'}});
    if(request.method!=='GET')return fail(405,'Method not allowed');
    const q=new URL(request.url).searchParams,fields=['sessionId','runId','name','sha256'];
    if([...q.keys()].some(k=>!fields.includes(k))||fields.some(k=>q.getAll(k).length!==1))return fail(400,'Invalid image identity');
    const [sessionId,runId,name,sha256]=fields.map(k=>q.get(k));
    if(!sessionId||sessionId.length>150||/[\x00-\x1f\x7f]/.test(sessionId)||!UUID.test(runId)||!safeName(name)||!HASH.test(sha256))return fail(400,'Invalid image identity');
    let observed;
    try{
      observed=await sessionQuery.observeSession(sessionId,{signal:request.signal,projectionMode:'none'});
      if(!recordedOriginal(observed.events,{runId,name,sha256}))return fail(404,'Image not recorded in this session');
    }catch{return fail(404,'Image not recorded in this session');}
    finally{observed?.[Symbol.dispose]();}
    try{
      const result=await fetchRun({sessionId,runId,signal:request.signal}),run=result?.run;
      const artifact=run?.artifacts?.find(a=>a?.name===name&&a?.sha256===sha256&&a?.mime==='image/png');
      if(run?.id!==runId||run?.sessionId!==controllerSession(sessionId)||!artifact)return fail(404,'Image not recorded in this session');
      const response=await fetchArtifact({sessionId,runId,name,signal:request.signal});
      if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='image/png'||!response.body)return fail(404,'Image not available');
      const declared=response.headers.get('content-length');
      if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_PNG_BYTES)){await response.body.cancel();return fail(413,'Image exceeds size limit');}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>MAX_PNG_BYTES){await reader.cancel();return fail(413,'Image exceeds size limit');}chunks.push(Buffer.from(item.value));}}
      finally{reader.releaseLock();}
      const bytes=Buffer.concat(chunks);
      if(bytes.length<8||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||createHash('sha256').update(bytes).digest('hex')!==sha256)return fail(409,'Image integrity check failed');
      return new Response(bytes,{headers:{...contentType,'Content-Type':'image/png','Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="${name}"`}});
    }catch{return fail(503,'Image could not be verified');}
  };
}
