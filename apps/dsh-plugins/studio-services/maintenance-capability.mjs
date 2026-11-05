// Explicitly provisioned local maintenance capability. No paths, hashes or
// secrets come from an HTTP request. Absence means no route is registered.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMaintenanceOwnerVerifier} from './maintenance-owner.mjs';
import {probeWindowsEpoch,validateEpochEvidence} from '../../controller/epoch.mjs';
const defaultInstallationRoot=fileURLToPath(new URL('../../../',import.meta.url));
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&win32.normalize(resolve(a)).toLowerCase()===win32.normalize(resolve(b)).toLowerCase();
async function plainJson(path,{optional=false}={}){try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384||!equal(await realpath(path),path))throw Error('Maintenance configuration is unsafe');return JSON.parse(await readFile(path,'utf8'));}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}}
export async function createMaintenanceCapability({root,settings,probe=probeWindowsEpoch,installationRoot=defaultInstallationRoot}={}){
 root=resolve(root);const manifest=await plainJson(join(root,'runtime/maintenance/route-policy.json'),{optional:true});if(!manifest)return null;
 if(!manifest||Object.keys(manifest).sort().join(',')!=='pwshPath,pwshSha256,version,wrapperSha256'||manifest.version!==1||!isAbsolute(manifest.pwshPath)||!/^[a-z]:[\\/]/i.test(manifest.pwshPath)||![manifest.pwshSha256,manifest.wrapperSha256].every(x=>/^[a-f0-9]{64}$/.test(x??'')))throw Error('Maintenance policy is invalid');
 const approved=await plainJson(join(root,'runtime/maintenance/approved-host-helper.json')),expectedHelper=join(installationRoot,'scripts/maintenance/Verify-WebHostOwner.ps1');if(!approved||!equal(approved.path,expectedHelper)||!/^[a-f0-9]{64}$/.test(approved.sha256??''))throw Error('Host helper approval is unavailable');
 if(typeof settings?.dshDirectory!=='string'||typeof settings?.dshHome!=='string')throw Error('Managed DSH configuration is unavailable');
 const runtimeDirectory=resolve(root,settings.dshDirectory),home=resolve(root,settings.dshHome),within=relative(root,home);if(!within||within==='..'||within.startsWith('..\\')||within.startsWith('../')||isAbsolute(within)||!equal(process.env.DSH_HOME,home))throw Error('Managed DSH home differs');
 const expectedEntry=join(runtimeDirectory,'node_modules/@deepseek-ai/dsh/lib/bin.js');if(!equal(process.argv[1],expectedEntry))throw Error('Managed DSH entry differs');
 const epochProvider=async()=>{const record=await plainJson(join(root,'runtime/DSH.json'));if(record?.service!=='DSH'||record.processId!==process.pid||!equal(record.executable,process.execPath))throw Error('Managed Host record differs');const address=new URL(record.url);if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.username||address.password||address.pathname!=='/'||address.search||address.hash)throw Error('Managed Host address differs');const epoch=validateEpochEvidence({pid:process.pid,startTimeUtcTicks:record.startTimeUtcTicks,executable:win32.normalize(process.execPath).toLowerCase(),url:address.origin},await probe({pid:process.pid,port:Number(address.port)}));const again=await plainJson(join(root,'runtime/DSH.json'));if(JSON.stringify(record)!==JSON.stringify(again))throw Error('Managed Host record changed');return {pid:epoch.pid,startTimeUtcTicks:epoch.startTimeUtcTicks,executable:epoch.executable};};
 return {runtimeDirectory,sessionRoot:join(home,'sessions'),owner:createMaintenanceOwnerVerifier({installationRoot,runtimeRoot:root,pwshPath:manifest.pwshPath,helperHash:approved.sha256,wrapperHash:manifest.wrapperSha256,pwshHash:manifest.pwshSha256,epochProvider})};
}
