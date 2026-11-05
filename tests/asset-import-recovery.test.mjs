// Independent ownership and race tests using isolated data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {RunStore} from '../apps/controller/store.mjs';
import {AssetStore,assetRoute} from '../apps/controller/assets.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';

const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
async function noLinks(root){for(const entry of await readdir(root,{withFileTypes:true})){const p=join(root,entry.name),s=await lstat(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())await noLinks(p);else assert.equal(s.isFile(),true);}}
async function fixture(t){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'asset-recovery-review-')),dbPath=join(root,'db.sqlite');
  const store=new RunStore(dbPath),entered=gate(),resume=gate(),inputRoot=join(root,'input');
  const normalize=async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};};
  const assets=new AssetStore({store,root,inputRoot,normalize}),input={requestId:randomUUID(),purpose:'input',mime:'image/png',dataBase64:Buffer.from('isolated asset').toString('base64')};
  t.after(async()=>{resume.release();store.close();assert.equal(await realpath(root),root);assert.ok(resolve(root).startsWith(resolve(base)+sep));await noLinks(root);await rm(root,{recursive:true});});
  const pending=assets.addWithReceipt('owner',input);await entered.promise;
  const info=await assets.findImportByRequest('owner',input.requestId),r=info.receipt;
  const proof={requestId:r.requestId,assetId:r.assetId,payloadHash:r.payloadHash,originalSha256:r.originalSha256};
  return {store,assets,input,root,dbPath,inputRoot,resume,pending,proof};
}

test('admin-only recovery requires exact ownership and evidence; late normalizer cannot publish the file',async t=>{
  const f=await fixture(t);
  try{
    for(const changed of [{...f.proof,assetId:randomUUID()},{...f.proof,payloadHash:'0'.repeat(64)},{...f.proof,originalSha256:'0'.repeat(64)}])assert.throws(()=>f.assets.abandonImport('owner',changed),e=>e.status===409);
    assert.throws(()=>f.assets.abandonImport('foreign',f.proof),e=>e.status===409);
    const route=role=>assetRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/assets/recovery',role,assets:f.assets,body:async()=>f.proof,json:()=>{}});
    await assert.rejects(route('dsh'),e=>e.status===403);
    const accepted=f.assets.abandonImport('owner',f.proof);assert.equal(accepted.created,true);assert.equal(accepted.receipt.state,'abandoned');
    assert.deepEqual(f.assets.abandonImport('owner',f.proof),{receipt:accepted.receipt,created:false});
    assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).receipt.state,'abandoned');
    f.resume.release();await assert.rejects(f.pending,e=>e.status===503);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='asset_import_abandoned'").get().n,1);
    assert.deepEqual((await readdir(join(f.root,'data','assets',f.proof.assetId))).sort(),['image.png','original.bin']);
    assert.deepEqual(await readFile(join(f.root,'data','assets',f.proof.assetId,'original.bin')),Buffer.from(f.input.dataBase64,'base64'));
    await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===503);
    const next=await f.assets.addWithReceipt('owner',{...f.input,requestId:randomUUID()});assert.equal(next.receipt.state,'committed');assert.notEqual(next.asset.id,f.proof.assetId);
  }finally{f.resume.release();await f.pending.catch(()=>{});}
});

test('a different process can abandon and replay after reopen while the original process is still normalizing',async t=>{
  const f=await fixture(t);
  try{
    const data={path:f.dbPath,root:f.root,inputRoot:f.inputRoot,proof:f.proof};
    const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {AssetStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/assets.mjs')).href)};const d=JSON.parse(process.env.ASSET_RECOVERY_FIXTURE),s=new RunStore(d.path);try{const a=new AssetStore({store:s,root:d.root,inputRoot:d.inputRoot});console.log(JSON.stringify(a.abandonImport('owner',d.proof)));}finally{s.close();}`;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ASSET_RECOVERY_FIXTURE:JSON.stringify(data)},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const code=await new Promise((done,fail)=>{child.on('error',fail);child.on('exit',done);});assert.equal(code,0,err);assert.equal(JSON.parse(out).receipt.state,'abandoned');
    f.resume.release();await assert.rejects(f.pending,e=>e.status===503);
    const secondStore=new RunStore(f.dbPath),second=new AssetStore({store:secondStore,root:f.root,inputRoot:f.inputRoot});
    try{assert.equal((await second.findImportByRequest('owner',f.input.requestId)).receipt.state,'abandoned');assert.equal(second.abandonImport('owner',f.proof).created,false);}finally{secondStore.close();}
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
  }finally{f.resume.release();await f.pending.catch(()=>{});}
});

test('failure to write the audit record rolls back abandon and keeps the import pending',async t=>{
  const f=await fixture(t);
  try{
    f.store.db.exec("CREATE TRIGGER fail_asset_abandon BEFORE INSERT ON asset_import_abandons BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    assert.throws(()=>f.assets.abandonImport('owner',f.proof),/audit failed/);
    assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).receipt.state,'started');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_abandons').get().n,0);
    await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,requestId:randomUUID()}),e=>e.status===503);
  }finally{f.resume.release();await f.pending.catch(()=>{});}
});

test('a committed asset cannot be abandoned or overwritten',async t=>{
  const f=await fixture(t);
  try{f.resume.release();const saved=await f.pending;assert.throws(()=>f.assets.abandonImport('owner',f.proof),e=>e.status===409);assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).asset.id,saved.asset.id);}
  finally{f.resume.release();await f.pending.catch(()=>{});}
});

test('actual Controller HTTP requires admin authorization and the exact owning session',async t=>{
  const f=await fixture(t),reserve=createServer();await new Promise(done=>reserve.listen(0,'127.0.0.1',done));const port=reserve.address().port;await new Promise(done=>reserve.close(done));
  const server=createControllerServer({store:f.store,assets:f.assets,engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});
  await new Promise((done,fail)=>server.once('error',fail).listen(port,'127.0.0.1',done));
  const url=`http://127.0.0.1:${port}/api/assets/recovery`;
  const post=(token,owner)=>fetch(url,{method:'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'X-DSH-Session':owner,'Content-Type':'application/json'},body:JSON.stringify(f.proof)});
  try{
    assert.equal((await post(null,'owner')).status,401);
    assert.equal((await post('fixture-dsh','owner')).status,403);
    assert.equal((await post('fixture-admin','other')).status,409);
    assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).receipt.state,'started');
    const accepted=await post('fixture-admin','owner');assert.equal(accepted.status,200,await accepted.clone().text());assert.equal((await accepted.json()).receipt.state,'abandoned');
    assert.equal((await post('fixture-admin','owner')).status,200);
  }finally{f.resume.release();await f.pending.catch(()=>{});server.closeAllConnections();await new Promise(done=>server.close(done));}
});
