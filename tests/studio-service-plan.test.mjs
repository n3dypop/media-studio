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
