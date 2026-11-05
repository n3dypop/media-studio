import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,rmdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {AssetStore,assetRoute} from '../apps/controller/assets.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t,{normalize}={}){
  const base=join(tmpdir(),'media-studio-asset-receipts');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
  const dbPath=join(root,'controller.sqlite'),store=new RunStore(dbPath),inputRoot=join(root,'comfy-input');
  const assets=new AssetStore({store,root,inputRoot,normalize:normalize??(async(src,dst)=>{await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};})});
  t.after(async()=>{store.close();assert.ok(resolve(root).startsWith(resolve(base)+sep));await rm(root,{recursive:true,force:true});});
  const input={requestId:randomUUID(),purpose:'input',mime:'image/png',filename:'fixture.png',dataBase64:Buffer.from('synthetic-private-image').toString('base64')};
  return {root,dbPath,store,assets,input};
}
const pause=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};

test('pre-reservation asset rejection is fenced without writing an image and prevents late admission',async t=>{
  const f=await fixture(t),productions=new ProductionStore(f.store),bad={...f.input,dataBase64:'!'},args={req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/assets',role:'dsh',assets:f.assets,productions,body:async()=>bad};let out;
  await assetRoute({...args,json:(_r,status,value)=>out={status,value}});assert.equal(out.status,400);assert.equal(out.value.receipt.state,'rejected');assert.equal(out.value.receipt.payloadHash,hash(JSON.stringify(bad)));
  assert.deepEqual(productions.findMutationRejection('owner','asset-import',bad.requestId).receipt,out.value.receipt);
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,0);
  await assert.rejects(f.assets.findImportByRequest('owner',bad.requestId),e=>e.status===404);
});

test('started asset import cannot acquire a pre-reservation rejection fence',async t=>{
  const entered=pause(),resume=pause(),f=await fixture(t,{normalize:async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}}),productions=new ProductionStore(f.store);
  const pending=f.assets.addWithReceipt('owner',f.input);await entered.promise;
  try{assert.throws(()=>productions.rejectUnadmittedMutation('owner','asset-import',null,f.input,400),e=>e.status===503);assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).receipt.state,'started');}
  finally{resume.release();await pending;}
});

test('two processes cannot both reserve and reject an asset import',async t=>{
  const f=await fixture(t);new ProductionStore(f.store);
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};import {AssetStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/assets.mjs')).href)};import {readFile,writeFile} from 'node:fs/promises';const v=JSON.parse(process.env.ASSET_FENCE_FIXTURE),s=new RunStore(v.dbPath),p=new ProductionStore(s),a=new AssetStore({store:s,root:v.root,inputRoot:v.root,normalize:async(src,dst)=>{await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}});process.send('ready');process.once('message',async()=>{try{if(v.mode==='reject')p.rejectUnadmittedMutation('owner','asset-import',null,v.input,400);else await a.addWithReceipt('owner',v.input);process.send('done');}catch{process.send('refused');}finally{s.close();process.disconnect();}});`;
  const children=[],start=mode=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:{...process.env,ASSET_FENCE_FIXTURE:JSON.stringify({root:f.root,dbPath:f.dbPath,input:f.input,mode})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise((done,fail)=>{child.on('message',m=>{if(m==='ready')done();});child.once('error',fail);child.once('exit',c=>{if(c!==0)fail(Error(stderr));});});const exited=new Promise((done,fail)=>{child.once('error',fail);child.once('exit',c=>c===0?done():fail(Error(stderr)));});return {child,ready,exited};};
  const a=start('reject'),b=start('import');try{await Promise.all([a.ready,b.ready]);a.child.send('go');b.child.send('go');await Promise.all([a.exited,b.exited]);}finally{for(const child of children)if(child.exitCode===null)child.kill();}
  const accepted=f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts WHERE session_id=? AND request_id=?').get('owner',f.input.requestId).n,rejected=f.store.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections WHERE session_id=? AND request_id=?').get('owner',f.input.requestId).n;assert.equal(accepted+rejected,1);
});

