// Source-only package gate. No host, network, model or user-data access.
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,extname,win32} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const pluginSets=Object.freeze({
  '@n3dypop/dsh-plugins':['studio-appearance','studio-image-viewer','studio-sessions','studio-host'],
  '@n3dypop/media-studio':['local-genai','media-results','studio-controls','studio-monitor','studio-preset','studio-services'],
});
const privateRoots=new Set(['node_modules','.runtime','runtime','data','models','inputs','input','outputs','output','logs','cache','coverage','dist','tmp','temp','credentials','.venv']);
const privateDocuments=/^docs\/(?:archives|backups|exports|reports|screenshots|temp)\//;
const privateBinary=/\.(?:exe|dll|pyd|so|dylib|db|sqlite|sqlite3|gguf|safetensors|pth|pt|mp4|webm|mov|png|jpe?g|webp|zip|7z)$/i;
const personalPath=/[a-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/i;
const sourceExtension=new Set(['.mjs','.js','.cjs']);
const textExtension=new Set(['.mjs','.js','.cjs','.json','.md','.txt','.yml','.yaml','.ps1','.cmd','.toml','.py','.rs','.lock']);
const developmentWorkspaceMarker=['local','image','environment'].join('-');
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&!part.startsWith('..'+win32.sep)&&!part.startsWith('../')&&part!=='..'&&!isAbsolute(part);};
const slash=value=>value.replaceAll('\\','/');

