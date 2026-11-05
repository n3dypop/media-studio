// Descriptive evidence, not an execution allowlist or a substitute for live
// ComfyUI discovery. A preflight free-memory sample is not a peak requirement.
const COMFY_REVISION = '384577510969e0ed59506f8eb5fcf6e6df15a3d1';
const entries = {
  'moss-image-sft-int8-v1': {
    status: 'installed-recorded', modes: ['t2i', 'i2i', 'edit'],
    source: { url: 'https://huggingface.co/Comfy-Org/MOSS-Image', revision: '530a4c94f92c35ef6818b1b035a983fe9dcf5f54', evidence: 'docs/manifests/moss-install-plan.json' },
    license: { id: 'unknown', note: 'Apache-2.0 is recorded for the MOSS project; separate weight/component terms were not verified in this ledger.' },
    compatibility: 'Native ComfyUI MOSS profile; edit uses an encoded input image, without exact identity or masked-edit guarantees.',
    memory: { estimatedPeakBytes: null, observed: [{ kind: 'preflight-free-vram', bytes: 11522539520, width: 576, height: 768, mode: 'edit', evidence: 'outputs/9cab9804-b4cf-494e-9f81-69c798c31902/manifest.json' }] },
  },
  'realesrgan-x4plus-v1': {
    status: 'installed-recorded', modes: ['upscale'],
    source: { url: 'https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0', revision: 'v0.1.0', evidence: 'docs/manifests/media-models-installation.json' },
    license: { id: 'unknown', note: 'Weight and component terms have not been verified in this ledger.' },
    compatibility: 'RealESRGAN x4 model followed by resize to the requested dimensions; not interpolation alone.',
    memory: { estimatedPeakBytes: null, observed: [{ kind: 'preflight-free-vram', bytes: 10869379072, width: 1152, height: 1536, mode: 'upscale', evidence: 'outputs/522a132c-bcd9-46c1-9dd2-f37164cd7f7e/manifest.json' }] },
  },
  'image-scale-v1': {
    status: 'built-in-node', modes: ['upscale'], source: { url: 'https://github.com/Comfy-Org/ComfyUI', revision: COMFY_REVISION, evidence: 'docs/manifests/studio-review.json' },
    license: { id: 'unknown', note: 'Node/component license not separately verified here.' },
    compatibility: 'ImageScale interpolation, not a learned AI upscaler.', memory: { estimatedPeakBytes: null, observed: [] },
  },
  'qwen-photo-v1': {
    status: 'historical', modes: ['t2i'], source: { url: null, revision: null, evidence: 'docs/reports/VALIDATION.md' },
    license: { id: 'unknown', note: 'Source and terms need fresh verification.' },
    compatibility: 'Previous Qwen image installation; do not infer current availability from historical generation.', memory: { estimatedPeakBytes: null, observed: [] },
  },
};

/** Return descriptive data separately from live availability and validation. */
export function profileLedger(id) {
  const entry = entries[id];
  return entry ? structuredClone({ ...entry, memoryNote: 'Observed preflight free VRAM is a point sample, not peak use or a minimum requirement. Measure live RAM/VRAM before execution.' }) : null;
}

/** No provenance/license is inferred merely because Comfy reported a node. */
export function nodeLedger(type, schema = {}) {
  return { type, source: 'unknown', revision: null, license: 'unknown',
    reportedModule: typeof schema.python_module === 'string' ? schema.python_module : null,
    reportedApiNode: typeof schema.api_node === 'boolean' ? schema.api_node : null,
    compatibility: 'Check installed input/output schema and controller graph validation.',
    executionPolicy: 'Only controller-allowlisted graphs are eligible; discovery alone does not prove transitive network behavior.' };
}

export function coreModelLedger() {
  return {
    id: 'orcarouter-qwen3.8-flash-next-uncensored-iq3-xxs', engine: 'Strata', status: 'installation-recorded',
    source: {url:'https://huggingface.co/orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF',revision:'98eb3357afd966c25cadd082c7f830eafde7aa52',evidence:'docs/reports/strata-orca-pack-2026-11-03.json'},
    license: {id:'unknown',note:'Model and component terms need independent verification.'},
    modes: ['planning','workflow-design','image-review'],
    compatibility: 'Recorded Strata configuration: context 32768, vision CPU, one parallel request; check live provider status separately.',
    memory: {estimatedPeakBytes:null,observed:[]},
  };
}
