import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readEngineSettings } from './engine-settings.mjs';

const execute = promisify(execFile);
const version = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const sha = /^[a-f0-9]{40}$/;
const comfyRepo = 'https://github.com/Comfy-Org/ComfyUI.git';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root,file) => { const value=relative(root,file); return value&&!isAbsolute(value)&&value!=='..'&&!value.startsWith('..'+sep); };
const json = async file => JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const fault = (message,status=409) => Object.assign(Error(message),{status});
const uncertain = message => Object.assign(fault(message,503),{uncertain:true});
const newer = (a,b) => {
  const left=version.exec(a), right=version.exec(b);
  if(!left||!right)return false;
  for(let i=1;i<=3;i++)if(Number(left[i])!==Number(right[i]))return Number(left[i])>Number(right[i]);
  return false;
};

async function direct(path) {
  if(!isAbsolute(path)||path.startsWith('\\\\')||resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase()||(await lstat(path)).isSymbolicLink())throw fault('製品パスの実体を確認できません。');
  return path;
}

async function comfyFacts(root) {
  const settings=await readEngineSettings(root,'ComfyUI');
  const directory=await direct(settings.env.value.comfyDirectory);
  const file=await direct(join(directory,'comfyui_version.py'));
  const installed=/^__version__\s*=\s*["']([^"']+)["']/m.exec(await readFile(file,'utf8'))?.[1];
  if(!version.test(installed??''))throw fault('ComfyUIの導入版を確認できません。');
  return {directory,installed,settings};
}

async function strataFacts(root) {
  const settings=await readEngineSettings(root,'Strata');
  const receipt=settings.receipt.value, product=await direct(receipt.productRoot);
  const control=await direct(receipt.control), engine=await direct(receipt.engine);
  if(!inside(join(product,'.runtime','terminal'),control)||!inside(join(product,'.runtime','components','engine'),engine))throw fault('Strataの導入構成を確認できません。');
  const report=await json(await direct(join(engine,'engine-component.json')));
  const controlVersion=(await readFile(await direct(join(control,'VERSION')),'utf8')).trim();
  if(!version.test(report.version??'')||!version.test(controlVersion))throw fault('Strataの導入版を確認できません。');
  return {settings,product,control,engine,installed:report.version,controlVersion};
}

export async function installedEngineVersion(root,engine){
  try{
    const facts=await (engine==='ComfyUI'?comfyFacts(root):strataFacts(root));
    return {installed:facts.installed,...(engine==='Strata'&&{control:facts.controlVersion})};
  }catch{return null;}
}

async function git(directory,args,run){
  return (await run('git.exe',['-C',directory,'-c','core.hooksPath=NUL','-c','core.fsmonitor=false',...args],{
    cwd:directory,windowsHide:true,timeout:120000,maxBuffer:1048576,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'},
  })).stdout.trim();
}

async function latestTag(repository,fetcher){
  const response=await fetcher(`https://api.github.com/repos/${repository}/releases/latest`,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)throw fault('公式リリースを確認できません。',503);
  const release=await response.json(),tag=release.tag_name;
  if(!version.test(tag??'')||!tag.startsWith('v')||release.draft||release.prerelease)throw fault('公式の安定版を確認できません。');
  return tag;
}

