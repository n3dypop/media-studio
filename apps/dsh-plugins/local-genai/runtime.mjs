import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRIES = {
  defineTool: ['dsh-tools', 'defineTool'],
  scopeOf: ['dsh-scope', 'scopeOf'],
};
const LLM_ENTRIES = {
  LlmError: ['dsh-llm', 'LlmError'],
  IMAGE_OFFLOAD_REQUIRED_CODE: ['dsh-llm', 'IMAGE_OFFLOAD_REQUIRED_CODE', 'string'],
};
const SCOPE_ENTRIES = {
  scopeOf: ['dsh-scope', 'scopeOf'],
  scopeChainOf: ['dsh-scope', 'scopeChainOf'],
};
const NATIVE_EXECUTOR_ENTRIES = {
  NativeToolExecutor: ['dsh-tool-executor-native', 'NativeToolExecutor'],
};

function inside(root, target) {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..\\`) && !part.startsWith('../') && !isAbsolute(part);
}

// Read the workspace's declared runtime rather than npm's ambient resolution or
// an obsolete relative apps/dsh import. Changing this JSON never installs code.
export async function loadDshBindings(options = {}) {
  return loadBindings(ENTRIES, options);
}

export async function loadDshLlmBindings(options = {}) {
  return loadBindings(LLM_ENTRIES, options);
}

export async function loadDshScopeBindings(options = {}) {
  return loadBindings(SCOPE_ENTRIES, options);
}

export async function loadDshNativeExecutor(options = {}) {
  return loadBindings(NATIVE_EXECUTOR_ENTRIES, options);
}

function assertDesktopProcess() {
  if (process.platform !== 'win32' || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1' ||
      typeof process.resourcesPath !== 'string' || !isAbsolute(process.resourcesPath) ||
      basename(process.execPath).toLowerCase() !== 'deepseek harness.exe') {
    throw new Error('Packaged Desktop runtime requires the Windows DSH Electron Node-mode process.');
  }
}

// The opt-in belongs to a trusted Desktop profile, not a request or user input.
export function desktopPackagedRuntimeOption(config) {
  const value = config?.desktopPackagedRuntime;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('desktopPackagedRuntime must be a boolean.');
  if (value) assertDesktopProcess();
  return value;
}

export function withDesktopPackagedRuntime(base) {
  const schema = base['~standard'];
  return Object.freeze({'~standard': Object.freeze({version: schema.version, vendor: schema.vendor, validate(value) {
    const result = schema.validate(value);
    if (result.issues) return result;
    try { desktopPackagedRuntimeOption(result.value); return result; }
    catch (error) { return {issues: [{message: error.message, path: ['desktopPackagedRuntime']}]}; }
  }})});
}

async function desktopRuntime(io) {
  assertDesktopProcess();
  const exe = await io.realpath(process.execPath);
  const resources = await io.realpath(process.resourcesPath);
  if (resources.toLowerCase() !== join(dirname(exe), 'resources').toLowerCase()) throw new Error('Packaged Desktop resources do not belong to the current executable.');
  const archive = join(resources, 'app.asar');
  // Electron's ordinary fs exposes virtual asar entries. Check the physical
  // archive before trusting the runtime directory inside it.
  const physical = createRequire(import.meta.url)('original-fs');
  const archiveStat = await physical.promises.lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || (await physical.promises.realpath(archive)).toLowerCase() !== archive.toLowerCase()) throw new Error('Packaged Desktop archive identity is invalid.');
  const runtime = await io.realpath(join(archive, 'dsh'));
  if (runtime.toLowerCase() !== join(archive, 'dsh').toLowerCase()) throw new Error('Packaged Desktop DSH runtime path differs.');
  let app, product, metadata;
  try {
    [app, product, metadata] = await Promise.all([join(archive, 'package.json'), join(runtime, 'package.json'), join(runtime, 'desktop-runtime.json')].map(async path => {
      const text = await io.readFile(path, 'utf8');
      if (text.length > 16 * 1024 * 1024) throw new Error('Oversized Desktop runtime metadata.');
      return JSON.parse(text);
    }));
  } catch { throw new Error('Packaged Desktop runtime metadata is unavailable or invalid.'); }
  const version = app?.version;
  const shared = metadata?.sharedPackages;
  if (app?.name !== '@deepseek-ai/dsh-desktop' || product?.name !== '@deepseek-ai/dsh-desktop-runtime' ||
      typeof version !== 'string' || !version || product.version !== version || metadata?.schemaVersion !== 1 ||
      metadata?.release?.version !== version || metadata?.release?.nodeVersion !== process.versions.node ||
      metadata?.platform !== process.platform || metadata?.arch !== process.arch || !Array.isArray(shared) ||
      !['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'].every(name => shared.some(entry => entry?.name === name && entry.version === version && entry.path === `node_modules/${name}`))) {
    throw new Error('Packaged Desktop runtime metadata does not match the current process.');
  }
  return runtime;
}

async function loadBindings(bindings, { workspaceRoot = WORKSPACE_ROOT, desktopPackagedRuntime = false, io = { readFile, realpath, stat }, importModule = specifier => import(specifier) } = {}) {
  if (typeof desktopPackagedRuntime !== 'boolean') throw new Error('desktopPackagedRuntime must be a boolean.');
  let runtime;
  if (desktopPackagedRuntime) {
    runtime = await desktopRuntime(io);
  } else {
    const root = await io.realpath(workspaceRoot);
    let configured;
    try {
      const source = await io.readFile(join(root, 'config', 'environment.json'), 'utf8');
      if (source.length > 131072) throw new Error('Oversized environment configuration.');
      configured = JSON.parse(source).dshDirectory;
    } catch {
      throw new Error('Cannot read dshDirectory from the workspace environment configuration.');
    }
    if (typeof configured !== 'string' || !configured.trim() || configured !== configured.trim() || /[\x00-\x1f]/.test(configured) || /^[\\/]{2}/.test(configured) || (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(configured) && !/^[a-zA-Z]:[\\/]/.test(configured))) {
      throw new Error('dshDirectory must be a local filesystem directory, not a URL or network path.');
    }
    const absolute = isAbsolute(configured);
    const candidate = resolve(root, configured);
    if (!absolute && !inside(root, candidate)) throw new Error('A relative dshDirectory must stay inside the workspace.');
    runtime = await io.realpath(candidate);
    if (!absolute && !inside(root, runtime)) throw new Error('A relative dshDirectory resolves outside the workspace. Use the explicit absolute runtime configuration.');
  }
  const entries = await Promise.all(Object.entries(bindings).map(async ([binding, [packageName, exportName, expectedType = 'function']]) => {
    const entry = await io.realpath(join(runtime, 'node_modules', '@deepseek-ai', packageName, 'lib', 'index.js'));
    if (!inside(runtime, entry) || !(await io.stat(entry)).isFile()) throw new Error('A DSH package entry must be a regular file inside the configured runtime.');
    return { binding, exportName, expectedType, url: pathToFileURL(entry).href };
  }));
  const result = {};
  await Promise.all(entries.map(async ({ binding, exportName, expectedType, url }) => {
    const module = await importModule(url);
    if (typeof module[exportName] !== expectedType || (expectedType === 'string' && !module[exportName])) throw new Error('The configured DSH runtime lacks a required plugin interface.');
    result[binding] = module[exportName];
  }));
  return result;
}
