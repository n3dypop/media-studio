import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPreparation, workflowCatalogForAgent } from '../apps/dsh-plugins/local-genai/index.mjs';

test('studio catalog keeps template selection usable without returning a graph or node schemas', () => {
  const modelProfile = 'moss-image-sft-int8-v1';
  const catalog = {
    modelProfile, mode: 't2i',
    modelProfiles: [{ id: modelProfile, label: 'MOSS Image', available: true, ledger: { source: 'fixture' } }],
    models: [{ name: 'moss.safetensors', nodeType: 'UNETLoader', available: true }],
    capabilities: [{ modelProfile, mode: 't2i' }, { modelProfile, mode: 'edit', inputRequired: true }],
    templates: [{ id: modelProfile, available: true, sha256: 'a'.repeat(64), graph: { '1': { class_type: 'UNETLoader' } } }],
    limits: { maxPixels: 1500000, maxSteps: 40, topology: ['fixture'] },
    nodeSchemas: { UNETLoader: {} }, coreModelLedger: { engine: 'Strata' },
  };

  const compact = workflowCatalogForAgent(catalog, 'studio');
  assert.deepEqual(compact.modelProfiles, [{ id: modelProfile, label: 'MOSS Image', available: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(compact)), compact, 'DSH tool output must be lossless JSON');
  assert.deepEqual(compact.capabilities, catalog.capabilities, 'the default template mode must not hide other operations');
  assert.deepEqual(workflowCatalogForAgent(catalog, 'studio', { mode: 'edit' }).capabilities, [catalog.capabilities[1]]);
  assert.deepEqual(compact.templates, [{ id: modelProfile, available: true, sha256: 'a'.repeat(64) }]);
  assert.deepEqual(compact.limits, { maxPixels: 1500000, maxSteps: 40 });
  assert.equal(Object.hasOwn(compact, 'nodeSchemas'), false);
  assert.equal(Object.hasOwn(compact, 'coreModelLedger'), false);
  assert.equal(workflowCatalogForAgent(catalog, 'workflow-development'), catalog);
});

test('the next preparation follows the saved model and revision', () => {
  const production = { id: 'saved-production', revision: 2 };
  const identity = { productionId: production.id, expectedRevision: production.revision };
  assert.deepEqual(productionPreparation({ ...production, modelProfile: 'moss-image-sft-int8-v1' }), {
    tool: 'local_image_prepare', args: identity,
  });
  assert.deepEqual(productionPreparation({ ...production, modelProfile: 'moss-image-sft-official-v1', mode: 'edit' }), {
    tool: 'local_moss_official_prepare', args: { ...identity, modelProfile: 'moss-image-sft-official-v1', mode: 'edit' },
  });
  assert.deepEqual(productionPreparation({ ...production, modelProfile: 'qwen-image-2.1-turbo-v1' }), {
    tool: 'local_qwen21_prepare', args: { ...identity, modelProfile: 'qwen-image-2.1-turbo-v1', mode: 't2i' },
  });
  assert.equal(productionPreparation({ ...production, modelProfile: 'unavailable-profile' }), undefined);
});
