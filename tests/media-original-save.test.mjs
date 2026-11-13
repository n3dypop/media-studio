import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('original PNG uses the authenticated read and the native file action without re-encoding', async () => {
  const script = await readFile(new URL('../apps/dsh-plugins/media-results/client.js', import.meta.url), 'utf8');
  const url = '/api/local-studio/original-image?fixture=1';
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let client;
  let response = new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  const signal = new AbortController().signal;
  runInNewContext(script, {
    window: { __ModuleLoader__: { load: entry => { client = entry.factory(() => ({})); } } },
    fetch: async (request, options) => {
      assert.equal(request, url);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal, signal);
      return response;
    },
  });

  const fileActions = { async save(source, mode) {
    assert.equal(mode, 'download');
    assert.equal(source.name, 'original.png');
    const blob = await source.read(signal);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
    return { status: 'saved' };
  } };
  assert.deepEqual(await client.saveOriginalPng(fileActions, url, 'original.png'), { status: 'saved' });

  response = new Response('not a PNG', { headers: { 'Content-Type': 'text/plain' } });
  await assert.rejects(client.saveOriginalPng(fileActions, url, 'original.png'), /Original PNG unavailable/);
});