for(const name of ['asset_import_receipts','asset_import_abandons','asset_import_open_session'])test(`${name} cannot disappear after import ledger migration`,async t=>{
  const f=await fixture(t);f.store.db.exec(`DROP ${name==='asset_import_open_session'?'INDEX':'TABLE'} ${name}`);
  assert.throws(()=>new AssetStore({store:f.store,root:f.root,inputRoot:join(f.root,'comfy-input')}),/missing after migration/);
  assert.equal(f.store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name),undefined);
});

test('asset import refuses changed primary-key collation and changed partial-index predicate',async t=>{
  for(const mode of ['pk','index']){
    const f=await fixture(t);
    if(mode==='pk'){const sql=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='asset_import_abandons'").get().sql;f.store.db.exec('DROP TABLE asset_import_abandons');f.store.db.exec(sql.replace('session_id TEXT','session_id TEXT COLLATE NOCASE'));}
    else{f.store.db.exec("DROP INDEX asset_import_open_session; CREATE UNIQUE INDEX asset_import_open_session ON asset_import_receipts(session_id) WHERE state='committed'");}
    assert.throws(()=>new AssetStore({store:f.store,root:f.root,inputRoot:join(f.root,'comfy-input')}),/schema is invalid|unique index differs/,mode);
  }
});

test('asset receipt deletion or asset metadata change is detected on restart',async t=>{
  for(const mode of ['row','metadata']){
    const f=await fixture(t),created=await f.assets.addWithReceipt('owner',f.input);
    if(mode==='row')f.store.db.prepare('DELETE FROM asset_import_receipts WHERE request_id=?').run(f.input.requestId);
    else f.store.db.prepare('UPDATE assets SET json=? WHERE id=?').run('{}',created.asset.id);
    assert.throws(()=>new AssetStore({store:f.store,root:f.root,inputRoot:join(f.root,'comfy-input')}),/manifest differs|receipt evidence differs/,mode);
  }
});

test('asset reservation rolls back before file writes when its manifest cannot be updated',async t=>{
  const f=await fixture(t);f.store.db.exec("CREATE TRIGGER fail_asset_manifest BEFORE UPDATE ON meta WHEN NEW.key='assetImportManifest:v1' BEGIN SELECT RAISE(ABORT,'injected manifest'); END");
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),/injected manifest/);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,0);
  await assert.rejects(readdir(join(f.root,'data','assets')),e=>e.code==='ENOENT');
});

test('an abandonment audit prevents rebaseline after asset receipt and marker loss',async t=>{
  const entered=pause(),resume=pause(),f=await fixture(t,{normalize:async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}}),pending=f.assets.addWithReceipt('owner',f.input);await entered.promise;
  try{const {receipt}=await f.assets.findImportByRequest('owner',f.input.requestId);f.assets.abandonImport('owner',{requestId:receipt.requestId,payloadHash:receipt.payloadHash,assetId:receipt.assetId,originalSha256:receipt.originalSha256});
    f.store.db.exec("DELETE FROM asset_import_abandons; DELETE FROM asset_import_receipts; DELETE FROM meta WHERE key IN ('assetImportSchema:v1','assetImportManifest:v1')");
    assert.throws(()=>new AssetStore({store:f.store,root:f.root,inputRoot:join(f.root,'comfy-input')}),/abandonment audit has no matching receipt/);
  }finally{resume.release();await assert.rejects(pending);}
});

