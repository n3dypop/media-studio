import test from 'node:test';
import assert from 'node:assert/strict';
import {observeOwnHostBirth} from '../apps/dsh-plugins/local-genai/host-birth.mjs';

test('Host birth is accepted only from an observed matching process',async()=>{
 const observed={pid:process.pid,startTimeUtcTicks:'638000000000000000',executable:process.execPath};let requested;
 const createProbe=async()=>({async processes(pids){requested=pids;return [observed];}});
 assert.deepEqual(await observeOwnHostBirth('synthetic-root',{}, {createProbe}),{pid:process.pid,start_time_utc_ticks:observed.startTimeUtcTicks,executable:process.execPath});assert.deepEqual(requested,[process.pid]);
});
test('unavailable, failed or mismatched observation is not replaced by PID alone',async()=>{
 for(const createProbe of [async()=>null,async()=>{throw Error('secret probe details');},async()=>({processes:async()=>[]}),async()=>({processes:async()=>[{pid:process.pid+1,startTimeUtcTicks:'638000000000000000',executable:process.execPath}]}),async()=>({processes:async()=>[{pid:process.pid,startTimeUtcTicks:'not-a-time',executable:process.execPath}]}),async()=>({processes:async()=>[{pid:process.pid,startTimeUtcTicks:'638000000000000000',executable:'C:\\other.exe'}]})])await assert.rejects(observeOwnHostBirth('synthetic-root',{}, {createProbe}),error=>/Host process identity/.test(error.message)&&!error.message.includes('secret'));
});
