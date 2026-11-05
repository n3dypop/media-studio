import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const executeFile = promisify(execFile);
const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_EXECUTABLE_BYTES = 32 * 1024 * 1024;
const MAX_TICKS = 3155378975999999999n;
const ownKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const validBytes = value => Number.isSafeInteger(value) && value >= 0;
const validTicks = value => typeof value === 'string' && /^[1-9][0-9]{16,18}$/.test(value)
  && BigInt(value) <= MAX_TICKS;
const validExecutable = value => typeof value === 'string' && value.length <= 32767
  && win32.isAbsolute(value) && !/[\u0000-\u001f]/.test(value);

export class NativeProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeProbeError';
    this.code = code;
  }
}

function fail(code) {
  // Do not copy child stdout/stderr or host paths into client-facing errors.
  const messages = {
    CONFIG: 'The configured native probe or receipt is invalid.',
    TRUST: 'The configured native probe could not be verified.',
    INPUT: 'The native probe request is invalid.',
    EXECUTION: 'The configured native probe failed; no fallback observation was used.',
    PROTOCOL: 'The native probe returned invalid observation evidence.',
  };
  throw new NativeProbeError(code, messages[code]);
}

function checkSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INPUT');
  signal?.throwIfAborted();
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

async function verifyExecutable(executable, sha256) {
  let handle;
  try {
    // A release must be an ordinary file under ordinary directories. The hash
    // receipt is explicit opt-in; an arbitrary PATH executable is never used.
    for (let path = executable; ; path = dirname(path)) {
      const stat = await lstat(path, { bigint: true });
      if (stat.isSymbolicLink() || (path === executable ? !stat.isFile() : !stat.isDirectory())) fail('TRUST');
      const parent = dirname(path);
      if (parent === path) break;
    }
    handle = await open(executable, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_EXECUTABLE_BYTES)) fail('TRUST');
    const contents = await handle.readFile();
    const actual = createHash('sha256').update(contents).digest();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(executable, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, current) || current.isSymbolicLink()
      || !timingSafeEqual(actual, sha256)) fail('TRUST');
  } catch {
    fail('TRUST');
  } finally {
    await handle?.close();
  }
}

function validateResources(value) {
  const keys = ['ramAvailableBytes', 'ramTotalBytes', 'commitUsedBytes', 'commitLimitBytes', 'commitAvailableBytes'];
  if (!ownKeys(value, keys) || !keys.every(key => validBytes(value[key]))
    || value.ramAvailableBytes > value.ramTotalBytes
    || value.commitUsedBytes > value.commitLimitBytes
    || value.commitAvailableBytes !== value.commitLimitBytes - value.commitUsedBytes) fail('PROTOCOL');
  return value;
}

function validateIdentity(value, listener = false) {
  const keys = ['pid', 'startTimeUtcTicks', 'executable', ...(listener ? ['parentPid'] : [])];
  if (!ownKeys(value, keys) || !validPid(value.pid) || !validTicks(value.startTimeUtcTicks)
    || !validExecutable(value.executable)
    || (listener && (!Number.isSafeInteger(value.parentPid) || value.parentPid < 0 || value.parentPid > 0xffffffff))) fail('PROTOCOL');
}

function validateProcesses(value, pids) {
  const keys = ['pid', 'startTimeUtcTicks', 'executable', 'workingSetBytes', 'privateBytes', 'residentPrivateBytes'];
  if (!Array.isArray(value) || value.length !== pids.length) fail('PROTOCOL');
  const expected = new Set(pids);
  for (const row of value) {
    if (!ownKeys(row, keys) || !expected.delete(row.pid) || !validPid(row.pid)
      || !validTicks(row.startTimeUtcTicks) || !validExecutable(row.executable)
      || !validBytes(row.workingSetBytes) || !validBytes(row.privateBytes)
      || (row.residentPrivateBytes !== null && !validBytes(row.residentPrivateBytes))) fail('PROTOCOL');
  }
  if (expected.size) fail('PROTOCOL');
  return value;
}

