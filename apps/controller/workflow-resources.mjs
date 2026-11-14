import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const positive = value => Number.isSafeInteger(value) && value > 0;

function validSample(sample, hash) {
  return sample && sample.workflowSha256 === hash &&
    typeof sample.gpu === 'string' && /^[\w .()-]{1,80}$/.test(sample.gpu) &&
    [sample.width, sample.height, sample.sampleIntervalMs, sample.vramPeakDeltaBytes, sample.ramWorkingSetPeakBytes].every(positive) &&
    (sample.frames === undefined || positive(sample.frames));
}

// The standard model tree is authoritative for disk bytes. A name without a
// subfolder can also be exposed by ComfyUI via a family-specific search root.
export function workflowResourceReader(modelDirectory, observations) {
  const root = modelDirectory ? realpath(modelDirectory).catch(() => null) : Promise.resolve(null);
  const entriesByCategory = new Map();
  const modelSizes = new Map();

  async function fileSize(file) {
    try {
      const info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink() && await realpath(file) === file && positive(info.size)) return info.size;
    } catch { /* Missing or inaccessible weights are reported as unknown. */ }
    return null;
  }

  function familyFolders(directory) {
    if (!entriesByCategory.has(directory)) {
      entriesByCategory.set(directory, readdir(directory, { withFileTypes: true })
        .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
        .catch(() => []));
    }
    return entriesByCategory.get(directory);
  }

  async function findModelSize({ category, name }) {
    const resolved = await root;
    if (!resolved) return null;
    const directory = path.join(resolved, category);
    const exact = await fileSize(path.join(directory, name));
    if (exact !== null || name.includes('/')) return exact;
    const sizes = (await Promise.all((await familyFolders(directory))
      .map(folder => fileSize(path.join(directory, folder, name))))).filter(size => size !== null);
    return sizes.length === 1 ? sizes[0] : null;
  }

  return async (entry, hash) => {
    const unique = new Map(entry.models.map(model => [model.category + '/' + model.name, model]));
    const sizes = await Promise.all([...unique].map(([key, model]) => {
      if (!modelSizes.has(key)) modelSizes.set(key, findModelSize(model));
      return modelSizes.get(key);
    }));
    const total = sizes.reduce((sum, size) => sum + (size ?? 0), 0);
    const modelDiskBytes = sizes.every(size => size !== null) && Number.isSafeInteger(total) ? total : null;
    const sample = modelDiskBytes !== null && observations?.version === 1 && Object.hasOwn(observations.workflows ?? {}, entry.id)
      ? observations.workflows[entry.id] : null;
    const runtime = validSample(sample, hash) ? {
      gpu: sample.gpu, width: sample.width, height: sample.height, frames: sample.frames,
      sampleIntervalMs: sample.sampleIntervalMs, vramPeakDeltaBytes: sample.vramPeakDeltaBytes,
      ramWorkingSetPeakBytes: sample.ramWorkingSetPeakBytes,
    } : null;
    return { modelDiskBytes, runtime };
  };
}
