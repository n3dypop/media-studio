// Shared cryptographic framing. The input contains identities only; neither
// conversation data nor query text is part of this protocol.
import {createHmac,timingSafeEqual} from 'node:crypto';

const mac=(key,domain,value)=>createHmac('sha256',key).update(domain+'\0').update(JSON.stringify(value)).digest('hex');
export function searchOpenKey(token,hostId){if(typeof token!=='string'||!/^[\x21-\x7e]{16,4096}$/.test(token)||typeof hostId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(hostId))throw Error('Invalid search gateway identity');return createHmac('sha256',token).update('media-studio-search-open/v1\0'+hostId).digest();}
export function searchOpenRequestMac(key,payload){return mac(key,'request',payload);}
export function searchOpenResponseMac(key,payload){return mac(key,'response',{...payload,open:true});}
export function searchOpenMacEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||!/^[a-f0-9]{64}$/.test(a)||!/^[a-f0-9]{64}$/.test(b))return false;return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