async function strataCommand(info,feed,args,run){
  const python=await direct(join(info.control,'python','python.exe')),entry=await direct(join(info.control,'strata.py'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^STRATA_|^PYTHON(?:PATH|HOME)$/i.test(key)));
  Object.assign(env,{PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'});
  const {stdout}=await run(python,[entry,'update','--feed',feed,'--components-dir',join(info.product,'.runtime','components'),'--no-control','--output','json',...args],{
    cwd:info.control,windowsHide:true,timeout:args.includes('--check')?25000:25*60000,maxBuffer:1048576,env,
  });
  const value=JSON.parse(stdout);if(value.schema_version!==1||value.ok!==true)throw fault('Strataの公式更新結果を確認できません。');return value;
}

async function checkComfy(info,fetcher,run){
  const remote=await git(info.directory,['remote','get-url','origin'],run);
  if(![comfyRepo,comfyRepo.slice(0,-4),'https://github.com/comfyanonymous/ComfyUI.git'].includes(remote))throw fault('ComfyUIの公式Gitクローンを指定してください。');
  const tag=await latestTag('Comfy-Org/ComfyUI',fetcher);
  const refs=await git(info.directory,['ls-remote',comfyRepo,`refs/tags/${tag}`,`refs/tags/${tag}^{}`],run);
  const matches=refs.split(/\r?\n/).map(row=>row.split('\t'));
  const commit=(matches.find(([,ref])=>ref===`refs/tags/${tag}^{}`)??matches.find(([,ref])=>ref===`refs/tags/${tag}`))?.[0];
  if(!sha.test(commit??''))throw fault('ComfyUIのリリースコミットを確認できません。');
  return {installed:info.installed,available:tag,canUpdate:newer(tag,info.installed),identity:commit};
}

async function checkStrata(info,run,fetcher){
  const tag=await latestTag('Niko1221/Strata',fetcher);
  const feed=`https://github.com/Niko1221/Strata/releases/download/${tag}/strata-feed.json`;
  const report=await strataCommand(info,feed,['--check'],run),candidate=report.engine?.offered;
  const installed=report.engine?.installed;
  const available=version.test(candidate?.version??'')?candidate.version:null;
  return {feed,candidate,offer:{installed:info.installed,control:info.controlVersion,available,
    canUpdate:report.engine?.status==='available'&&available!==null&&newer(available,info.installed)&&installed?.folder===basename(info.engine)&&candidate.backend===installed.backend&&candidate.variant===installed.variant&&typeof candidate.build_id==='string'&&[candidate.sha256,candidate.manifest_sha256].every(value=>/^[a-f0-9]{64}$/.test(value??'')),
    identity:candidate?.sha256??null}};
}

export async function checkEngineUpdate(root,engine,{run=execute,fetcher=fetch}={}){
  return engine==='ComfyUI'?checkComfy(await comfyFacts(root),fetcher,run):(await checkStrata(await strataFacts(root),run,fetcher)).offer;
}

async function replace(file,expected,next){
  const staged=file+'.'+randomUUID()+'.partial';
  try{
    await writeFile(staged,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
    if(digest(await readFile(file))!==expected)throw fault('更新の準備中に設定が変更されました。');
    await rename(staged,file);
  }finally{await unlink(staged).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

async function updateComfy(root,offer,run,fetcher){
  const info=await comfyFacts(root),dir=info.directory;
  if(await git(dir,['status','--porcelain','--untracked-files=no'],run))throw fault('ComfyUIの追跡ファイルにローカル変更があります。');
  const before=await git(dir,['rev-parse','HEAD'],run);
  if(!sha.test(before))throw fault('ComfyUIの現在のコミットを照合できません。');
  const current=await checkComfy(info,fetcher,run);
  if(!current.canUpdate||current.identity!==offer)throw fault('更新候補が変わりました。再確認してください。');
  await git(dir,['fetch','--no-tags',comfyRepo,`refs/tags/${current.available}`],run);
  const target=await git(dir,['rev-parse','FETCH_HEAD^{commit}'],run);
  if(target!==offer)throw fault('リリースの内容が確認時から変わりました。');
  try{await git(dir,['merge-base','--is-ancestor',before,target],run);}
  catch(error){if(error.code===1)throw fault('ComfyUIの現在の履歴から公式リリースへ早送りできません。');throw error;}
  const python=await direct(info.settings.env.value.comfyPythonExecutable);
  if(!inside(dir,python)||basename(python).toLowerCase()!=='python.exe')throw fault('ComfyUI専用のPythonが必要です。');
  await run(python,['-I','-m','pip','check'],{cwd:tmpdir(),windowsHide:true,timeout:30000,maxBuffer:1048576});
  const requirements=await git(dir,['show',`${target}:requirements.txt`],run);
  // Qualify the target's requirements against the installed environment. This
  // route never replaces a pinned CUDA stack or installs third-party code.
  const validateRequirements=`import importlib.metadata as md, json, sys
from pip._vendor.packaging.requirements import Requirement
missing = []
for line in json.loads(sys.argv[1]).splitlines():
    line = line.split('#', 1)[0].strip()
    if not line:
        continue
    req = Requirement(line)
    if req.url:
        raise ValueError('Direct URL dependency')
    if req.marker and not req.marker.evaluate():
        continue
    try:
        current = md.version(req.name)
        if not req.specifier.contains(current, prereleases=True):
            missing.append(req.name)
    except md.PackageNotFoundError:
        missing.append(req.name)
print(json.dumps(missing))`;
  const checked=await run(python,['-I','-c',validateRequirements,JSON.stringify(requirements)],{cwd:tmpdir(),windowsHide:true,timeout:30000,maxBuffer:262144});
  const mismatches=JSON.parse(checked.stdout);
  if(!Array.isArray(mismatches)||mismatches.length)throw fault('更新版に必要なPython依存関係が揃っていません。ComfyUIの専用環境を保守手順で更新してください。');
  const expectedFile=await git(dir,['show',`${target}:comfyui_version.py`],run);
  if(/^__version__\s*=\s*["']([^"']+)["']/m.exec(expectedFile)?.[1]!==current.available.slice(1))throw fault('ComfyUIのタグと製品版が一致しません。');
  if((await git(dir,['rev-parse','HEAD'],run))!==before||await git(dir,['status','--porcelain','--untracked-files=no'],run))throw fault('ComfyUIのチェックアウトが更新中に変更されました。');
  await git(dir,['merge','--ff-only','--no-edit',target],run);
  if((await git(dir,['rev-parse','HEAD'],run))!==target)throw uncertain('ComfyUIの更新後コミットを確認できません。');
}

async function updateStrata(root,offer,run,fetcher){
  const info=await strataFacts(root),current=await checkStrata(info,run,fetcher);
  if(!current.offer.canUpdate||current.offer.identity!==offer)throw fault('署名付き更新候補が変わりました。再確認してください。');
  const receipt=info.settings.receipt,config=info.settings.config;
  if(config.value.exe!=='component:strata-engine'||digest(await readFile(receipt.path))!==receipt.revision||digest(await readFile(config.path))!==config.revision)throw fault('Strataの起動設定が更新経路と一致しません。');
  const report=await strataCommand(info,current.feed,['--yes','--model-config',config.path],run).catch(()=>{throw uncertain('Strataの公式更新結果を確認できません。');});
  const candidate=report.results?.find(row=>row.component==='engine'&&row.status==='updated')?.installed_after;
  if(candidate?.signed!==true||['version','backend','variant','build_id'].some(key=>candidate[key]!==current.candidate[key])||!/^[\w.-]{1,160}$/.test(candidate.folder??'')||candidate.folder==='.'||candidate.folder==='..')throw uncertain('Strataの更新結果を照合できません。');
  const engine=await direct(join(info.product,'.runtime','components','engine',candidate.folder));
  const manifest=await readFile(await direct(join(engine,'engine-component.json')));
  if(digest(manifest)!==current.candidate.manifest_sha256)throw uncertain('Strataの更新後マニフェストが照合時の候補と一致しません。');
  if(digest(await readFile(config.path))!==config.revision)throw uncertain('Strataの起動設定が更新中に変更されました。');
  await writeFile(receipt.path+'.before-update-'+randomUUID(),receipt.raw,{flag:'wx',mode:0o600});
  await replace(receipt.path,receipt.revision,{...receipt.value,engine,engineArchiveSha256:offer,runtimeTested:false});
}

export async function applyEngineUpdate(root,engine,offer,{run=execute,fetcher=fetch}={}){
  return engine==='ComfyUI'?updateComfy(root,offer,run,fetcher):updateStrata(root,offer,run,fetcher);
}
