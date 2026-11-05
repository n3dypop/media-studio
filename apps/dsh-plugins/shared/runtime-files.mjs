import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';

export async function noLinks(root,path,{missing=false}={}){
  root=resolve(root);path=resolve(path);const rel=relative(root,path);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('Path escaped the configured runtime');
  let cursor=root;
  for(const part of ['',...rel.split(/[\\/]/).filter(Boolean)]){
    if(part)cursor=resolve(cursor,part);
    try{if((await lstat(cursor)).isSymbolicLink())throw Error('Redirected runtime paths are unsupported');}catch(error){if(missing&&error.code==='ENOENT')return;throw error;}
  }
}
export async function readJson(root,path,fallback=null){await noLinks(root,path,{missing:true});try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function configuredFile(path){
  if(typeof path!=='string'||!isAbsolute(path))throw Error('An absolute configured file is required');
  const actual=await realpath(path),stat=await lstat(path);
  if(resolve(actual)!==resolve(path)||stat.isSymbolicLink()||!stat.isFile())throw Error('Configured file must be a regular local file without redirects');
  return actual;
}
