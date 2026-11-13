import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowCatalogForAgent } from '../apps/dsh-plugins/local-genai/index.mjs';

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
  assert.deepEqual(compact.capabilities, [catalog.capabilities[0]]);
  assert.deepEqual(compact.templates, [{ id: modelProfile, available: true, sha256: 'a'.repeat(64) }]);
  assert.deepEqual(compact.limits, { maxPixels: 1500000, maxSteps: 40 });
  assert.equal(Object.hasOwn(compact, 'nodeSchemas'), false);
  assert.equal(Object.hasOwn(compact, 'coreModelLedger'), false);
  assert.equal(workflowCatalogForAgent(catalog, 'workflow-development'), catalog);
});
