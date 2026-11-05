import {win32} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Check capabilities as well as the supported major. A Node shim that starts a
// different executable cannot be used for managed PID/path identity checks.
export const CONTROLLER_NODE_PROBE = `import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(':memory:');
try { db.exec('CREATE TABLE t(v INTEGER); BEGIN IMMEDIATE');db.prepare('INSERT INTO t VALUES(?)').run(1);db.exec('COMMIT');
  if(db.prepare('SELECT v FROM t').all()[0]?.v!==1 || db.prepare('SELECT v FROM t').get()?.v!==1 || typeof fetch!=='function' || typeof AbortSignal.any!=='function') throw Error('Missing runtime capability');
  process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,executable:process.execPath}));
} finally { db.close(); }`;

const absolute=value=>{
  if(typeof value!=='string'||value!==value.trim()||!win32.isAbsolute(value)||!/^[a-z]:[\\/]/i.test(value)||/[\u0000-\u001f<>"|?*]/.test(value)||value.slice(2).includes(':'))throw Error('Invalid managed executable path');
  return win32.normalize(value);
};
export function controllerNodeExecutable(root,environment){
  const result=absolute(environment.controllerNodeExecutable??win32.join(root,environment.nodeDirectory,'node.exe'));
  if(win32.basename(result).toLowerCase()!=='node.exe')throw Error('Controller Node must be an explicit local node.exe');
  return result;
}
export async function validateControllerNodeRuntime(executable,{run=promisify(execFile)}={}){
  const expected=absolute(executable);
  if(win32.basename(expected).toLowerCase()!=='node.exe')throw Error('Controller Node must be an explicit local node.exe');
  const environment={...process.env};delete environment.NODE_OPTIONS;
  let result;
  try {
    const output=await run(expected,['--no-warnings','--input-type=module','-e',CONTROLLER_NODE_PROBE],{windowsHide:true,timeout:10000,maxBuffer:16384,env:environment});
    result=JSON.parse(output.stdout);
  } catch { throw Error('Controller Node 24 and its required capabilities could not be verified'); }
  if(!/^24\.\d+\.\d+$/.test(result?.version??'')||result.platform!=='win32'||result.arch!=='x64'||typeof result.executable!=='string'||absolute(result.executable).toLowerCase()!==expected.toLowerCase())throw Error('Controller Node must be a direct Windows x64 Node 24 executable');
  return {version:result.version,executable:expected};
}
export function strataPythonExecutable(environment,receipt){
  if(typeof receipt?.control!=='string'||receipt.prepared!==true||receipt.schemaVersion!==1)throw Error('Strata installation receipt is unavailable');
  const product=absolute(environment.strataDirectory??receipt.productRoot);
  if(absolute(receipt.productRoot).toLowerCase()!==product.toLowerCase()||!absolute(receipt.control).toLowerCase().startsWith(win32.join(product,'.runtime','terminal').toLowerCase()+'\\'))throw Error('Strata product identity differs');
  const expected=absolute(win32.join(receipt.control,'python','python.exe'));
  const result=absolute(environment.strataPythonExecutable??expected);
  if(result.toLowerCase()!==expected.toLowerCase())throw Error('Strata Python differs from its prepared installation');
  return result;
}
