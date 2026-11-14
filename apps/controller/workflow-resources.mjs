import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const quantities = (record, keys, valid = positive) => Object.fromEntries(keys
  .filter(key => valid(record?.[key])).map(key => [key, record[key]]));
const dimensions = ['width', 'height', 'frames', 'fps', 'steps'];
const memoryFields = ['vramBytes', 'ramBytes', 'commitBytes'];
const risks = ['abnormal-termination', 'resource-capacity'];

function recommendationFor(record, shortfalls = []) {
  const issue = risks.includes(record?.issue) && ['observed', 'shared-path', 'verified'].includes(record.evidence) &&
    typeof record.summary === 'string' && record.summary.trim().length > 0 && record.summary.length <= 300 &&
    typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? {
      issue: record.issue, evidence: record.evidence, date: record.date, summary: record.summary,
    } : null;
  return issue || shortfalls.length ? { status: 'not-recommended', ...(issue ?? { issue: 'resource-capacity', evidence: 'verified' }),
    ...(shortfalls.length && { shortfalls }) } : null;
}

function resourceForecast(sample, assessment, machine, matchingSample) {
  const minimum = quantities(assessment?.minimum, memoryFields);
  // Working set describes the process footprint; it is not Windows commit.
  // The margin is advisory and applies to the measured configuration only.
  const forecasts = { vramBytes: sample?.vramPeakDeltaBytes, ramBytes: sample?.ramWorkingSetPeakBytes,
    commitBytes: sample?.commitPeakDeltaBytes };
  const headroom = quantities(Object.fromEntries(Object.entries(forecasts)
    .map(([key, bytes]) => [key, Math.ceil(bytes * 1.2)])), memoryFields);
  const metrics = memoryFields.flatMap(key => {
    const total = machine?.capacity?.[key], available = machine?.available?.[key];
    if (!(key in minimum) && !(key in headroom) && !nonnegative(available)) return [];
    const structurallyShort = positive(total) && minimum[key] > total;
    const target = Math.max(minimum[key] ?? 0, matchingSample ? headroom[key] ?? 0 : 0);
    return [{ key, minimumBytes: minimum[key] ?? null, headroomBytes: headroom[key] ?? null,
      capacityBytes: positive(total) ? total : null, availableBytes: nonnegative(available) ? available : null,
      state: structurallyShort ? 'capacity-shortfall' : target && nonnegative(available)
        ? available < target ? 'below-headroom' : 'meets-reference' : 'unknown' }];
  });
  return metrics;
}

function validSample(sample, hash) {
  return sample && sample.workflowSha256 === hash &&
    typeof sample.gpu === 'string' && /^[\w .()-]{1,80}$/.test(sample.gpu) &&
    [sample.width, sample.height, sample.sampleIntervalMs, sample.vramPeakDeltaBytes, sample.ramWorkingSetPeakBytes].every(positive) &&
    (sample.frames === undefined || positive(sample.frames));
}

// The standard model tree is authoritative for disk bytes. A name without a
// subfolder can also be exposed by ComfyUI via a family-specific search root.
export function workflowResourceReader(modelDirectory, observations, machine = null) {
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
    const models = [...unique];
    const sizes = await Promise.all(models.map(([key, model]) => {
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
      ...quantities(sample, ['fps', 'steps', 'samples', 'gpuPeakBytes', 'ramPrivatePeakBytes', 'commitPeakDeltaBytes', 'outputBytes']),
    } : null;
    const record = observations?.version === 1 && Object.hasOwn(observations.assessments ?? {}, entry.id)
      ? observations.assessments[entry.id] : null;
    // Keep an incident visible after edits. Apply numeric minima only to the assessed template revision.
    const assessment = typeof hash === 'string' && record?.workflowSha256 === hash ? record : null;
    const matchingGpu = Boolean(runtime && typeof machine?.gpu === 'string' &&
      runtime.gpu.replace(/^NVIDIA (?:GeForce )?/i, '') === machine.gpu.replace(/^NVIDIA (?:GeForce )?/i, ''));
    const metrics = resourceForecast(runtime, assessment, machine, matchingGpu);
    const shortfalls = metrics.filter(metric => metric.state === 'capacity-shortfall')
      .map(({key, minimumBytes, capacityBytes}) => ({key, minimumBytes, capacityBytes}));
    const recommendation = recommendationFor(record, shortfalls);
    const attempt = record?.attempt;
    const incidentSample = attempt && positive(attempt.width) && positive(attempt.height) ? {
      ...quantities(attempt, dimensions), ...quantities(attempt, ['vramFreeBytes', 'ramAvailableBytes', 'commitAvailableBytes'], nonnegative),
    } : null;
    const modelComponents = models.map(([, model], index) => ({ ...model, bytes: sizes[index] }));
    return { resourceUsage: { modelDiskBytes, modelComponents, runtime, metrics, matchingGpu,
      observedAt: machine?.observedAt ?? null, outputVolumes: machine?.outputVolumes ?? [],
      outputObservedAt: machine?.outputObservedAt ?? null, incidentSample },
      ...(recommendation && { recommendation }) };
  };
}
