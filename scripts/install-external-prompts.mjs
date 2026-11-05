// Offline import of the three exact upstream prompt texts. This script never
// downloads sources and never overwrites a different existing runtime file.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {EXTERNAL_PROMPTS} from '../apps/controller/external-prompts.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const packageRoot=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const normalized=value=>process.platform==='win32'?value.toLowerCase():value;
function inside(root,path){const part=relative(normalized(root),normalized(path));return part===''||(!part.startsWith('..'+sep)&&part!=='..'&&!isAbsolute(part));}
function directory(path){const item=lstatSync(path);if(item.isSymbolicLink()||!item.isDirectory())throw Error('A selected directory is missing or redirected');return realpathSync(path);}
function regular(path,max){const item=lstatSync(path);if(item.isSymbolicLink()||!item.isFile()||item.size>max)throw Error('The official source file is missing, redirected or too large');return readFileSync(path);}
function extract(source,spec){
  if(sha(source)!==spec.sourceSha256)throw Error('Official workflow hash mismatch');
  const root=JSON.parse(source.toString('utf8')),matches=[];
  const walk=value=>{if(!value||typeof value!=='object')return;if(value.id===spec.nodeId&&value.type==='PrimitiveStringMultiline')matches.push(value);for(const child of Object.values(value))walk(child);};
  walk(root);
  const node=matches[0],value=node?.widgets_values?.[0];
  if(matches.length!==1||typeof value!=='string'||node?.widgets_values_named?.value!==value||sha(Buffer.from(value,'utf8'))!==spec.sha256)throw Error('Official prompt extraction differs from the pinned source');
  return Buffer.from(value,'utf8');
}
function checkTarget(root,segments){
  let path=root;
  for(const segment of segments){path=join(path,segment);if(existsSync(path)){const item=lstatSync(path);if(item.isSymbolicLink()||!item.isDirectory())throw Error('External asset directory is redirected or not a directory');}}
  return path;
}

export function installExternalPrompts({sourceDir,runtimeRoot}){
  if(!isAbsolute(sourceDir??'')||!isAbsolute(runtimeRoot??''))throw Error('Both source and private runtime directories must be absolute');
  const source=directory(resolve(sourceDir)),runtime=directory(resolve(runtimeRoot));
  if(inside(packageRoot,runtime))throw Error('The private runtime must not be inside this source repository');
  const plans=[];
  for(const [family,mode,folder] of [['moss','t2i','moss-image'],['qwen','t2i','qwen-image-2.1'],['qwen','edit','qwen-image-2.1']]){
    const spec=EXTERNAL_PROMPTS[family][mode],bytes=extract(regular(join(source,spec.sourceFile),2*1024*1024),spec);
    const parent=checkTarget(runtime,['external','comfy-workflow-templates','workflows','source',folder]),target=join(parent,spec.file);
    if(existsSync(target)){const existing=regular(target,65536);if(sha(existing)!==spec.sha256)throw Error('Existing external prompt differs; no file was replaced');}
    plans.push({parent,target,bytes,sha256:spec.sha256});
  }
  let created=0;
  for(const plan of plans){
    if(existsSync(plan.target))continue;
    mkdirSync(plan.parent,{recursive:true});
    // Recheck after creation; never follow a redirected parent supplied by a
    // previous or concurrent setup operation.
    if(!inside(runtime,realpathSync(plan.parent))||lstatSync(plan.parent).isSymbolicLink())throw Error('External prompt parent escaped the private runtime');
    writeFileSync(plan.target,plan.bytes,{flag:'wx',mode:0o600});created++;
    if(sha(regular(plan.target,65536))!==plan.sha256)throw Error('Written external prompt differs from the source');
  }
  return {verified:plans.length,created};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==4)throw Error('Usage: node install-external-prompts.mjs <official-templates-directory> <private-runtime-directory>');console.log(JSON.stringify(installExternalPrompts({sourceDir:process.argv[2],runtimeRoot:process.argv[3]})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
