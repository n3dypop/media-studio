import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { literalImports } from '../scripts/check-package.mjs';
import { SearchService } from '../apps/controller/search/service.mjs';
import { readPublicPage } from '../apps/controller/search/page.mjs';

const root = resolve(import.meta.dirname, '..');
const controller = join(root, 'apps/controller');

test('Controller has a private service identity and retains its managed entry', async () => {
  const metadata = JSON.parse(await readFile(join(controller, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@n3dypop/media-studio-controller');
  assert.equal(metadata.private, true);
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.engines.node, '>=24 <25');
  assert.equal(metadata.engines.dsh, undefined);
  assert.equal(metadata.scripts.start, 'node --disable-warning=ExperimentalWarning server.mjs');
  const launcher = await readFile(join(root, 'scripts/Start-Controller.ps1'), 'utf8');
  assert.match(launcher, /'apps\/controller\/server\.mjs'/);
  assert.equal(typeof SearchService, 'function');
  assert.equal(typeof readPublicPage, 'function');
});

test('Controller source imports are internal libraries or Node APIs, independent of DSH plugin code', async () => {
  const modules = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(path);
    }
  }
  await walk(controller);
  assert.ok(modules.length > 20);
  for (const path of modules) {
    const source = await readFile(path, 'utf8');
    for (const specifier of literalImports(source)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${relative(controller, path)}: ${specifier}`);
      const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
      const part = relative(controller, target);
      assert.ok(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part), `${relative(controller, path)}: ${specifier}`);
    }
  }
});
