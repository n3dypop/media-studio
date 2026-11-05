import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';

export function isPublicAddress(address){
  const family=isIP(address);
  if(family===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
  }
  if(family===6){
    // Global unicast only; exclude translation/tunnelling and documentation ranges.
    const normalized=new URL('http://['+address+']/').hostname.slice(1,-1).toLowerCase();
    const [first,second]=normalized.split(':').map(part=>parseInt(part||'0',16));
    // Conservatively exclude IETF protocol assignments 2001::/23, including
    // benchmarking, Teredo and both ORCHID ranges (not only their first /32).
    return /^[23][0-9a-f]{3}:/.test(normalized)&&!(first===0x2001&&second<=0x1ff)&&!/^2002:|^2001:db8:|^3fff:/.test(normalized);
  }
  return false;
}
export function pageUrl(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw new Error('Page URL must use a standard public HTTP(S) endpoint');
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(!host.includes('.')||host==='localhost'||/\.(localhost|local|internal)$/.test(host)||isIP(host))throw new Error('Page hostname must be a public DNS name');
  return url;
}
function entities(text){return text.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos|nbsp);/gi,(m,n,name)=>{
  if(name)return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name.toLowerCase()];
  const point=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);return point>0&&point<=0x10ffff&&!((point>=0xd800)&&(point<=0xdfff))?String.fromCodePoint(point):' ';
});}
export function extractPage(body,contentType,url,{maxCharacters=12000}={}){
  let title=url;
  if(contentType.includes('html')){
    title=entities(body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g,' ')??url).trim().slice(0,240);
    body=body.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ').replace(/<(?:br|\/p|\/div|\/article|\/section|\/h[1-6]|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ');
    body=entities(body);
  }
  body=body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').replace(/[\t ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {url,title,text:body.slice(0,maxCharacters),content:body.slice(0,700),truncated:body.length>maxCharacters,retrievedAt:new Date().toISOString()};
}

/** Direct connection with the checked DNS answer pinned into socket lookup; no proxy or redirect. */
export async function readPublicPage(value,{signal,lookupImpl=lookup,requestImpl,maxBytes=1024*1024}={}){
  const url=pageUrl(value);if(signal?.aborted)throw signal.reason??new Error('Aborted');
  const addresses=await new Promise((resolve,reject)=>{
    const aborted=()=>reject(signal.reason??new Error('Aborted'));
    signal?.addEventListener('abort',aborted,{once:true});
    Promise.resolve().then(()=>lookupImpl(url.hostname,{all:true,verbatim:true})).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',aborted));
  });
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)||a.family!==isIP(a.address)))throw new Error('Page DNS is private, special-purpose, or mixed');
  if(signal?.aborted)throw signal.reason??new Error('Aborted');
  const selected=addresses[0];
  const request=requestImpl??(url.protocol==='https:'?https.request:http.request);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
    const req=request(url,{method:'GET',signal,headers:{Accept:'text/html,application/xhtml+xml,text/plain','Accept-Encoding':'identity','User-Agent':'media-studio/source-reader'},lookup:(_hostname,options,callback)=>{if(options?.all)callback(null,[selected]);else callback(null,selected.address,selected.family);}},response=>{
      if(response.statusCode!==200){response.destroy();finish(new Error('Page HTTP status '+response.statusCode+'; redirects are not followed'));return;}
      const type=String(response.headers['content-type']??'').toLowerCase();
      if(!/^(text\/(html|plain)|application\/xhtml\+xml)(?:;|$)/.test(type)||!['','identity'].includes(String(response.headers['content-encoding']??''))){response.destroy();finish(new Error('Unsupported page type or encoding'));return;}
      if(Number(response.headers['content-length']??0)>maxBytes){response.destroy();finish(new Error('Page exceeds byte budget'));return;}
      const chunks=[];let length=0;
      response.on('data',chunk=>{length+=chunk.length;if(length>maxBytes){response.destroy();finish(new Error('Page exceeds byte budget'));}else chunks.push(chunk);});
      response.on('error',error=>finish(error));response.on('aborted',()=>finish(new Error('Page response interrupted')));
      response.on('end',()=>{if(!settled)finish(null,{...extractPage(Buffer.concat(chunks).toString('utf8'),type,url.href),bytes:length});});
    });
    req.on('error',error=>finish(error));req.setTimeout?.(20000,()=>req.destroy(new Error('Page timeout')));req.end();
  });
}
