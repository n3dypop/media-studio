import test from 'node:test';
import assert from 'node:assert/strict';
import { servicePlan } from '../apps/dsh-plugins/studio-services/service-manager.mjs';

test('Controller start reuses verified dependencies and restart still starts the stopped target', () => {
  const snapshot = {
    strataEnabled: true, searchEnabled: true,
    services: [
      { id: 'ComfyUI', state: 'running' },
      { id: 'Strata', state: 'running' },
      { id: 'Controller', state: 'stopped' },
    ],
  };
  const steps = (service, action) => servicePlan(service, action, snapshot).map(step => `${step.service}:${step.action}`);
  assert.deepEqual(steps('Controller', 'start'), ['RustXNG:start', 'Controller:start']);
  snapshot.services[0].state = 'stopped';
  assert.deepEqual(steps('Controller', 'start'), ['ComfyUI:start', 'RustXNG:start', 'Controller:start']);
  snapshot.services[0].state = 'running';
  snapshot.services[2].state = 'running';
  assert.deepEqual(steps('Strata', 'restart'), ['Controller:stop', 'Strata:stop', 'Strata:start', 'RustXNG:start', 'Controller:start']);
  snapshot.services[0].state = 'unknown';
  assert.throws(() => steps('Controller', 'restart'), /照合/);
});

test('A product update is bound to a checked release and targets only a stopped product',()=>{
  const snapshot={services:[{id:'Strata',state:'running'},{id:'ComfyUI',state:'stopped'},{id:'Controller',state:'stopped'}]};
  const commit='4'.repeat(40),digest='5'.repeat(64);
  assert.throws(()=>servicePlan('ComfyUI','update',snapshot,digest),{status:400});
  assert.throws(()=>servicePlan('Strata','update',snapshot,digest),{status:409});
  assert.deepEqual(servicePlan('ComfyUI','update',snapshot,commit),[
    {service:'ComfyUI',action:'update',offer:commit,label:'ComfyUI: 更新',state:'pending'},
  ]);
  snapshot.services[2].state='running';
  assert.throws(()=>servicePlan('ComfyUI','update',snapshot,commit),{status:409});
});
