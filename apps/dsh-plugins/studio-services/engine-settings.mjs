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
const tuningArgs={kv:'--kv',poolWorkers:'--pool-workers',conversationCacheMiB:'--conversation-cache-mib',conversationCacheSlots:'--conversation-cache-slots'};
const visionFields={visionThreads:'threads',visionTokens:'max_tokens'};
const optionalRanges={poolWorkers:[1,32],conversationCacheMiB:[0,8192],conversationCacheSlots:[1,16],visionThreads:[1,32],visionTokens:[256,4096]};
const kvModes=['fp16','int8','k8v4','q4_0'];
const espFields=['espEnabled','espScale','espFirstLayer','espLastLayer'];
const espFlags={'--control-vector-scaled':1,'--control-vector-layer-range':2,'--cvec-mode':1,'--cvec-dir':1};
const vectorName='Qwen3.8-Flash-Next-experimental-speed-projection.gguf';
const vectorDigest='ef0724c5b79297e481017be85769832bc26eb220c984ecba2b0e1b0c8426312b';

export function validateEngineSettings(engine,values){
  const baseKeys=Object.keys(flags);
  const strataKeys=Object.keys(values??{}).length===baseKeys.length?baseKeys:[...baseKeys,...Object.keys(tuningArgs),...Object.keys(visionFields),...espFields];
  const keys=engine==='Strata'?strataKeys:engine==='ComfyUI'?Object.keys(defaults):[];
  if(!keys.length||!values||typeof values!=='object'||Array.isArray(values)||
    Object.keys(values).length!==keys.length||keys.some(key=>!Object.hasOwn(values,key)))throw fault('設定項目が一致しません。',400);
  for(const key of keys){
    const value=values[key];
    let valid;
    if(limits[key])valid=Number.isSafeInteger(value)&&inRange(value,...limits[key])&&(key!=='context'||value%1024===0);
    else if(optionalRanges[key])valid=value===null||Number.isSafeInteger(value)&&inRange(value,...optionalRanges[key]);
    else if(key==='kv')valid=value===null||kvModes.includes(value);
    else if(key==='espEnabled')valid=typeof value==='boolean'||value===null;
    else if(key==='espScale')valid=inRange(value,0.1,1)&&Math.abs(value*10-Math.round(value*10))<1e-8;
    else if(key==='espFirstLayer'||key==='espLastLayer')valid=Number.isSafeInteger(value)&&inRange(value,1,47);
    else if(key==='reserveGiB')valid=value===null||inRange(value,0.5,4)&&Number.isInteger(value*4);
    else valid=options[key].includes(value);
    if(!valid)throw fault('設定値が対応範囲外です: '+key,400);
  }
  if(engine==='Strata'&&values.espFirstLayer>values.espLastLayer)throw fault('ESPの開始レイヤーは終了レイヤー以下にしてください。',400);
  return Object.fromEntries(keys.map(key=>[key,values[key]]));
}

function argLocation(args,flag,count=1){
  const at=args.indexOf(flag);
  if(args.some(arg=>arg.startsWith(flag+'='))||at!==args.lastIndexOf(flag)||at>=0&&
    (args.length<=at+count||args.slice(at+1,at+1+count).some(arg=>!arg||arg.startsWith('--'))))throw Error('Ambiguous Strata argument: '+flag);
  return at;
}

function strataValues(config){
  if(!Array.isArray(config.args)||config.args.some(arg=>typeof arg!=='string'))throw Error('Unsupported Strata arguments');
  const locations=Object.fromEntries(Object.entries(flags).map(([key,flag])=>{
    const at=argLocation(config.args,flag);
    if(at<0)throw Error('Missing Strata argument: '+flag);
    return [key,at+1];
  }));
  const values=Object.fromEntries(Object.entries(locations).map(([key,at])=>[key,key==='prefill'?config.args[at]:Number(config.args[at])]));
  for(const [key,flag] of Object.entries(tuningArgs)){
    const at=argLocation(config.args,flag),raw=at<0?null:config.args[at+1];
    values[key]=raw===null||key==='kv'?raw:Number(raw);
  }
  for(const [key,field] of Object.entries(visionFields))values[key]=config.vision?.[field]??null;
  return {values,locations};
}

