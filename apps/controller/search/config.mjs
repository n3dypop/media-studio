import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// Search is optional. A missing file is disabled; malformed or explicitly
// enabled-but-invalid configuration is an error, not an implicit opt-out.
export function loadSearchConfiguration(root) {
  let raw;
  try { raw=readFileSync(join(root,'config/rustxng.json'),'utf8'); }
  catch(error) { if(error.code==='ENOENT')return {enabled:false,baseUrl:'http://127.0.0.1:29483'}; throw error; }
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid search configuration');
  if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw Error('Search enabled must be a boolean');
  if(value.enabled===false)return {enabled:false,baseUrl:'http://127.0.0.1:29483'};
  if(typeof value.baseUrl!=='string')throw Error('Enabled search requires a loopback baseUrl');
  const url=new URL(value.baseUrl);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port)throw Error('Search baseUrl must be an explicit loopback endpoint');
  return {enabled:true,baseUrl:url.origin};
}
