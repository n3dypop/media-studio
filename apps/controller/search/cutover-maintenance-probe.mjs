// Fixed read-only maintenance probe. No cutover/backup/stop command exists.
import {createWrapperFenceVerifier} from './cutover-wrapper-fence.mjs';
if(process.argv.length!==6||!['--probe','--host-fence-probe','--pin-probe'].includes(process.argv[2]))throw Error('Only the maintenance lock probe is available');
const [controllerPath,dshPath,scriptPath]=process.argv.slice(3);let nonce='';for await(const chunk of process.stdin)nonce+=chunk.toString();nonce=nonce.trim();if(!/^[a-f0-9]{64}$/.test(nonce))throw Error('Maintenance nonce unavailable');
const controller=createWrapperFenceVerifier({lockPath:controllerPath,scriptPath}),dsh=createWrapperFenceVerifier({lockPath:dshPath,scriptPath,handleVariable:'MEDIA_STUDIO_DSH_PARENT_HANDLE'});if(!controller()||!dsh())throw Error('Maintenance launch-lock ownership is unavailable');
process.stdout.write(JSON.stringify({mode:'probe',controllerLock:'held',dshLock:'held',cutoverAvailable:false})+'\n');
// Keep the read-only host fence alive for a separate OS-level verifier. This
// mode never stops a process or opens a profile/database for writing.
if(['--host-fence-probe','--pin-probe'].includes(process.argv[2]))await new Promise(resolve=>setTimeout(resolve,15000));