function validateEpoch(value, pid) {
  if (!ownKeys(value, ['managed', 'listener'])) fail('PROTOCOL');
  validateIdentity(value.managed);
  validateIdentity(value.listener, true);
  if (value.managed.pid !== pid) fail('PROTOCOL');
  // Exact managed/listener identity and ancestry are still checked by the
  // existing epoch verifier against the managed runtime record.
  return value;
}

/**
 * Opt-in read-only Windows observations. An absent configuration selects the
 * existing observers; once configured, trust/execution/schema errors propagate
 * rather than silently substituting another observation or stale evidence.
 * The receipt and executable must be deployed together by a maintenance agent.
 */
export async function createNativeProbe(options, { execute = executeFile } = {}) {
  if (options === undefined || options === null || (ownKeys(options, []) && !Object.keys(options).length)) return null;
  if (!ownKeys(options, ['executable', 'sha256']) || typeof options.executable !== 'string'
    || !isAbsolute(options.executable) || /^[\\/]{2}/.test(options.executable)
    || /[\u0000-\u001f]/.test(options.executable)
    || typeof options.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(options.sha256)
    || typeof execute !== 'function') fail('CONFIG');
  const executable = resolve(options.executable);
  const sha256 = Buffer.from(options.sha256, 'hex');
  await verifyExecutable(executable, sha256);

  async function query(args, validate, signal) {
    checkSignal(signal);
    await verifyExecutable(executable, sha256);
    checkSignal(signal);
    let result;
    try {
      result = await execute(executable, args, {
        windowsHide: true, shell: false, timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', signal,
      });
    } catch {
      checkSignal(signal);
      fail('EXECUTION');
    }
    checkSignal(signal);
    if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES
      || (result.stderr !== undefined && result.stderr !== '')) fail('PROTOCOL');
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { fail('PROTOCOL'); }
    if (!ownKeys(envelope, ['schemaVersion', 'data']) || envelope.schemaVersion !== 1) fail('PROTOCOL');
    return validate(envelope.data);
  }

  return Object.freeze({
    resources({ signal } = {}) {
      return query(['resources'], validateResources, signal);
    },
    processes(pids, { signal } = {}) {
      if (!Array.isArray(pids) || pids.length < 1 || pids.length > 64
        || !Array.from(pids).every(validPid) || new Set(pids).size !== pids.length) fail('INPUT');
      const requested = [...pids];
      return query(['processes', requested.join(',')], value => validateProcesses(value, requested), signal);
    },
    epoch(request, { signal } = {}) {
      if (!ownKeys(request, ['pid', 'port']) || !validPid(request.pid)
        || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535) fail('INPUT');
      const { pid, port } = request;
      return query(['epoch', String(pid), String(port)], value => validateEpoch(value, pid), signal);
    },
  });
}

// Server configuration is intentionally narrower than the reusable adapter:
// the executable must be in this instance's private auxiliary-runtime directory.
export async function createConfiguredNativeProbe(config, root, { createProbe = createNativeProbe } = {}) {
  if (config === undefined || config === null) return null;
  if (!ownKeys(config, Object.keys(config)) || typeof config.enabled !== 'boolean'
    || Object.keys(config).some(key => !['enabled', 'executable', 'sha256'].includes(key))) fail('CONFIG');
  if (config.enabled === false) return null;
  if (!ownKeys(config, ['enabled', 'executable', 'sha256'])
    || typeof root !== 'string' || !isAbsolute(root)
    || typeof config.executable !== 'string' || !isAbsolute(config.executable)
    || typeof config.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(config.sha256)
    || typeof createProbe !== 'function') fail('CONFIG');
  const home = resolve(root, 'apps/media-studio-probe');
  const executable = resolve(config.executable);
  const child = relative(home, executable);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) fail('CONFIG');
  return createProbe({ executable, sha256: config.sha256 });
}
