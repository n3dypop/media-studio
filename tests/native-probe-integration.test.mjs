import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguredNativeProbe, createNativeProbe, NativeProbeError } from '../apps/controller/native-probe.mjs';
import { observeWindowsResources } from '../apps/controller/resources.mjs';
import { createEpochVerifier } from '../apps/controller/epoch.mjs';
import { createStrataEpochVerifier } from '../apps/controller/strata-epoch.mjs';
import { createResourceObserver } from '../apps/controller/monitor-telemetry.mjs';
import { ResourceGate } from '../apps/controller/resource-gate.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const memory = { ramAvailableBytes: 100, ramTotalBytes: 1000, commitUsedBytes: 200, commitLimitBytes: 2000, commitAvailableBytes: 1800 };
const ticks = '639294336000000000';
const executable = 'D:\\Services\\python.exe';
const evidence = (child = false) => ({
  managed: { pid: 42, startTimeUtcTicks: ticks, executable },
  listener: { pid: child ? 43 : 42, startTimeUtcTicks: ticks, executable, parentPid: child ? 42 : 1 },
});
const protocol = data => ({ stdout: JSON.stringify({ schemaVersion: 1, data }), stderr: '' });
const gpu = async () => ({ stdout: '16\n', stderr: '' });

async function nativeFixture(t, execute) {
  const temporaryRoot = resolve(tmpdir());
  const prefix = 'media-studio-native-integration-';
  const root = await mkdtemp(join(temporaryRoot, prefix));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), temporaryRoot);
    assert.ok(basename(root).startsWith(prefix));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const helper = join(root, 'apps/media-studio-probe/controller-native-probe.exe');
  const bytes = Buffer.from('integration fixture, never executed');
  await mkdir(dirname(helper), { recursive: true });
  await writeFile(helper, bytes);
  const probe = await createConfiguredNativeProbe({ enabled: true, executable: helper, sha256: sha256(bytes) }, root, {
    createProbe: options => createNativeProbe(options, { execute }),
  });
  return { root, probe };
}

test('server native opt-in is explicit, private-runtime-contained and receipt-pinned', async () => {
  const root = resolve(tmpdir(), 'media-studio-config-fixture');
  let calls = 0;
  const marker = {};
  const dependencies = { createProbe: async options => { calls++; assert.deepEqual(options, {
    executable: join(root, 'apps/media-studio-probe/controller-native-probe.exe'), sha256: 'a'.repeat(64),
  }); return marker; } };
  assert.equal(await createConfiguredNativeProbe(undefined, root, dependencies), null);
  assert.equal(await createConfiguredNativeProbe({ enabled: false }, root, dependencies), null);
  assert.equal(await createConfiguredNativeProbe({ enabled: false, executable: 'unavailable', sha256: 'retired' }, root, dependencies), null);
  assert.equal(calls, 0);
  const config = { enabled: true, executable: join(root, 'apps/media-studio-probe/controller-native-probe.exe'), sha256: 'a'.repeat(64) };
  for (const bad of [{}, { enabled: 'true' }, { ...config, executable: join(root, 'apps/other/helper.exe') }, { ...config, executable: join(root, 'apps/media-studio-probe-copy/helper.exe') }, { ...config, sha256: 'bad' }, { ...config, extra: true }]) {
    await assert.rejects(createConfiguredNativeProbe(bad, root, dependencies), error => error instanceof NativeProbeError && error.code === 'CONFIG');
  }
  assert.equal(calls, 0);
  assert.equal(await createConfiguredNativeProbe(config, root, dependencies), marker);
  assert.equal(calls, 1);
});

test('memory callback replaces only PowerShell RAM observation and keeps existing NVIDIA output contract', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const sample = await observeWindowsResources({ signal, readMemory: async options => { assert.equal(options.signal, signal); return memory; } }, {
    executeFile: async (file, args, options) => { calls.push({ file, args, options }); return gpu(); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'nvidia-smi.exe');
  assert.deepEqual(calls[0].args, ['--query-gpu=memory.free', '--format=csv,noheader,nounits']);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(sample.freeBytes, 16 * 1024 ** 2);
  assert.equal(sample.ramAvailableBytes, memory.ramAvailableBytes);
  assert.equal(sample.commitAvailableBytes, memory.commitAvailableBytes);
  assert.equal(Number.isFinite(Date.parse(sample.observedAt)), true);
  assert.deepEqual(Object.keys(sample).sort(), ['commitAvailableBytes', 'commitLimitBytes', 'commitUsedBytes', 'freeBytes', 'observedAt', 'ramAvailableBytes'].sort());
});

test('absent memory callback retains legacy PowerShell; invalid or failed native memory never falls back', async () => {
  const calls = [];
  const executeFile = async file => { calls.push(file); return file === 'nvidia-smi.exe' ? gpu() : { stdout: JSON.stringify(memory), stderr: '' }; };
  await observeWindowsResources({}, { executeFile });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /powershell\.exe$/i);
  calls.length = 0;
  const failure = new Error('native observation unavailable');
  await assert.rejects(observeWindowsResources({ readMemory: async () => { throw failure; } }, { executeFile }), error => error === failure);
  assert.deepEqual(calls, ['nvidia-smi.exe']);
  for (const invalid of [null, { ...memory, ramAvailableBytes: -1 }, { ...memory, commitUsedBytes: 2001 }, { ...memory, commitAvailableBytes: 0 }, { ...memory, ramTotalBytes: 99 }]) {
    await assert.rejects(observeWindowsResources({ readMemory: async () => invalid }, { executeFile }), /Invalid GPU\/RAM observation/);
  }
  await assert.rejects(observeWindowsResources({ readMemory: async () => memory }, { executeFile: async () => ({ stdout: '16\n16\n' }) }), /GPU\/RAM observation unavailable/);
});

