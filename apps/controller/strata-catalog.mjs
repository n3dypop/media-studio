import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const text = value => typeof value === 'string' && /^[\x20-\x7e]{1,160}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const configuredRam = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  ? count(Math.round(Number(value) * 1024 ** 3)) : null;
const pathKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export async function strataCatalog({ root, productRoot, strata }) {
  const recordFile = join(root, 'runtime/Strata.json');
  const recorded = () => json(recordFile).catch(() => null);
  const before = await recorded();
  let configured = null;
  let configHash = null;
  try {
    const receipt = await json(join(root, 'data/strata/installation.json'));
    const allowed = [join(root, 'data/strata/serve-config.json')];
    const product = productRoot ?? receipt.productRoot;
    if (typeof product === 'string' && isAbsolute(product)) allowed.push(join(product, '.runtime/local-serve/serve-config.json'));
    const configFile = typeof receipt.config === 'string' && isAbsolute(receipt.config) &&
      allowed.find(file => pathKey(receipt.config) === pathKey(file));
    if (!configFile || receipt.prepared !== true) throw new Error('No prepared Strata configuration');
    const bytes = await readFile(configFile);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const config = JSON.parse(bytes);
    if (hash !== receipt.configSha256 || !text(config.model_name) || config.model_name !== receipt.model) {
      throw new Error('Strata configuration differs from the installation receipt');
    }
    const args = Array.isArray(config.args) ? config.args : [];
    const option = key => {
      const index = args.indexOf(key);
      return index >= 0 && args.lastIndexOf(key) === index ? args[index + 1] : undefined;
    };
    const source = receipt.modelSource;
    const repository = /^[\w.-]+\/[\w.-]+$/.test(source?.repository ?? '') ? text(source.repository) : null;
    const native = option('--native');
    configured = {
      model: config.model_name, repository, quantization: text(source?.quantization),
      weights: typeof native === 'string' ? text(basename(native.replaceAll('\\', '/'))) : null,
      revision: /^[a-f0-9]{40}$/.test(source?.revision ?? '') ? source.revision : null,
      context: count(Number(option('--max-context'))),
      residentRamBudgetBytes: configuredRam(option('--resident-budget-gib')),
    };
    configHash = hash;
  } catch { /* The live state remains useful when configuration provenance is unavailable. */ }

  let running = null;
  let configurationMatch = null;
  if (strata) {
    try {
      const status = await strata.status({ signal: AbortSignal.timeout(4500) });
      const after = await recorded();
      const identity = strata.identity;
      if (identity && after?.instanceId === identity.instanceId && after?.processId === identity.pid &&
          after.started === status.started && JSON.stringify(before) === JSON.stringify(after) && configHash && /^[a-f0-9]{64}$/.test(after.configSha256 ?? '')) {
        configurationMatch = after.configSha256 === configHash;
      }
      running = {
        state: status.loaded ? 'loaded' : 'unloaded', model: text(status.model), engine: text(status.engine),
        context: count(status.context?.max_positions),
        vision: !status.vision.enabled ? 'off' : status.vision.available && status.vision.error == null ? 'available' : 'unknown',
      };
    } catch { /* An unreachable or replaced server leaves the state unverified. */ }
  }
  return { configured, running, configurationMatch, observedAt: new Date().toISOString() };
}
