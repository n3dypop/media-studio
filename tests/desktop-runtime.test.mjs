import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { desktopPackagedRuntimeOption, loadDshBindings } from '../apps/dsh-plugins/local-genai/runtime.mjs';

test('Desktop runtime selection is explicit and ordinary Node fails closed', async () => {
  assert.equal(desktopPackagedRuntimeOption({}), false);
  assert.equal(desktopPackagedRuntimeOption({ desktopPackagedRuntime: false }), false);
  assert.throws(() => desktopPackagedRuntimeOption({ desktopPackagedRuntime: 'true' }), /boolean/);
  assert.throws(() => desktopPackagedRuntimeOption({ desktopPackagedRuntime: true }), /Electron Node-mode/);
  await assert.rejects(loadDshBindings({ desktopPackagedRuntime: true }), /Electron Node-mode/);
});

test('packaged Desktop resolves its own actual DSH runtime and native executor', { skip: !process.env.MEDIA_STUDIO_DESKTOP_TEST_EXE }, () => {
  const script = `
    const mod = await import(process.argv[1]);
    const options = { desktopPackagedRuntime: true };
    const bindings = await mod.loadDshBindings(options);
    const scopes = await mod.loadDshScopeBindings(options);
    const llm = await mod.loadDshLlmBindings(options);
    const native = await mod.loadDshNativeExecutor(options);
    if (typeof bindings.defineTool !== 'function' || typeof scopes.scopeOf !== 'function' ||
        typeof llm.LlmError !== 'function' || typeof native.NativeToolExecutor !== 'function') process.exit(2);
  `;
  const moduleUrl = new URL('../apps/dsh-plugins/local-genai/runtime.mjs', import.meta.url).href;
  const child = spawnSync(process.env.MEDIA_STUDIO_DESKTOP_TEST_EXE, ['--input-type=module', '-e', script, moduleUrl], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message || 'Desktop runtime process failed');
});
