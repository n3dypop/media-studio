import {readFile,writeFile,mkdir,rename,open,unlink,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,win32} from 'node:path';
import {validateControllerNodeRuntime} from '../../controller/service-paths.mjs';

export const PATH_KEYS=Object.freeze(['comfyDirectory','comfyPythonExecutable','strataPythonExecutable','controllerNodeExecutable']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const fault=(message,status=409)=>Object.assign(Error(message),{status});
const inside=(root,path)=>path.toLowerCase()===root.toLowerCase()||path.toLowerCase().startsWith(root.toLowerCase()+'\\');
export function normalizeSettingPath(value){
  if(typeof value!=='string'||value!==value.trim()||!win32.isAbsolute(value)||!/^\w:[\\/]/.test(value)||/[\u0000-\u001f<>"|?*]/.test(value)||value.slice(2).includes(':'))throw fault('起動パスには絶対ローカルパスを指定してください。',400);
  const normalized=win32.normalize(value);return normalized.length>3?normalized.replace(/[\\/]+$/,''):normalized;
}
export async function validateServicePaths(values,{root,receipt,comfyRoot,strataRoot=receipt?.productRoot,stat=lstat,canonical=realpath,verifyNode=validateControllerNodeRuntime}={}){
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length!==PATH_KEYS.length||PATH_KEYS.some(key=>!Object.hasOwn(values,key)))throw fault('起動パスの項目が不正です。',400);
  const normalized=Object.fromEntries(PATH_KEYS.map(key=>[key,normalizeSettingPath(values[key])]));
  const project=normalizeSettingPath(root),comfy=normalizeSettingPath(comfyRoot),strata=normalizeSettingPath(strataRoot);
  if(!inside(comfy,normalized.comfyDirectory)||!inside(normalized.comfyDirectory,normalized.comfyPythonExecutable)||win32.basename(normalized.comfyPythonExecutable).toLowerCase()!=='python.exe')throw fault('ComfyUIとPythonは所定のComfyUI製品フォルダー内を指定してください。',400);
  if(win32.basename(normalized.controllerNodeExecutable).toLowerCase()!=='node.exe')throw fault('Controller Nodeはローカルのnode.exeを指定してください。',400);
  if(receipt?.prepared!==true||receipt.schemaVersion!==1||normalizeSettingPath(receipt.workspace).toLowerCase()!==project.toLowerCase()||normalizeSettingPath(receipt.productRoot).toLowerCase()!==strata.toLowerCase()||!inside(win32.join(strata,'.runtime','terminal'),normalizeSettingPath(receipt.control))||!inside(win32.join(strata,'.runtime','components','engine'),normalizeSettingPath(receipt.engine))||normalizeSettingPath(receipt.config).toLowerCase()!==win32.join(project,'data','strata','serve-config.json').toLowerCase())throw fault('Strataの準備済み導入記録を確認できません。',400);
  if(normalized.strataPythonExecutable.toLowerCase()!==normalizeSettingPath(win32.join(receipt.control,'python','python.exe')).toLowerCase())throw fault('Strata Pythonは準備済み導入記録と一致するものを指定してください。',400);
  const check=async(path,directory=false)=>{
    let current=path;
    while(current&&current!==win32.dirname(current)){
      const info=await stat(current);if(info.isSymbolicLink())throw fault('junctionやsymlinkを含む起動パスは使用できません。',400);
      current=win32.dirname(current);
    }
    const info=await stat(path);if(directory?!info.isDirectory():!info.isFile())throw fault('起動パスの種類が一致しません。',400);
    const actual=normalizeSettingPath(await canonical(path));if(actual.toLowerCase()!==path.toLowerCase())throw fault('起動パスの実体が指定値と一致しません。',400);
  };
  try{
    await check(normalized.comfyDirectory,true);await check(win32.join(normalized.comfyDirectory,'main.py'));
    await check(normalized.comfyPythonExecutable);await check(normalized.strataPythonExecutable);await check(normalized.controllerNodeExecutable);
    await check(win32.join(receipt.control,'serve','server.py'));await check(win32.join(receipt.engine,'engine-component.json'));
  }catch(e){if(e.status)throw e;throw fault('起動パスの存在と実体を確認できません。',400);}
  try{await verifyNode(normalized.controllerNodeExecutable);}catch{throw fault('Controllerには直接実行できるWindows x64版Node.js 24と必要なSQLite機能が必要です。',400);}
  return normalized;
}

export async function createServiceSettings({root,adapter,manager,validatePaths=validateServicePaths}={}){
  root=resolve(root);const envPath=join(root,'config/environment.json'),receiptPath=join(root,'data/strata/installation.json'),lockPath=join(root,'runtime/Studio-services.lock'),journalPath=join(root,'data/service-manager/operations.json');
  async function noRedirect(path){for(let current=path;current&&current!==win32.dirname(current);current=win32.dirname(current)){if((await lstat(current)).isSymbolicLink())throw fault('設定保存先にjunctionやsymlinkは使用できません。',400);}}
  async function ensureDirectory(path){
    const relative=win32.relative(root,path);if(relative.startsWith('..')||win32.isAbsolute(relative))throw Error('Backup path escaped project');
    await noRedirect(root);let current=root;
    for(const name of relative.split(/[\\/]/).filter(Boolean)){
      current=join(current,name);
      try{await mkdir(current);}catch(e){if(e.code!=='EEXIST')throw e;}
      const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw fault('設定の控え先にjunctionやsymlinkは使用できません。',400);
    }
  }
  async function source(){const raw=await readFile(envPath,'utf8'),environment=JSON.parse(raw),receiptRaw=await readFile(receiptPath,'utf8'),receipt=JSON.parse(receiptRaw);return {raw,environment,receipt,receiptRaw,revision:hash(raw),values:{comfyDirectory:environment.comfyDirectory,comfyPythonExecutable:environment.comfyPythonExecutable,strataPythonExecutable:environment.strataPythonExecutable??win32.join(receipt.control,'python','python.exe'),controllerNodeExecutable:environment.controllerNodeExecutable??win32.join(root,environment.nodeDirectory,'node.exe')}};}
  async function unresolved(){
    let journal;try{journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if(e.code==='ENOENT')return false;throw fault('サービス操作の記録を確認できません。');}
    if(!Array.isArray(journal.operations))throw fault('サービス操作の記録を確認できません。');
    return journal.operations.some(item=>!['completed','failed','cancelled','succeeded'].includes(item.state));
  }
  async function eligible(cookie){
    const current=await adapter.snapshot();
    if(!Array.isArray(current.services)||current.services.length!==3||current.services.some(service=>service.state!=='stopped'))throw fault('Strata・ComfyUI・Controllerを停止してから起動パスを保存してください。');
    if(await unresolved())throw fault('未解決のサービス操作があります。起動パスの変更は保留します。');
    await adapter.assertIdle(current,cookie);return current;
  }
  async function read({cookie}={}){
    const current=await source();let canSave=false,reason;
    try{try{await lstat(lockPath);throw fault('サービス操作中です。終了後に保存してください。');}catch(e){if(e.code!=='ENOENT')throw e;}await eligible(cookie);canSave=true;}catch(e){reason=e.status?e.message:'サービスの状態を確認できません。';}
    return {revision:current.revision,values:current.values,canSave,...(reason?{reason}:{})};
  }
  async function save(input,{cookie}={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['expectedRevision','values'].includes(key))||!/^[a-f0-9]{64}$/.test(input.expectedRevision??''))throw fault('設定の指定が不正です。',400);
    let lock,tmp;
    try{
      await noRedirect(envPath);await noRedirect(receiptPath);await noRedirect(join(root,'runtime'));
      try{lock=await open(lockPath,'wx');}catch{throw fault('別のサービス操作中または結果不明です。設定は変更しません。');}
      const current=await source();if(current.revision!==input.expectedRevision)throw fault('設定が変更されています。再読込して確認してください。');
      await eligible(cookie);
      const values=await validatePaths(input.values,{root,receipt:current.receipt,comfyRoot:current.environment.comfyDirectory,strataRoot:current.environment.strataDirectory??current.receipt.productRoot});
      if(hash(await readFile(envPath,'utf8'))!==current.revision||await readFile(receiptPath,'utf8')!==current.receiptRaw)throw fault('保存前に設定または導入記録が変更されました。再読込してください。');
      await eligible(cookie);
      const backupRoot=join(root,'docs/backups/service-settings');await ensureDirectory(backupRoot);
      const backup=join(backupRoot,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.environment.json');await writeFile(backup,current.raw,{flag:'wx'});
      tmp=envPath+'.'+randomUUID()+'.partial';const next=JSON.stringify({...current.environment,...values},null,2)+'\n',handle=await open(tmp,'wx');try{await handle.writeFile(next);await handle.sync();}finally{await handle.close();}
      if(hash(await readFile(envPath,'utf8'))!==current.revision||await readFile(receiptPath,'utf8')!==current.receiptRaw)throw fault('保存前に設定または導入記録が変更されました。再読込してください。');
      await rename(tmp,envPath);tmp=null;adapter.reload?.();manager?.invalidateCache?.();
      return {revision:hash(next),values,canSave:true};
    }finally{if(tmp)await unlink(tmp).catch(()=>{});if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}}
  }
  return {read,save};
}
