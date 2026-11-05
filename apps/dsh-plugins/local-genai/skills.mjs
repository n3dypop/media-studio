import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';

export const name = 'media-studio-skills';
export const inject = ['skills'];
export const PLAYBOOKS = Object.freeze({
  'generation-plan': 'Turn a user request and admitted materials into a production specification, stages and observable acceptance criteria.',
  'comfyui-workflow-build': 'Select or develop a permitted ComfyUI workflow and distinguish static validation from generation.',
  'comfyui-generate': 'Execute a validated workflow once through the managed controller and recover its actual saved media.',
  'output-review': 'Review actual image or video output against saved criteria, distinguishing met, unmet and unverified.',
  'generation-iterate': 'Plan a justified change from the review, preserve strengths and compare attempts without a blind seed loop.',
  'resource-control': 'Use the controller-owned GPU lease and observable resource state; respect ownership, cancellation and uncertainty.',
});
const ROOT = fileURLToPath(new URL('./skills/', import.meta.url));
const LIMIT = 24 * 1024;

export async function loadPlaybook(name, { signal, root = ROOT } = {}) {
  if (!Object.hasOwn(PLAYBOOKS, name)) throw new Error('Unknown media-studio playbook.');
  signal?.throwIfAborted();
  const base = await realpath(root);
  const path = await realpath(join(base, name, 'SKILL.md'));
  const part = relative(base, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('media-studio playbook must remain inside its maintained source directory.');
  const info = await stat(path);
  if (!info.isFile() || info.size > LIMIT) throw new Error('media-studio playbook is not a bounded regular file.');
  const bytes = await readFile(path, { signal });
  if (bytes.length > LIMIT) throw new Error('media-studio playbook exceeds its byte limit.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const header = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: [^\r\n]+\r?\n---\r?\n/u.exec(raw);
  if (!header || header[1] !== name) throw new Error('media-studio playbook identity is invalid.');
  const content = raw.slice(header[0].length).trim();
  if (!content) throw new Error('media-studio playbook is empty.');
  return content;
}

export function apply(ctx) {
  // A native scoped provider. No uploaded files, project/user discovery, or
  // model-supplied path can become instructions through this provider.
  const candidates = Object.entries(PLAYBOOKS).map(([name, description]) => ({
    name, description, invocation: { modelInvocable: true, userInvocable: true },
    provider: 'media-studio', source: 'bundled', rank: 0,
    resourceBase: { kind: 'opaque', description: 'Maintained media-studio playbook; use the managed tools named in its instructions.' },
    locator: name,
  }));
  ctx.skills.registerProvider(() => ({
    name: 'media-studio',
    list: async () => candidates,
    async get(candidate, options) {
      if (!candidates.includes(candidate) && candidate.locator !== candidate.name) throw new Error('Invalid media-studio playbook locator.');
      const { rank, locator, ...summary } = candidates.find(item => item.name === candidate.name) ?? {};
      if (!summary.name) throw new Error('Unknown media-studio playbook.');
      return { ...summary, content: await loadPlaybook(summary.name, options) };
    },
  }));
}
