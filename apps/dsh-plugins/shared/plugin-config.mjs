import {isAbsolute,resolve,sep,win32} from 'node:path';
import {pathToFileURL} from 'node:url';

// Plugin code and private runtime state are deliberately separate roots. This
// small Standard Schema provider needs no DSH installation at import time.
export function runtimeRootOf(config,{allowWorkspaceRoot=false}={}){
  if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Plugin configuration must be an object with runtimeRoot.');
  const candidate=config.runtimeRoot??(allowWorkspaceRoot?config.workspaceRoot:undefined);
  const normalize=value=>{
    if(typeof value!=='string'||!value||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value)||/^[\\/]{2}/.test(value)||(!isAbsolute(value)&&!win32.isAbsolute(value))||/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^[a-z]:[\\/]/i.test(value))throw Error('runtimeRoot must be an absolute local filesystem directory.');
    return resolve(value);
  };
  const root=normalize(candidate);
  if(allowWorkspaceRoot&&config.runtimeRoot!==undefined&&config.workspaceRoot!==undefined&&normalize(config.workspaceRoot).toLowerCase()!==root.toLowerCase())throw Error('runtimeRoot and legacy workspaceRoot must identify the same directory.');
  return root;
}

export function runtimeRootUrl(config,options){const root=runtimeRootOf(config,options);return pathToFileURL(root.endsWith(sep)?root:root+sep);}

export function createRuntimeConfig({allowWorkspaceRoot=false,allowUnknown=false}={}){
  return Object.freeze({'~standard':Object.freeze({version:1,vendor:'n3dypop',validate(value){
    try{
      const runtimeRoot=runtimeRootOf(value,{allowWorkspaceRoot});
      const keys=new Set(['runtimeRoot',...(allowWorkspaceRoot?['workspaceRoot']:[])]);
      if(!allowUnknown&&Object.keys(value).some(key=>!keys.has(key)))throw Error('Unknown plugin configuration field.');
      return {value:{...value,runtimeRoot}};
    }catch(error){return {issues:[{message:error.message,path:['runtimeRoot']}]};}
  }})});
}
