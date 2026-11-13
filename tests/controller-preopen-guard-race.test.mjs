import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
test('Controller rechecks pre-open guard after listener wait and before DB open',{timeout:30000},async t=>{
 const base=realpathSync(tmpdir()),root=mkdtempSync(join(base,'preopen-race-')),config=join(root,'config'),maintenance=join(root,'runtime/maintenance'),preload=join(root,'delay.mjs'),ready=join(root,'listener-pending');mkdirSync(config);mkdirSync(maintenance,{recursive:true});const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));writeFileSync(join(config,'environment.json'),JSON.stringify({comfyPort:18188}));writeFileSync(join(config,'controller.json'),JSON.stringify({port,profile:'moss-image-sft-int8-v1'}));
 writeFileSync(preload,`import http from 'node:http';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const original=http.createServer;http.createServer=(...args)=>{const server=original(...args),listen=server.listen;server.listen=function(...params){writeFileSync(process.env.FIXTURE_READY,'yes');setTimeout(()=>listen.apply(server,params),2000);return server};return server};syncBuiltinESMExports();`);
 let child,done;t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await done;}assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true,force:true});});
 child=spawn(process.execPath,['--import',pathToFileURL(preload).href,resolve(import.meta.dirname,'../apps/controller/server.mjs')],{env:{...process.env,MEDIA_STUDIO_HOME:root,FIXTURE_READY:ready},windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',x=>errors+=x.toString());done=new Promise(ok=>child.once('exit',ok));for(let i=0;i<200&&!existsSync(ready)&&child.exitCode===null;i++)await new Promise(ok=>setTimeout(ok,25));assert.ok(existsSync(ready),'fixture did not reach listener wait: '+errors);writeFileSync(join(maintenance,'controller-cutover-preopen.json'),'fixture guard');await done;assert.notEqual(child.exitCode,0);assert.match(errors,/recovery is pending/);assert.equal(existsSync(join(root,'data/controller/controller.db')),false);assert.ok(existsSync(join(maintenance,'controller-cutover-preopen.json')));
});
