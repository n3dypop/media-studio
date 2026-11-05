import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNativeToolMode } from '../apps/dsh-plugins/local-genai/native-tool-mode.mjs';

test('legacy scoped native mode does not load the newer executor', async () => {
  const calls = [];
  await selectNativeToolMode({ tools: { presentAs: mode => calls.push(mode) } }, () => assert.fail('unexpected executor load'));
  assert.deepEqual(calls, ['native']);
});

test('new native executor is installed only on the supplied scoped tools', async () => {
  const chosen = [];
  const ctx = { tools: { setExecutor: executor => chosen.push(executor) } };
  class NativeToolExecutor {
    constructor(owner) { this.owner = owner; }
    describe() {}
    execute() {}
  }
  await selectNativeToolMode(ctx, async () => ({ NativeToolExecutor }));
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].owner, ctx);
});

test('unknown or incomplete native interfaces are rejected', async () => {
  await assert.rejects(selectNativeToolMode({ tools: {} }, async () => ({})), /unavailable/);
  await assert.rejects(selectNativeToolMode({ tools: { setExecutor() {} } }, async () => ({})), /unavailable/);
  await assert.rejects(selectNativeToolMode({ tools: { setExecutor() {} } }, async () => ({ NativeToolExecutor: class {} })), /contract is invalid/);
});
