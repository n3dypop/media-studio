import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createControllerServer} from '../apps/controller/http.mjs';
import {createPlugin} from '../apps/dsh-plugins/local-genai/index.mjs';

test('the normal Controller rejects obsolete experimental Host settings',async t=>{
  assert.throws(()=>createControllerServer({experimentalHostIsolation:true}),/incomplete/);
  assert.throws(()=>createControllerServer({experimentalHostIsolation:null}),/incomplete/);
  const server=createControllerServer({});assert.equal(server.listening,false);server.close();
  const root=await mkdtemp(join(tmpdir(),'studio-obsolete-host-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'config'));
  await writeFile(join(root,'config/environment.json'),'{}');
  const entry=resolve(fileURLToPath(new URL('../apps/controller/server.mjs',import.meta.url)));
  for(const [config,message] of [[{experimentalHostIsolation:true},/Host isolation is incomplete/],[{fixtureDesktopPaths:true},/Fixture-only Desktop paths/]]){
    await writeFile(join(root,'config/controller.json'),JSON.stringify(config));
    const child=spawnSync(process.execPath,[entry],{env:{...process.env,MEDIA_STUDIO_HOME:root},encoding:'utf8',timeout:15000,windowsHide:true});
    assert.notEqual(child.status,0);assert.match(child.stderr,message);
    await assert.rejects(stat(join(root,'data')),{code:'ENOENT'});
  }
});

test('obsolete experimental tool configuration cannot silently use the normal Controller',async()=>{
  const scopeOf=()=>undefined;
  for(const experimentalToolTransport of [null,true,{}]){
    await assert.rejects(createPlugin({}, {experimentalToolTransport}, {scopeOf}),/removed; refusing to fall back/);
  }
  for(const config of [{},{experimentalToolTransport:false}]){
    await assert.rejects(createPlugin({},config,{scopeOf}),/dedicated agent preset/);
  }
});