test('native evidence still undergoes Comfy registry identity and listener ancestry checks', async t => {
  let current = evidence(true);
  const { probe } = await nativeFixture(t, async () => protocol(current));
  const baseUrl = 'http://127.0.0.1:8189';
  const record = { service: 'ComfyUI', processId: 42, startTimeUtcTicks: ticks, executable, url: baseUrl };
  const verify = createEpochVerifier({ runtimePath: 'fixture', expectedExecutable: executable, baseUrl,
    readRuntime: async () => JSON.stringify(record), probe: probe.epoch });
  assert.equal((await verify()).listenerPid, 43);
  current = evidence(true); current.listener.parentPid = 999;
  await assert.rejects(verify(), /管理PID本人または直接の子/);
  current = evidence(true); current.managed.startTimeUtcTicks = '639294336000000001';
  await assert.rejects(verify(), /管理PIDが終了・再利用/);
});

test('native Strata epoch preserves ready-instance pinning and refuses a child listener', async t => {
  let current = evidence();
  const { root, probe } = await nativeFixture(t, async () => protocol(current));
  const baseUrl = 'http://127.0.0.1:8080';
  const readyPath = join(root, 'data/strata/runtime/ready.json');
  const record = { service: 'Strata', workspace: root, url: baseUrl, ready: true, started: 123, instanceId: 'instance-a',
    processId: 42, startTimeUtcTicks: ticks, executable, readyPath };
  const ready = { pid: 42, instance_id: 'instance-a', api_url: baseUrl, api_state: 'ready' };
  const verify = createStrataEpochVerifier({ root, expectedExecutable: executable, baseUrl, probe: probe.epoch,
    read: async path => JSON.stringify(path === join(root, 'runtime/Strata.json') ? record : ready) });
  assert.equal((await verify()).instanceId, 'instance-a');
  current = evidence(true);
  await assert.rejects(verify(), /待受プロセスが管理PID本人ではありません/);
  current = evidence(); record.instanceId = 'instance-b'; ready.instance_id = 'instance-b';
  await assert.rejects(verify(), /管理プロセスが交代/);
});

test('configured native failure blocks model loading and fresh telemetry becomes unavailable without stale substitution', async t => {
  let failing = false, helperCalls = 0;
  const { probe } = await nativeFixture(t, async (_file, args) => {
    helperCalls++;
    if (failing) throw Error('helper failed');
    if (args[0] === 'resources') return protocol(memory);
    return protocol([{ pid: 42, startTimeUtcTicks: ticks, executable, workingSetBytes: 100, privateBytes: 150, residentPrivateBytes: null }]);
  });
  let now = 0;
  const snapshot = { pid: 42, listenerPid: 42, startTimeUtcTicks: ticks, listenerStartTimeUtcTicks: ticks, recordSha256: 'a' };
  const observeTelemetry = createResourceObserver({ verifyComfy: async () => snapshot, readProcesses: probe.processes,
    readGpu: async () => ({ system: null, processes: new Map([[42, 0]]) }), readAdapters: async () => [], readWindowsGpu: async () => new Map(),
    systemMemory: () => ({ totalBytes: 1000, freeBytes: 100 }), clock: () => new Date(now), ttlMs: 1000 });
  assert.equal((await observeTelemetry()).services.comfyui.status, 'observed');
  failing = true; now += 1001;
  assert.deepEqual((await observeTelemetry()).services.comfyui, { status: 'unavailable', ram: null, vram: null });
  let loads = 0;
  const gate = new ResourceGate({ strata: { status: async () => ({ started: 1, loaded: false, activity: { in_flight: 0 } }), load: async () => { loads++; } },
    observeResources: options => observeWindowsResources({ ...options, readMemory: probe.resources }, { executeFile: gpu }),
    minFreeBytes: 1, minCoreFreeBytes: 1, stableSamples: 1, intervalMs: 1, resourceTimeoutMs: 100 });
  await gate.initialize();
  await assert.rejects(gate.acquireCore(), error => error instanceof NativeProbeError && error.code === 'EXECUTION');
  assert.equal(loads, 0);
  assert.equal(gate.status().blocked, true);
  assert.equal(gate.status().owner, 'unknown');
  assert.equal(helperCalls, 3);
});
