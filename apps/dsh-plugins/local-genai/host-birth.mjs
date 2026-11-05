// The Controller's configured native helper is the
// only source of process birth evidence; there is no fallback to PID alone.
import {win32} from 'node:path';
import {createConfiguredNativeProbe} from '../../controller/native-probe.mjs';

export async function observeOwnHostBirth(root,config,{createProbe=createConfiguredNativeProbe}={}){
 if(typeof createProbe!=='function')throw Error('Host process identity observation is unavailable');
 let rows;try{const probe=await createProbe(config,root);if(!probe||typeof probe.processes!=='function')throw Error('unavailable');rows=await probe.processes([process.pid]);}catch{throw Error('Host process identity observation is unavailable');}
 const row=Array.isArray(rows)&&rows.length===1?rows[0]:null;
 if(!row||row.pid!==process.pid||typeof row.startTimeUtcTicks!=='string'||!/^[1-9][0-9]{16,18}$/.test(row.startTimeUtcTicks)||BigInt(row.startTimeUtcTicks)>3155378975999999999n||typeof row.executable!=='string'||!win32.isAbsolute(row.executable)||win32.normalize(row.executable).toLowerCase()!==win32.normalize(process.execPath).toLowerCase())throw Error('Host process identity evidence differs');
 return {pid:row.pid,start_time_utc_ticks:row.startTimeUtcTicks,executable:row.executable};
}