test('committed import is tied to owner, exact request and saved bytes; replay makes no second asset',async t=>{
  const f=await fixture(t),one=await f.assets.addWithReceipt('owner',f.input),receipt=one.receipt;
  assert.equal(one.created,true);assert.equal(receipt.payloadHash,hash(JSON.stringify(f.input)));assert.equal(receipt.originalSha256,hash(Buffer.from(f.input.dataBase64,'base64')));assert.equal(receipt.assetId,one.asset.id);
  assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).asset.id,one.asset.id);
  const repeated=await f.assets.addWithReceipt('owner',f.input);assert.equal(repeated.created,false);assert.equal(repeated.asset.id,one.asset.id);
  await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,filename:'changed.png'}),error=>error.status===409);
  await assert.rejects(f.assets.findImportByRequest('other',f.input.requestId),error=>error.status===404&&/未観測/.test(error.message));
  await assert.rejects(f.assets.findImportByRequest('owner',randomUUID()),error=>error.status===404);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  const rows=JSON.stringify(f.store.db.prepare('SELECT * FROM asset_import_receipts').all());assert.ok(!rows.includes(f.input.dataBase64));assert.ok(!rows.includes('synthetic-private-image'));
});

test('an interrupted import remains pending, blocks another receipt import and retains existing files',async t=>{
  const entered=pause(),resume=pause(),f=await fixture(t,{normalize:async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}});
  const pending=f.assets.addWithReceipt('owner',f.input);await entered.promise;
  try{
    const observed=await f.assets.findImportByRequest('owner',f.input.requestId);assert.equal(observed.receipt.state,'started');assert.equal(observed.asset,undefined);
    assert.deepEqual(await readFile(join(f.root,'data','assets',observed.receipt.assetId,'original.bin')),Buffer.from(f.input.dataBase64,'base64'));
    await assert.rejects(f.assets.addWithReceipt('owner',f.input),error=>error.status===503);
    await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,requestId:randomUUID()}),error=>error.status===503);
    const {requestId:ignored,...legacy}=f.input;await assert.rejects(f.assets.add('owner',legacy),error=>error.status===503,'legacy request must not bypass pending import');
    const secondStore=new RunStore(f.dbPath),second=new AssetStore({store:secondStore,root:f.root,inputRoot:join(f.root,'comfy-input'),normalize:async()=>{throw Error('must not run');}});
    try{assert.equal((await second.findImportByRequest('owner',f.input.requestId)).receipt.state,'started');}finally{secondStore.close();}
    resume.release();const result=await pending;assert.equal(result.receipt.state,'committed');assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).asset.id,result.asset.id);
  }finally{resume.release();await pending.catch(()=>{});}
});

test('an in-flight legacy request reserves the session before filesystem work',async t=>{
  const entered=pause(),resume=pause(),f=await fixture(t,{normalize:async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}});
  const {requestId,...legacy}=f.input,pending=f.assets.add('owner',legacy);await entered.promise;
  try{
    await assert.rejects(f.assets.addWithReceipt('owner',f.input),error=>error.status===503);
    await assert.rejects(f.assets.add('owner',legacy),error=>error.status===503);
    resume.release();const result=await pending;assert.ok(result.id);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM asset_import_receipts WHERE state='started'").get().n,0);
  }finally{resume.release();await pending.catch(()=>{});}
});

test('normalization or DB failure after admission stays pending and does not erase the image',async t=>{
  const f=await fixture(t,{normalize:async()=>{throw Error('invalid image');}});
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),error=>error.status===503);
  const pending=await f.assets.findImportByRequest('owner',f.input.requestId);assert.equal(pending.receipt.state,'started');
  assert.deepEqual(await readFile(join(f.root,'data','assets',pending.receipt.assetId,'original.bin')),Buffer.from(f.input.dataBase64,'base64'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
  const g=await fixture(t);g.store.db.exec("CREATE TRIGGER reject_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(g.assets.addWithReceipt('owner',g.input),error=>error.status===503);
  const second=await g.assets.findImportByRequest('owner',g.input.requestId);assert.equal(second.receipt.state,'started');
  assert.equal(g.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
  assert.deepEqual((await readdir(join(g.root,'data','assets',second.receipt.assetId))).sort(),['image.png','original.bin']);
});

test('pure malformed input is rejected before admission and creates no asset directory',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,dataBase64:'not base64!'}),error=>error.status===400);
  await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,purpose:'unknown'}),error=>error.status===400);
  await assert.rejects(f.assets.addWithReceipt('owner',{...f.input,requestId:'bad'}),error=>error.status===400);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,0);
  await assert.rejects(readdir(join(f.root,'data','assets')),error=>error.code==='ENOENT');
});

