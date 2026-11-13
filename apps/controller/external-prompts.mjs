// Official upstream prompt text is private runtime data, not source code.
// Read fixed, hash-pinned prompts from the configured ComfyUI installation.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';

export const EXTERNAL_PROMPTS=Object.freeze({
  moss:Object.freeze({t2i:Object.freeze({file:'official-t2i-enhancer-system.txt',sha256:'87d45638f0c17ad25d38c24a63c7aa7a71316388eb40065c09850e8801b55f85',sourceFile:'image_moss_image_t2i.json',sourceSha256:'91d76c158a1e427c09904c6222978065c1ed965c8b3f40ae323e649808af2198',nodeId:14})}),
  qwen:Object.freeze({
    t2i:Object.freeze({file:'official-t2i-enhancer-system.txt',sha256:'0b8b261455e2a8c48757bdad7c3cb71173c67ab7b5ab7042a2635fd76a6fb2bf',sourceFile:'image_qwen_image_2_1_t2i.json',sourceSha256:'5f2b50eeaf27e56a45456681ad5319df1ae51243d9653ac3f92c7dc05d1e1503',nodeId:475}),
    edit:Object.freeze({file:'official-edit-enhancer-system.txt',sha256:'eaff356cd2bdbcfd1aaf20502b5ccd8cbad16fa6e9afe41e3166eeee299c8e59',sourceFile:'image_qwen_image_2_1_image_edit.json',sourceSha256:'c1e6551759de131f083a040da072ac6f032c3c8401ceca202412cd912897d0fc',nodeId:479}),
  }),
});

export function readExternalPrompt(family,mode){
  const spec=Object.hasOwn(EXTERNAL_PROMPTS,family)&&Object.hasOwn(EXTERNAL_PROMPTS[family],mode)?EXTERNAL_PROMPTS[family][mode]:null;
  if(!spec)throw new Error('Unsupported official prompt family or mode');
  const root=process.env.MEDIA_STUDIO_HOME;
  if(typeof root!=='string'||!root||!isAbsolute(root))throw new Error('Official prompt unavailable: MEDIA_STUDIO_HOME must be an absolute private runtime directory');
  const directory=family==='moss'?'moss-image':'qwen-image-2.1';
  let settings;
  try {
    settings=JSON.parse(readFileSync(join(root,'config','environment.json'),'utf8'));
  } catch (error) {
    if (error.code!=='ENOENT') throw error;
  }
  const comfyDirectory=settings?.comfyWorkflowLayout==='product' ? settings.comfyDirectory : undefined;
  if (settings?.comfyWorkflowLayout==='product' && (typeof comfyDirectory!=='string'||!isAbsolute(comfyDirectory))) throw new Error('ComfyUI product path must be absolute');
  const source=comfyDirectory===undefined ? join(root,'external','comfy-workflow-templates','workflows','source')
    : join(comfyDirectory,'user','media-studio','official','workflows','source');
  const path=join(source,directory,spec.file);
  let bytes;
  try{bytes=readFileSync(path);}catch{throw new Error('Official prompt unavailable in the private runtime');}
  if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw new Error('Official prompt hash mismatch');
  return {text:bytes.toString('utf8'),sha256:spec.sha256};
}
