import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ApiError} from './store.mjs';

const executeFile=promisify(execFile),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const ASSET_LIMITS=Object.freeze({maxUploadBytes:10*1024**2,maxBodyBytes:14*1024**2,maxCanonicalBytes:48*1024**2,maxDimension:4096,maxPixels:12_000_000});
const session=value=>{if(typeof value!=='string'||!value.trim()||value.length>160)throw new ApiError(400,'DSH sessionが不正です。');return value.trim();};
const purpose=value=>{if(!['reference','input'].includes(value))throw new ApiError(400,'画像の用途をreferenceまたはinputで指定してください。');return value;};
export async function assetDirectory(directory) {
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);let stat;
    try{stat=await lstat(cursor);}catch(error){if(error.code!=='ENOENT')throw error;try{await mkdir(cursor);}catch(e){if(e.code!=='EEXIST')throw e;}stat=await lstat(cursor);}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Asset directory contains a link or non-directory');
  }
  if((await realpath(absolute)).toLowerCase()!==absolute.toLowerCase())throw new Error('Asset directory resolves outside the configured location');
  return absolute;
}
async function writeOnce(filename,bytes) {
  const handle=await open(filename,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function checkedBytes(filename,expectedSha256,limit=ASSET_LIMITS.maxCanonicalBytes) {
  const stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('Asset file is unsafe or oversized');
  const bytes=await readFile(filename);if(sha256(bytes)!==expectedSha256)throw new Error('Immutable asset content changed');return bytes;
}
export class AssetStore {
  constructor({store,root,inputRoot,pythonExecutable,normalize=null}) {
    Object.assign(this,{store,root:path.resolve(root),inputRoot:path.resolve(inputRoot),pythonExecutable});
    this.directory=path.join(this.root,'data','assets');
    this.normalize=normalize??(async(source,destination)=>{
      const script=fileURLToPath(new URL('./asset-image.py',import.meta.url));
      const {stdout}=await executeFile(pythonExecutable,['-I','-B',script,source,destination],{windowsHide:true,timeout:30000,maxBuffer:32768,env:{...process.env,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}});
      return JSON.parse(stdout.trim());
    });
    store.db.exec('CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL)');
  }
  get(id,owner) {
    session(owner);if(!UUID.test(id??''))throw new ApiError(404,'この会話の画像がありません。');
    const row=this.store.db.prepare('SELECT session_id,json FROM assets WHERE id=?').get(id);
    if(!row||row.session_id!==owner)throw new ApiError(404,'この会話の画像がありません。');return JSON.parse(row.json);
  }
  list(owner){session(owner);return this.store.db.prepare('SELECT json FROM assets WHERE session_id=? ORDER BY rowid DESC LIMIT 100').all(owner).map(row=>JSON.parse(row.json));}
  async add(owner,input) {
    session(owner);purpose(input?.purpose);let bytes,provenance=null,mime=input.mime;
    if(input.sourceRunId!==undefined) {
      if(input.dataBase64!==undefined||!UUID.test(input.sourceRunId)||!/^[a-f0-9]{64}$/.test(input.artifactSha256??''))throw new ApiError(400,'生成画像の指定が不正です。');
      const run=this.store.get(input.sourceRunId),artifact=run?.artifacts?.find(item=>item.sha256===input.artifactSha256&&item.mime==='image/png');
      if(!artifact||run.sessionId!==owner)throw new ApiError(404,'この会話の生成画像がありません。');
      const expected=path.join(this.root,'outputs',run.id,artifact.name);
      if(path.resolve(artifact.path)!==path.resolve(expected))throw new Error('Artifact path differs from the owned output');
      await assetDirectory(path.dirname(expected));bytes=await checkedBytes(expected,artifact.sha256,ASSET_LIMITS.maxUploadBytes);mime='image/png';
      provenance={runId:run.id,artifactSha256:artifact.sha256};
    } else {
      if(typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(ASSET_LIMITS.maxUploadBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64))throw new ApiError(400,'画像bytesが不正または大きすぎます。');
      bytes=Buffer.from(input.dataBase64,'base64');
      if(bytes.toString('base64')!==input.dataBase64)throw new ApiError(400,'画像base64が正規形ではありません。');
    }
    if(!bytes.length||bytes.length>ASSET_LIMITS.maxUploadBytes||!['image/png','image/jpeg','image/webp'].includes(mime))throw new ApiError(400,'PNG/JPEG/WebP画像を10MiB以内で指定してください。');
    const id=randomUUID(),directory=await assetDirectory(path.join(this.directory,id));
    await writeOnce(path.join(directory,'original.bin'),bytes);
    const canonical=path.join(directory,'image.png');
    let dimensions;try{dimensions=await this.normalize(path.join(directory,'original.bin'),canonical);}catch{throw new ApiError(400,'画像を復号できないか、サイズ・形式が上限を超えています。');}
    if(dimensions.originalMime!==mime||dimensions.mime!=='image/png'||![dimensions.width,dimensions.height].every(n=>Number.isInteger(n)&&n>=16&&n<=4096)||dimensions.width*dimensions.height>ASSET_LIMITS.maxPixels)throw new ApiError(400,'画像の実形式または寸法が指定と一致しません。');
    const stat=await lstat(canonical);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>ASSET_LIMITS.maxCanonicalBytes)throw new ApiError(400,'変換後の画像が大きすぎます。');
    const png=await readFile(canonical);
    const asset={id,purpose:input.purpose,mime:'image/png',originalMime:mime,sha256:sha256(png),originalSha256:sha256(bytes),bytes:png.length,originalBytes:bytes.length,width:dimensions.width,height:dimensions.height,filename:typeof input.filename==='string'?input.filename.replace(/[\u0000-\u001f]/g,'').slice(0,160):'image',createdAt:new Date().toISOString(),provenance};
    this.store.db.prepare('INSERT INTO assets VALUES(?,?,?)').run(id,owner,JSON.stringify(asset));return asset;
  }
  async content(id,owner){const asset=this.get(id,owner);await assetDirectory(path.join(this.directory,id));return {asset,bytes:await checkedBytes(path.join(this.directory,id,'image.png'),asset.sha256)};}
  async binding(id,owner,requiredPurpose) {
    const {asset,bytes}=await this.content(id,owner);if(asset.purpose!==requiredPurpose)throw new ApiError(409,'画像の登録用途が制作での用途と一致しません。');
    if(requiredPurpose==='reference')return {id:asset.id,purpose:asset.purpose,sha256:asset.sha256,width:asset.width,height:asset.height};
    const subfolder=`controller-assets/${sha256(Buffer.from(owner)).slice(0,24)}`,filename=`${asset.id}-${asset.sha256}.png`;
    const directory=await assetDirectory(path.join(this.inputRoot,...subfolder.split('/'))),target=path.join(directory,filename);
    try{await writeOnce(target,bytes);}catch(error){if(error.code!=='EEXIST')throw error;await checkedBytes(target,asset.sha256);}
    return {id:asset.id,purpose:'input',sha256:asset.sha256,width:asset.width,height:asset.height,comfyInputName:`${subfolder}/${filename}`};
  }
  async verifyBinding(binding,owner) {
    const actual=await this.binding(binding.id,owner,binding.purpose);
    if(JSON.stringify(actual)!==JSON.stringify(binding))throw new Error('Stored asset binding differs from immutable asset');return actual;
  }
}

export async function assetRoute({req,res,path:route,assets,body,json}) {
  if(!route.startsWith('/api/assets'))return false;
  if(!assets)throw new ApiError(503,'画像入力の準備ができていません。');
  const owner=session(req.headers['x-dsh-session']);
  if(route==='/api/assets'&&req.method==='POST'){const asset=await assets.add(owner,await body(req,ASSET_LIMITS.maxBodyBytes));json(res,201,{asset});return true;}
  if(route==='/api/assets'&&req.method==='GET'){json(res,200,{assets:assets.list(owner),limits:ASSET_LIMITS});return true;}
  const match=route.match(/^\/api\/assets\/([a-f0-9-]{36})(\/content)?$/);
  if(match&&req.method==='GET'){
    if(!match[2])json(res,200,{asset:assets.get(match[1],owner)});
    else {const {bytes}=await assets.content(match[1],owner);res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length});res.end(bytes);}return true;
  }
  throw new ApiError(404,'画像入力APIがありません。');
}