async function readProjection(config,installation,configPath){
  const defaults={espEnabled:null,espScale:1,espFirstLayer:4,espLastLayer:44};
  if(installation.model!=='qwen3.8-flash-next'||installation.modelSource?.repository?.toLowerCase()!=='unsloth/qwen3.8-flash-next-gguf')return {values:defaults};
  const path=join(installation.productRoot,'data/experimental-speed-projection',vectorName);
  const args=config.args;
  try{
    await direct(path);
    const file=await lstat(path);
    if(!file.isFile()||file.size!==483520)return {values:defaults};
    if(hash(await readFile(path))!==vectorDigest)return {values:defaults};
    // Strata's shared settings take precedence over the startup sampling defaults.
    const shared=(await json(configPath.replace(/\.json$/,'.shared-settings.json')).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    }))?.value;
    if(typeof shared?.experimental_speed_projection==='boolean')return {values:defaults};
    if(args.some(arg=>arg==='--control-vector'||arg.startsWith('--control-vector=')))return {values:defaults};
    const [vector,range,mode,direction]=Object.entries(espFlags).map(([flag,count])=>argLocation(args,flag,count));
    const configured=vector>=0;
    if(configured){
      const argument=args[vector+1],sep=argument.lastIndexOf(':');
      if(!samePath(argument.slice(0,sep),path)||range<0||mode<0||direction<0||args[mode+1]!=='project'||args[direction+1]!=='per-layer')return {values:defaults};
      defaults.espScale=Number(argument.slice(sep+1));
      defaults.espFirstLayer=Number(args[range+1]);defaults.espLastLayer=Number(args[range+2]);
      if(!inRange(defaults.espScale,0.1,1)||Math.abs(defaults.espScale*10-Math.round(defaults.espScale*10))>1e-8||
        ![defaults.espFirstLayer,defaults.espLastLayer].every(n=>Number.isInteger(n)&&inRange(n,1,47))||defaults.espFirstLayer>defaults.espLastLayer){
        return {values:{espEnabled:null,espScale:1,espFirstLayer:4,espLastLayer:44}};
      }
    }else if([range,mode,direction].some(at=>at>=0))return {values:defaults};
    defaults.espEnabled=configured&&config.sampling?.experimental_speed_projection!==false;
    return {values:defaults,path,configured};
  }catch(error){if(error.code==='ENOENT'||!error.code)return {values:defaults};throw error;}
}

function applyProjection(config,projection,values){
  if(!projection.path||values.espEnabled===null)throw fault('このモデルまたは制御ベクトルのESPは変更できません。',400);
  if(projection.configured){
    if(values.espScale!==projection.values.espScale)config.args[config.args.indexOf('--control-vector-scaled')+1]=projection.path+':'+values.espScale;
    if(values.espFirstLayer!==projection.values.espFirstLayer||values.espLastLayer!==projection.values.espLastLayer){
      config.args.splice(config.args.indexOf('--control-vector-layer-range')+1,2,String(values.espFirstLayer),String(values.espLastLayer));
    }
  }else if(values.espEnabled){
    config.args.push('--control-vector-scaled',projection.path+':'+values.espScale,'--control-vector-layer-range',
      String(values.espFirstLayer),String(values.espLastLayer),'--cvec-mode','project','--cvec-dir','per-layer');
  }else throw fault('ESPを有効にしてから強度または適用レイヤーを保存してください。',400);
  if(!values.espEnabled)config.sampling={...config.sampling,experimental_speed_projection:false};
  else if(config.sampling&&Object.hasOwn(config.sampling,'experimental_speed_projection')){
    delete config.sampling.experimental_speed_projection;
    if(!Object.keys(config.sampling).length)delete config.sampling;
  }
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
  const {values,locations}=strataValues(config.value),projection=await readProjection(config.value,value,config.path);
  return {revision:hash(config.revision+receipt.revision),launchRevision:config.revision,receipt,config,locations,projection,
    values:{...values,...projection.values},editable:{vision:Boolean(config.value.vision)}};
}

export async function saveEngineSettings(root,engine,input){
  if(!input||typeof input!=='object'||!Object.hasOwn(input,'values')||Object.keys(input).length!==2||
    !/^[a-f0-9]{64}$/.test(input.expectedRevision??''))throw fault('設定の保存要求が不正です。',400);
  const values=validateEngineSettings(engine,input.values);
  const current=await readEngineSettings(root,engine);
  if(current.revision!==input.expectedRevision)throw fault('設定が変更されました。再読込してください。');
  const changed=key=>Object.hasOwn(values,key)&&values[key]!==current.values[key];
  if(!Object.keys(values).some(changed))return;
  let next;
  if(engine==='Strata'){
    const {config,locations,projection}=current;
    next=structuredClone(config.value);
    for(const [key,index] of Object.entries(locations))if(changed(key))next.args[index]=String(values[key]);
    for(const [key,flag] of Object.entries(tuningArgs)){
      if(!changed(key))continue;
      const at=argLocation(next.args,flag),value=values[key];
      if(at>=0)next.args.splice(at,2,...(value===null?[]:[flag,String(value)]));
      else if(value!==null)next.args.push(flag,String(value));
    }
    if(changed('kv')&&values.kv==='k8v4'&&next.args.some(arg=>arg==='--kv-resident'||arg.startsWith('--kv-resident='))){
      throw fault('K8V4は既存のKVストリーミング設定と併用できません。',400);
    }
    for(const [key,field] of Object.entries(visionFields)){
      if(!changed(key))continue;
      if(!current.editable.vision)throw fault('画像エンコーダーが設定されていません。',400);
      if(values[key]===null)delete next.vision[field];
      else next.vision[field]=values[key];
    }
    if(changed('visionTokens')&&Number(next.vision?.min_tokens)>Number(next.vision?.max_tokens??(next.vision?.gpu?1024:300)))throw fault('画像トークン上限が既存の最小値を下回っています。',400);
    if(espFields.some(changed))applyProjection(next,projection,values);
  }
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
  const {config,receipt}=current;
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
