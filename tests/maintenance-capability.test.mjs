import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMaintenanceCapability} from '../apps/dsh-plugins/studio-services/maintenance-capability.mjs';
import {createHostRestartPolicy} from '../apps/dsh-plugins/studio-services/media-host-policy.mjs';

test('missing maintenance provisioning disables the optional capability; malformed policy fails closed',async t=>{const root=await mkdtemp(join(tmpdir(),'maintenance-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));assert.equal(await createMaintenanceCapability({root,settings:{}}),null);const dir=join(root,'runtime/maintenance');await mkdir(dir,{recursive:true});await writeFile(join(dir,'route-policy.json'),JSON.stringify({version:1,pwshPath:'relative',pwshSha256:'bad',wrapperSha256:'bad',secret:'not-allowed'}));await assert.rejects(createMaintenanceCapability({root,settings:{}}));});
test('missing or broken optional provisioning does not disable the restart policy',async t=>{const root=await mkdtemp(join(tmpdir(),'maintenance-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));const args={root,settings:{},ctx:{agents:{list:()=>[]}},systemAdapter:{}};let policy=await createHostRestartPolicy(args);assert.equal(policy.maintenance,undefined);assert.equal(policy.maintenanceUnavailable,false);assert.equal(typeof policy.verifyExternal,'function');const dir=join(root,'runtime/maintenance');await mkdir(dir,{recursive:true});await writeFile(join(dir,'route-policy.json'),'{}');policy=await createHostRestartPolicy(args);assert.equal(policy.maintenance,undefined);assert.equal(policy.maintenanceUnavailable,true);assert.equal(typeof policy.verifyExternal,'function');});
