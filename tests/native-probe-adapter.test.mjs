import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createNativeProbe, NativeProbeError } from '../apps/controller/native-probe.mjs';

const bytes = Buffer.from('fixture-only, never executed');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const ticks = '639294336000000000';
const resources = {
  ramAvailableBytes: 100, ramTotalBytes: 1000,
  commitUsedBytes: 200, commitLimitBytes: 2000, commitAvailableBytes: 1800,
};
const row = (pid = 42) => ({
  pid, startTimeUtcTicks: ticks, executable: 'D:\\Services\\Strata.exe',
  workingSetBytes: 100, privateBytes: 200, residentPrivateBytes: null,
});
const epoch = {
  managed: { pid: 42, startTimeUtcTicks: ticks, executable: 'D:\\Services\\Strata.exe' },
  listener: { pid: 43, startTimeUtcTicks: ticks, executable: 'D:\\Services\\Strata.exe', parentPid: 42 },
};
const protocol = data => ({ stdout: JSON.stringify({ schemaVersion: 1, data }), stderr: '' });
const code = expected => error => error instanceof NativeProbeError && error.code === expected;

async function fixture(t, execute) {
  const temporaryRoot = resolve(tmpdir());
  const prefix = 'media-studio-probe-adapter-';
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith(prefix));
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    await rm(directory, { recursive: true, force: true });
  });
  const executable = join(directory, 'fixture.exe');
  await writeFile(executable, bytes);
  return { executable, probe: await createNativeProbe({ executable, sha256 }, { execute }) };
}

test('only absent configuration opts out; configured bad trust never opts out', async t => {
  assert.equal(await createNativeProbe(), null);
  assert.equal(await createNativeProbe(null), null);
  assert.equal(await createNativeProbe({}), null);
  await assert.rejects(createNativeProbe(new Date()), code('CONFIG'));
  await assert.rejects(createNativeProbe({ executable: 'fixture.exe', sha256 }), code('CONFIG'));
  await assert.rejects(createNativeProbe({ executable: resolve('missing-helper.exe'), sha256 }), code('TRUST'));
  await assert.rejects(createNativeProbe({ executable: resolve('missing-helper.exe') }), code('CONFIG'));
  await assert.rejects(createNativeProbe({ executable: resolve('missing-helper.exe'), sha256: 'invalid' }), code('CONFIG'));
  const { executable } = await fixture(t, async () => protocol(resources));
  await assert.rejects(createNativeProbe({ executable, sha256: '0'.repeat(64) }), code('TRUST'));
});

test('observations retain legacy shapes and exact ticks, with bounded shell-free execution', async t => {
  const calls = [];
  const { executable, probe } = await fixture(t, async (file, args, options) => {
    calls.push({ file, args, options });
    return protocol(args[0] === 'resources' ? resources : args[0] === 'processes' ? [row(42), row(43)] : epoch);
  });
  assert.deepEqual(await probe.resources(), resources);
  assert.deepEqual(await probe.processes([42, 43]), [row(42), row(43)]);
  assert.deepEqual(await probe.epoch({ pid: 42, port: 8080 }), epoch);
  assert.deepEqual(calls.map(call => call.args), [['resources'], ['processes', '42,43'], ['epoch', '42', '8080']]);
  for (const call of calls) {
    assert.equal(call.file, executable);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 131072);
    assert.equal(call.options.encoding, 'utf8');
  }
});

test('invalid requests cannot launch a helper', async t => {
  let calls = 0;
  const { probe } = await fixture(t, async () => { calls++; return protocol(resources); });
  for (const pids of [[], [0], [-1], [2 ** 32], [1, 1], [1.1], new Array(1), new Array(65).fill(1)]) {
    assert.throws(() => probe.processes(pids), code('INPUT'));
  }
  for (const request of [{ pid: 0, port: 80 }, { pid: 42, port: 0 }, { pid: 42, port: 65536 }, { pid: 42, port: 80, extra: 1 }]) {
    assert.throws(() => probe.epoch(request), code('INPUT'));
  }
  assert.equal(calls, 0);
});

test('malformed and contradictory helper output is rejected without leaking raw evidence', async t => {
  let result;
  const { probe } = await fixture(t, async () => result);
  const invalidResources = [
    { stdout: 'secret malformed output', stderr: '' },
    { stdout: JSON.stringify({ schemaVersion: 2, data: resources }), stderr: '' },
    { stdout: JSON.stringify({ schemaVersion: 1, data: resources, metrics: {} }), stderr: '' },
    protocol({ ...resources, ramAvailableBytes: 1001 }),
    protocol({ ...resources, commitAvailableBytes: 1801 }),
    protocol({ ...resources, ramTotalBytes: Number.MAX_SAFE_INTEGER + 1 }),
    { ...protocol(resources), stderr: 'secret error text' },
    { stdout: ' '.repeat(131073), stderr: '' },
  ];
  for (const value of invalidResources) {
    result = value;
    await assert.rejects(probe.resources(), error => code('PROTOCOL')(error) && !/secret/.test(error.message));
  }
  for (const rows of [[], [row(43)], [row(42), row(42)], [{ ...row(), startTimeUtcTicks: Number(ticks) }], [{ ...row(), privateBytes: null }], [{ ...row(), executable: 'relative.exe' }]]) {
    result = protocol(rows);
    await assert.rejects(probe.processes([42]), code('PROTOCOL'));
  }
  for (const value of [{ ...epoch, managed: { ...epoch.managed, pid: 44 } }, { ...epoch, listener: { ...epoch.listener, parentPid: -1 } }]) {
    result = protocol(value);
    await assert.rejects(probe.epoch({ pid: 42, port: 8080 }), code('PROTOCOL'));
  }
});

test('a changed helper fails before execution instead of silently falling back', async t => {
  let calls = 0;
  const { executable, probe } = await fixture(t, async () => { calls++; return protocol(resources); });
  await probe.resources();
  await writeFile(executable, 'different helper bytes');
  await assert.rejects(probe.resources(), code('TRUST'));
  assert.equal(calls, 1);
});

test('configured execution failure has no retry or fallback; abort propagates', async t => {
  let calls = 0;
  const { probe } = await fixture(t, async () => { calls++; throw new Error('secret stderr and path'); });
  await assert.rejects(probe.resources(), error => code('EXECUTION')(error) && !/secret/.test(error.message));
  assert.equal(calls, 1);
  const controller = new AbortController();
  const reason = new Error('cancelled fixture');
  controller.abort(reason);
  await assert.rejects(probe.resources({ signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

test('caller mutation cannot change the requested identity while a probe is pending', async t => {
  const { probe } = await fixture(t, async (_file, args) => protocol(args[0] === 'processes' ? [row()] : epoch));
  const pids = [42];
  const processRequest = probe.processes(pids);
  pids[0] = 99;
  assert.deepEqual(await processRequest, [row()]);
  const request = { pid: 42, port: 8080 };
  const epochRequest = probe.epoch(request);
  request.pid = 99;
  assert.deepEqual(await epochRequest, epoch);
});