export function literalImports(text){
  const found=[];
  for(const expression of [/\bfrom\s*(['"])([^'"\r\n]+)\1/g,/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,/\bimport\s+(['"])([^'"\r\n]+)\1/g]){
    for(const match of text.matchAll(expression))found.push(match[2]);
  }
  return [...new Set(found)];
}

export async function checkPackage({root=resolve(import.meta.dirname,'..'),syntax=true}={}){
  root=resolve(root);
  if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw Error('Package root must not be a link');
  const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8')),plugins=pluginSets[metadata.name];
  if(!plugins||metadata.private!==true||metadata.license!=='MIT'||metadata.type!=='module')throw Error('Package metadata contract is invalid');
  const required=['README.md','LICENSE','THIRD_PARTY_NOTICES.md','dsh.bundle.patch.yml','docs/configuration.md','docs/licenses/DeepSeek-Harness-MIT.txt',...plugins.flatMap(id=>['package.json','index.mjs'].map(name=>'apps/dsh-plugins/'+id+'/'+name))];
  if(metadata.name.endsWith('/dsh-plugins'))required.push(...['OFL.txt','source.json','NotoSansJP-Variable.ttf'].map(name=>'apps/dsh-plugins/studio-appearance/fonts/'+name));
  else required.push('docs/licenses/Comfy-Org-MIT.txt','apps/controller/native/system-probe/Cargo.toml','apps/controller/native/system-probe/Cargo.lock','apps/controller/native/system-probe/src/main.rs','apps/controller/native/system-probe/README.md','apps/controller/native/system-probe/LICENSE','apps/controller/native/system-probe/THIRD_PARTY_NOTICES.md',...['windows-MIT.txt','serde-MIT.txt','memchr-MIT.txt'].map(name=>'apps/controller/native/system-probe/licenses/'+name),'scripts/Build-NativeProbe.ps1','scripts/Package-NativeProbe.ps1','.github/workflows/build-native.yml','tests/Test-NativePackage.ps1');
  for(const path of required){const info=await lstat(join(root,path));if(info.isSymbolicLink()||!info.isFile())throw Error('Required file is missing or linked: '+path);}
  const files=[];
  async function walk(directory){
    for(const name of (await readdir(directory)).sort()){
      const path=join(directory,name),rel=slash(relative(root,path)),info=await lstat(path);
      if(info.isSymbolicLink())throw Error('Linked package entry: '+rel);
      if(directory===root&&name==='.git'){if(!info.isDirectory())throw Error('External Git metadata is not supported');continue;}
      if(name==='node_modules'||name==='target'||directory===root&&privateRoots.has(name)||privateDocuments.test(rel)||/^workflows\/drafts(?:\/|$)/.test(rel)||/(?:^|\/)(?:auth-token|dsh-token|\.env(?:\..*)?)$/.test(rel)&&!rel.endsWith('.env.example'))throw Error('Private/runtime entry in package: '+rel);
      if(info.isDirectory())await walk(path);
      else if(info.isFile()){if(privateBinary.test(name)||/\.(?:log|partial|pid|pyc)$/.test(name)||/(?:private-baseline|final-audit|browser-current)\.json$/.test(name))throw Error('Runtime artifact in package: '+rel);files.push({path,rel});}
      else throw Error('Unsupported package entry: '+rel);
    }
  }
  await walk(root);
  let modules=0;
  for(const {path,rel}of files){
    const extension=extname(path).toLowerCase();
    if(!textExtension.has(extension)&&!['LICENSE','.gitignore','npmrc'].includes(relative(root,path)))continue;
    const text=await readFile(path,'utf8');
    if(personalPath.test(text))throw Error('Personal machine path in public source: '+rel);
    if(extension==='.rs'&&text.toLowerCase().includes(developmentWorkspaceMarker))throw Error('Development workspace coupling in Rust source: '+rel);
    if(extension==='.json'){try{JSON.parse(text);}catch{throw Error('Invalid JSON: '+rel);}}
    if(sourceExtension.has(extension)){
      modules++;
      if(text.toLowerCase().includes(developmentWorkspaceMarker))throw Error('Development workspace coupling in source: '+rel);
      for(const specifier of literalImports(text)){
        if(specifier.startsWith('file:')||isAbsolute(specifier)||win32.isAbsolute(specifier))throw Error('Absolute source import in '+rel);
        if(!specifier.startsWith('.'))continue;
        const target=resolve(fileURLToPath(new URL(specifier,pathToFileURL(path))));
        if(!inside(root,target))throw Error('Relative import escaped package: '+rel);
        const targetInfo=await lstat(target);if(!targetInfo.isFile()||targetInfo.isSymbolicLink())throw Error('Relative import is not a local source file: '+rel);
      }
      for(const match of text.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)){
        if(!match[2].startsWith('.'))continue;
        const target=resolve(fileURLToPath(new URL(match[2],pathToFileURL(path))));
        if(target!==root&&!inside(root,target))throw Error('Static file URL escaped package: '+rel);
      }
      if(syntax){
        // This one maintained fragment contains a catalog substitution, not a
        // standalone entry. Parse it with a harmless literal in function scope;
        // the assembled shipped client is checked separately as a real module.
        const fragment=rel==='apps/dsh-plugins/studio-sessions/workspace-client.js';
        const parts=fragment?text.split('/* WORKSPACE_CATALOG */'):null;
        if(fragment&&parts.length!==2)throw Error('Workspace client catalog marker is invalid');
        const input=fragment?'function workspaceFragment(){\n'+parts.join('null')+'\n}':undefined;
        try{execFileSync(process.execPath,fragment?['--check','--input-type=module']:['--check',path],{input,stdio:'pipe',windowsHide:true,timeout:15000});}catch{throw Error('JavaScript syntax check failed: '+rel);}
      }
    }
  }
  if(metadata.name.endsWith('/dsh-plugins')){
    const session=join(root,'apps/dsh-plugins/studio-sessions'),[library,workspace,client]=await Promise.all(['library-client.js','workspace-client.js','client.js'].map(name=>readFile(join(session,name),'utf8'))),outer=library.split('/* STUDIO_WORKSPACE_CLIENT */'),inner=workspace.split('/* WORKSPACE_CATALOG */');
    if(outer.length!==2||inner.length!==2)throw Error('Session client build markers are invalid');
    const prefix=outer[0]+inner[0],suffix=inner[1]+outer[1],start=client.indexOf(prefix);
    if(start<0||!client.endsWith(suffix))throw Error('Shipped session client differs from maintained fragments');
    try{JSON.parse(client.slice(start+prefix.length,client.length-suffix.length));}catch{throw Error('Shipped session catalog is invalid');}
    const directory=join(root,'apps/dsh-plugins/studio-appearance/fonts'),source=JSON.parse(await readFile(join(directory,'source.json'),'utf8'));
    if(source.license!=='SIL Open Font License 1.1'||!Array.isArray(source.assets))throw Error('Font provenance is missing');
    for(const asset of source.assets){const path=resolve(directory,asset.file);if(!inside(directory,path))throw Error('Font provenance escaped asset directory');const bytes=await readFile(path);if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Bundled font or its license differs from provenance');}
  }
  return{name:metadata.name,plugins:plugins.length,files:files.length,modules,syntaxChecked:syntax};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await checkPackage()));}catch(error){console.error(error.message);process.exitCode=1;}
}
