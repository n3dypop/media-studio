import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,realpath,rename,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const engines=['Strata','ComfyUI'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fault=(message,status=409)=>Object.assign(Error(message),{status});
const limits={context:[32768,65536],residentGiB:[8,24],reserveMiB:[2048,5120]};
const flags={context:'--max-context',prefill:'--prefill',residentGiB:'--resident-budget-gib',reserveMiB:'--vram-reserve-mib'};
const defaults={memoryMode:'auto',cacheMode:'default',previewMethod:'none',reserveGiB:null};
const options={prefill:['256','512','768','1024','auto'],memoryMode:['auto','low','minimal'],cacheMode:['default','none'],previewMethod:['none','auto','latent2rgb']};
const inRange=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const encode=value=>JSON.stringify(value,null,2)+'\n';
const samePath=(a,b)=>typeof a==='string'&&isAbsolute(a)&&resolve(a).toLowerCase()===b.toLowerCase();

export function validateEngineSettings(engine,values){
  const keys=engine==='Strata'?Object.keys(flags):engine==='ComfyUI'?Object.keys(defaults):[];
  if(!keys.length||!values||typeof values!=='object'||Array.isArray(values)||
    Object.keys(values).length!==keys.length||keys.some(key=>!Object.hasOwn(values,key)))throw fault('設定項目が一致しません。',400);
  for(const key of keys){
    const value=values[key];
    let valid;
    if(limits[key])valid=Number.isSafeInteger(value)&&inRange(value,...limits[key])&&(key!=='context'||value%1024===0);
    else if(key==='reserveGiB')valid=value===null||inRange(value,0.5,4)&&Number.isInteger(value*4);
    else valid=options[key].includes(value);
    if(!valid)throw fault('設定値が対応範囲外です: '+key,400);
  }
  return Object.fromEntries(keys.map(key=>[key,values[key]]));
}

function strataValues(config){
  if(!Array.isArray(config.args)||config.args.some(arg=>typeof arg!=='string'))throw Error('Unsupported Strata arguments');
  const locations=Object.fromEntries(Object.entries(flags).map(([key,flag])=>{
    const at=config.args.indexOf(flag);
    if(at<0||at!==config.args.lastIndexOf(flag)||config.args.some(arg=>arg.startsWith(flag+'='))||!config.args[at+1]||config.args[at+1].startsWith('--')){
      throw Error('Missing or ambiguous Strata argument: '+flag);
    }
    return [key,at+1];
  }));
  const values=Object.fromEntries(Object.entries(locations).map(([key,at])=>[key,key==='prefill'?config.args[at]:Number(config.args[at])]));
  return {values,locations};
}

async function direct(path,{missing=false}={}){
  for(let cursor=path;cursor!==parse(cursor).root;cursor=dirname(cursor)){
    try{if((await lstat(cursor)).isSymbolicLink())throw Error('Linked engine settings path');}
    catch(error){if(!missing||error.code!=='ENOENT')throw error;}
  }
  if(!missing&&!samePath(await realpath(path),path))throw Error('Redirected engine settings path');
}

async function json(path){
  await direct(path);
  const raw=await readFile(path);
  return {path,raw,value:JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')),revision:hash(raw)};
}

async function writeNew(path,bytes){
  const file=await open(path,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}

async function replace(path,bytes,expected){
  const staged=path+'.'+randomUUID()+'.partial';
  await writeNew(staged,bytes);
  try{
    if(hash(await readFile(path))!==expected)throw fault('保存先が変更されました。再読込してください。');
    await rename(staged,path);
  }finally{await unlink(staged).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

export async function readEngineSettings(root,engine){
  if(!engines.includes(engine))throw fault('設定対象が不正です。',400);
  const env=await json(join(root,'config/environment.json'));
  if(engine==='ComfyUI'){
    const values=validateEngineSettings(engine,{...defaults,...env.value.comfyTuning});
    return {revision:env.revision,values,env};
  }
  const receipt=await json(join(root,'data/strata/installation.json')),value=receipt.value;
  if(value.prepared!==true||value.schemaVersion!==1||!samePath(value.workspace,root)||
    typeof value.productRoot!=='string'||!isAbsolute(value.productRoot)||value.productRoot.startsWith('\\\\')||
    (env.value.strataDirectory&&!samePath(value.productRoot,resolve(env.value.strataDirectory))))throw Error('Invalid Strata installation identity');
  const configPath=[join(root,'data/strata/serve-config.json'),join(value.productRoot,'.runtime/local-serve/serve-config.json')]
    .find(path=>samePath(value.config,path));
  if(!configPath)throw Error('Unexpected Strata configuration path');
  const config=await json(configPath);
  if(value.configSha256!==config.revision||config.value.model_name!==value.model)throw fault('Strata設定と導入記録が一致しません。控えと起動ログを確認してください。');
  return {revision:hash(config.revision+receipt.revision),launchRevision:config.revision,receipt,config,...strataValues(config.value)};
}

export async function saveEngineSettings(root,engine,input){
  if(!input||typeof input!=='object'||!Object.hasOwn(input,'values')||Object.keys(input).length!==2||
    !/^[a-f0-9]{64}$/.test(input.expectedRevision??''))throw fault('設定の保存要求が不正です。',400);
  const values=validateEngineSettings(engine,input.values);
  const current=await readEngineSettings(root,engine);
  if(current.revision!==input.expectedRevision)throw fault('設定が変更されました。再読込してください。');
  if(Object.keys(values).every(key=>values[key]===current.values[key]))return;
  const directory=join(root,'data/maintenance/engine-settings');
  await direct(directory,{missing:true});
  await mkdir(directory,{recursive:true});
  const backup=join(directory,engine+'-'+randomUUID());
  await mkdir(backup);
  if(engine==='ComfyUI'){
    const {env}=current;
    await writeNew(join(backup,'environment.json'),env.raw);
    await replace(env.path,encode({...env.value,comfyTuning:values}),env.revision);
    return;
  }
  const {config,receipt,locations}=current;
  const next=structuredClone(config.value);
  for(const [key,index] of Object.entries(locations))next.args[index]=String(values[key]);
  const nextConfig=encode(next),configSha256=hash(nextConfig);
  await writeNew(join(backup,'serve-config.json'),config.raw);
  await writeNew(join(backup,'installation.json'),receipt.raw);
  const nextReceipt=encode({...receipt.value,configSha256});
  await writeNew(join(backup,'hashes.json'),encode({beforeConfig:config.revision,afterConfig:configSha256,beforeReceipt:receipt.revision,afterReceipt:hash(nextReceipt)}));
  await replace(config.path,nextConfig,config.revision);
  try{await replace(receipt.path,nextReceipt,receipt.revision);}
  catch(error){
    // A crash leaves a mismatched receipt, which both Start-Strata and this
    // editor refuse. Only roll back the exact bytes owned by this transaction.
    if(hash(await readFile(receipt.path))===receipt.revision)await replace(config.path,config.raw,configSha256);
    throw error;
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [engine,root]=process.argv.slice(2);
  const chunks=[];
  try{
    for await(const chunk of process.stdin)chunks.push(chunk);
    await saveEngineSettings(resolve(root),engine,JSON.parse(Buffer.concat(chunks)));
    process.stdout.write('{}');
  }catch(error){
    process.stdout.write(JSON.stringify({status:error.status??503,error:error.status?error.message:'設定の保存結果を確認できません。再読込してください。'}));
  }
}
