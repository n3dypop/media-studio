// Loopback-only confirmation. No prompts, image data, secrets or challenges
// are persisted. The Controller verifies Host and listener ownership.
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {searchOpenKey,searchOpenRequestMac,searchOpenResponseMac} from '../../controller/search/open-handshake-codec.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function equalHex(a,b){return hex(a)&&hex(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function payloadOf(body,hostId){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='challenge,hostId,operation,proposalId,requestMac,sessionId,turn,v'||body.v!==1||body.hostId!==hostId||typeof body.sessionId!=='string'||!/^[\x21-\x7e]{1,150}$/.test(body.sessionId)||!Number.isSafeInteger(body.turn)||body.turn<1||!['approve','claim','fetch'].includes(body.operation)||!(body.proposalId===null||uuid(body.proposalId))||!hex(body.challenge)||!hex(body.requestMac))return null;
 return {v:1,sessionId:body.sessionId,turn:body.turn,hostId:body.hostId,operation:body.operation,proposalId:body.proposalId,challenge:body.challenge};
}
export async function createSearchOpenGateway({token,hostId,isOpen,maxChallenges=65536}){
 if(typeof token!=='string'||!/^[\x21-\x7e]{16,4096}$/.test(token)||!uuid(hostId)||typeof isOpen!=='function'||!Number.isSafeInteger(maxChallenges)||maxChallenges<1||maxChallenges>65536)throw Error('Search open gateway configuration is invalid');
 const key=searchOpenKey(token,hostId);let closed=false;const sockets=new Set(),seenChallenges=new Set();
 const server=createServer(async(req,res)=>{
  const deny=()=>{if(!res.headersSent)res.writeHead(403,{'Cache-Control':'no-store','Content-Length':'0'});res.end();};
  if(closed||req.method!=='POST'||req.url!=='/open-check'||req.socket.remoteAddress!=='127.0.0.1'||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return deny();
  const pieces=[];let size=0;try{for await(const part of req){size+=part.length;if(size>4096)throw Error('large');pieces.push(part);}const body=JSON.parse(Buffer.concat(pieces).toString('utf8')),payload=payloadOf(body,hostId);if(!payload||!equalHex(body.requestMac,searchOpenRequestMac(key,payload))||isOpen(payload.sessionId,payload.turn)!==true||closed||seenChallenges.has(payload.challenge)||seenChallenges.size>=maxChallenges)return deny();seenChallenges.add(payload.challenge);const output={v:1,challenge:payload.challenge,open:true,responseMac:searchOpenResponseMac(key,payload)},bytes=Buffer.from(JSON.stringify(output));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':bytes.length});res.end(bytes);}catch{deny();}
 });
 server.headersTimeout=5000;server.requestTimeout=5000;server.maxConnections=64;server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.setTimeout(5000,()=>socket.destroy());});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string'||address.address!=='127.0.0.1'){closed=true;await new Promise(resolve=>server.close(resolve));throw Error('Search open loopback binding failed');}
 return Object.freeze({port:address.port,async close(){if(closed)return;closed=true;for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}});
}
