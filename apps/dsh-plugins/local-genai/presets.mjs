import { AGENT_ROLES } from './roles.mjs';
const productionPresets = ['studio', 'workflow-development', 'image-generation'].map(role => AGENT_ROLES[role]);

function findPreset(rows, id) {
  const matches = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === id);
  if (matches.length !== 1) throw new Error(`Exactly one ${id} preset is required.`);
  return matches[0];
}

function renameDisplayPatch(patch, { requireStudio = false } = {}) {
  if (!Array.isArray(patch)) throw new Error('A profile patch array is required.');
  const result = structuredClone(patch);
  const rows = result.flatMap(row => row.insert ?? [row]);
  for (const { presetId, name } of productionPresets) {
    const preset = findPreset(rows, presetId);
    if (requireStudio && preset.config.plugins?.find(plugin => plugin.id === 'local-genai')?.config?.role !== 'studio') {
      throw new Error(`Preset ${presetId} is not a migrated media-studio preset.`);
    }
    preset.config.name = name;
  }
  return result;
}

// Retain existing callers and change only display names on migrated profiles.
export const tidyStudioPresetDisplays = renameStudioPresetDisplays;

// Preserve the deployed route, credential reference and isolated compaction
// configuration. The legacy preset itself is never modified by this builder.
export function dedicatedPresetRows(legacy) {
  if (legacy?.config?.id !== 'local-image' || !Array.isArray(legacy.config.plugins)) throw new Error('The legacy local-image preset is required.');
  return ['workflow-development', 'image-generation'].map((role, index) => {
    const row = structuredClone(legacy);
    const descriptor = AGENT_ROLES[role];
    row.id = `preset-${descriptor.presetId}`;
    Object.assign(row.config, {
      id: descriptor.presetId,
      name: descriptor.name,
      description: role === 'workflow-development'
        ? '導入済み許可ノードからComfyUIグラフを設計・検証し、依頼に応じて試作画像を評価する'
        : '画像モデルを明示し、承認テンプレートから生成した実画像を評価・改善する',
      order: 20 + index * 10,
    });
    const native = row.config.plugins.find(plugin => plugin.id === 'local-genai');
    if (!native?.config || !row.config.plugins.some(plugin => plugin.name === '@deepseek-ai/dsh-tool-ask-user')
      || !row.config.plugins.some(plugin => plugin.group === true && plugin.isolate?.compaction === true)) throw new Error('The legacy preset lacks managed tools, clarification or isolated compaction.');
    native.config.role = role;
    return row;
  });
}

export function renamePresetDisplays(patch) {
  return renameDisplayPatch(patch);
}

export function renameStudioPresetDisplays(patch) {
  return renameDisplayPatch(patch, { requireStudio: true });
}

// These Cordis row IDs are configuration identities, not session preset IDs.
// Migrate a complete skill group in place; reject partial or colliding rows.
export function renameStudioSkillIds(patch) {
  if (!Array.isArray(patch)) throw new Error('A profile patch array is required.');
  const result = structuredClone(patch);
  const rows = result.flatMap(row => row.insert ?? [row]);
  const ids = ['registry', 'source', 'tool'].map(suffix => [
    `studio-skill-${suffix}`, `image-studio-skill-${suffix}`, `media-studio-skill-${suffix}`,
  ]);
  for (const id of ['local-image', 'local-workflow-development', 'local-image-generation']) {
    const matches = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === id);
    if (matches.length !== 1 || matches[0].config.plugins?.find(item => item.id === 'local-genai')?.config?.role !== 'studio') throw new Error(`Exactly one migrated preset ${id} is required.`);
    const plugins = matches[0].config.plugins;
    const groups = plugins.filter(item => ['studio-skills', 'image-studio-skills', 'media-studio-skills'].includes(item.id));
    if (groups.length !== 1 || groups[0].name !== 'cordis:group' || groups[0].isolate?.skills !== true || !Array.isArray(groups[0].config)) throw new Error(`Invalid skill group for ${id}.`);
    const group = groups[0];
    for (const aliases of ids) {
      const children = group.config.filter(item => aliases.includes(item.id));
      if (children.length !== 1) throw new Error(`Invalid skill row ${aliases[2]} for ${id}.`);
      children[0].id = aliases[2];
    }
    group.id = 'media-studio-skills';
  }
  return result;
}

// Keep the three durable identities so old conversations still compose. The
// pinned registry has no hidden-preset contract; Media Studio is the default.
export function studioPresetPatch(patch) {
  const result = structuredClone(patch);
  const rows = result.flatMap(row => row.insert ?? [row]);
  for (const { presetId: id, name } of productionPresets) {
    const row = findPreset(rows, id);
    const native = row.config.plugins.find(item => item.id === 'local-genai');
    if (!native?.config || !native.config.workspaceRoot) throw new Error('A managed plugin workspace is required.');
    native.config.role = 'studio';
    row.config.name = name;
    row.config.description = '登録済みのComfyUIワークフローを使い、制作・返却・評価を行う';
    row.config.order = id === 'local-image' ? 0 : id === 'local-workflow-development' ? 90 : 100;
    if (row.config.plugins.some(item => ['studio-skills', 'studio-skill-tool', 'image-studio-skills', 'image-studio-skill-tool', 'media-studio-skills', 'media-studio-skill-tool'].includes(item.id))) throw new Error('media-studio skills are already configured.');
    const skillSource = native.name.replace(/\/index\.mjs$/, '/skills.mjs');
    row.config.plugins.push({ id: 'media-studio-skills', name: 'cordis:group', group: true, isolate: { skills: true }, config: [
      { id: 'media-studio-skill-registry', name: '@deepseek-ai/dsh-skill' },
      { id: 'media-studio-skill-source', name: skillSource },
      { id: 'media-studio-skill-tool', name: '@deepseek-ai/dsh-tool-skill', config: { catalogDescriptionMaxLength: 220 } },
    ] });
  }
  const registry = result.find(row => row.id === 'agent-preset-registry');
  if (registry) registry.config = { ...registry.config, default: 'local-image' };
  else result.push({ id: 'agent-preset-registry', config: { default: 'local-image' } });
  return result;
}