test('completed normalization with invalid dimensions is durably rejected and allows corrected input',async t=>{
  const f=await fixture(t,{normalize:async(src,dst)=>{await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:1,height:32};}});
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),error=>error.status===400);
  const failed=await f.assets.findImportByRequest('owner',f.input.requestId);assert.equal(failed.receipt.state,'rejected');assert.equal(failed.asset,undefined);
  assert.deepEqual((await readdir(join(f.root,'data','assets',failed.receipt.assetId))).sort(),['image.png','original.bin']);
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),error=>error.status===400);
  f.assets.normalize=async(src,dst)=>{await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};};
  const corrected=await f.assets.addWithReceipt('owner',{...f.input,requestId:randomUUID()});assert.equal(corrected.receipt.state,'committed');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
});

test('committed receipt refuses metadata or image modifications and does not recreate a missing directory',async t=>{
  const f=await fixture(t),result=await f.assets.addWithReceipt('owner',f.input),directory=join(f.root,'data','assets',result.asset.id);
  await writeFile(join(directory,'image.png'),'modified');await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),error=>error.status===409);
  await rm(join(directory,'image.png'));await rm(join(directory,'original.bin'));await rmdir(directory);
  await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),error=>error.status===409);
  assert.ok(!(await readdir(join(f.root,'data','assets'))).includes(result.asset.id));
});

test('legacy import keeps its original return shape; HTTP lookup checks owner and exact query',async t=>{
  const f=await fixture(t),{requestId,...legacy}=f.input,asset=await f.assets.add('owner',legacy);assert.ok(asset.id);assert.equal(asset.receipt,undefined);
  const saved=await f.assets.addWithReceipt('owner',f.input);
  async function get(owner,query){let output;await assetRoute({req:{method:'GET',url:'/api/assets/by-request'+query,headers:{'x-dsh-session':owner}},res:{},path:'/api/assets/by-request',assets:f.assets,body:async()=>({}),json:(_res,status,value)=>{output={status,value};}});return output;}
  assert.equal((await get('owner',`?requestId=${requestId}`)).value.asset.id,saved.asset.id);
  await assert.rejects(get('other',`?requestId=${requestId}`),error=>error.status===404);
  await assert.rejects(get('owner',`?requestId=${requestId}&requestId=${requestId}`),error=>error.status===400);
});

test('two processes racing on the same request create at most one asset',async t=>{
  const f=await fixture(t),data={root:f.root,path:f.dbPath,input:f.input};
  const script=`import {writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {AssetStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/assets.mjs')).href)};const d=JSON.parse(process.env.ASSET_RECEIPT_FIXTURE),s=new RunStore(d.path),a=new AssetStore({store:s,root:d.root,inputRoot:join(d.root,'comfy-input'),normalize:async(src,dst)=>{await new Promise(r=>setTimeout(r,100));await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}});try{console.log(JSON.stringify({ok:true,value:await a.addWithReceipt('owner',d.input)}));}catch(e){console.log(JSON.stringify({ok:false,status:e.status}));}finally{s.close();}`;
  const run=()=>new Promise((done,fail)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ASSET_RECEIPT_FIXTURE:JSON.stringify(data)},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',fail);child.on('exit',code=>{if(code!==0)fail(new Error(err));else done(JSON.parse(out));});});
  const values=await Promise.all([run(),run()]);assert.equal(values.filter(x=>x.ok&&x.value.created===true).length,1);
  assert.ok(values.every(x=>x.ok||x.status===503));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,1);
});
