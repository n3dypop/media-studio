import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { strataCatalog } from '../apps/controller/strata-catalog.mjs';
import { monitorHandler } from '../apps/dsh-plugins/studio-monitor/index.mjs';

test('Strata catalog separates the verified configuration from observed load state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data/strata');
  const runtime = join(root, 'runtime');
  await Promise.all([mkdir(data, { recursive: true }), mkdir(runtime)]);
  const productRoot = join(root, 'product');
  const configDir = join(productRoot, '.runtime/local-serve');
  await mkdir(configDir, { recursive: true });
  const config = join(configDir, 'serve-config.json');
  const source = JSON.stringify({ model_name: 'fixture', args: ['--native', 'C:/private/weights.gguf', '--max-context', '32768', '--resident-budget-gib', '20'],
    vision: { mmproj: 'C:/private/mmproj.gguf' }, api_key: 'not-for-client' });
  const hash = createHash('sha256').update(source).digest('hex');
  await writeFile(config, source);
  await writeFile(join(data, 'installation.json'), JSON.stringify({
    prepared: true, model: 'fixture', productRoot, config, configSha256: hash, modelSource: { repository: 'fixture/model', quantization: 'Q4' },
  }));
  const record = join(runtime, 'Strata.json');
  const receipt = { processId: 123, started: 42, instanceId: 'epoch', configSha256: hash };
  await writeFile(record, JSON.stringify(receipt));
  const status = { started: 42, model: 'fixture', engine: '0.1.59', loaded: true, vision: { enabled: true, available: false } };
  const strata = { status: async () => status, identity: { pid: 123, instanceId: 'epoch' } };
  const result = await strataCatalog({ root, strata });
  assert.equal(result.configured.weights, 'weights.gguf');
  assert.equal(result.configured.context, 32768);
  assert.equal(result.configured.residentRamBudgetBytes, 20 * 1024 ** 3);
  assert.equal(result.running.state, 'loaded');
  assert.equal(result.running.vision, 'unknown');
  assert.equal(result.configurationMatch, true);
  assert.doesNotMatch(JSON.stringify(result), /private|not-for-client/);
  status.loaded = false;
  await writeFile(record, JSON.stringify({ ...receipt, configSha256: 'f'.repeat(64) }));
  const changed = await strataCatalog({ root, strata });
  assert.equal(changed.running.state, 'unloaded');
  assert.equal(changed.configurationMatch, false);
  await writeFile(config, source + ' ');
  const unverified = await strataCatalog({ root, strata });
  assert.equal(unverified.configured, null);
  assert.equal(unverified.configurationMatch, null);
});

test('catalog forwarding is read-only and checks an existing conversation', async () => {
  const calls = [];
  const handler = monitorHandler({
    filters: ['media', 'page'],
    sessionQuery: { observeSession: async id => { if (id !== 'mine') throw Error(); } },
    controllerRequest: async ({ sessionId, params }) => { calls.push([sessionId, ...params]); return {}; },
  });
  const request = (query, method) => handler(new Request('http://localhost/catalog?' + query, { method }));
  assert.equal((await request('sessionId=mine&media=video&page=2')).status, 200);
  assert.equal((await request('sessionId=other&media=video')).status, 404);
  assert.equal((await request('sessionId=mine&media=video&media=image')).status, 400);
  assert.equal((await request('sessionId=mine&path=elsewhere')).status, 400);
  assert.equal((await request('sessionId=mine', 'POST')).status, 405);
  assert.deepEqual(calls, [['mine', ['media', 'video'], ['page', '2']]]);
});

async function monitorClient(react = {}, options = {}) {
  let entry;
  const source = await readFile(new URL('../apps/dsh-plugins/studio-monitor/client.js', import.meta.url), 'utf8');
  runInNewContext(source, { console, window: { requestAnimationFrame() {}, cancelAnimationFrame() {}, ...options, __ModuleLoader__: { load: value => { entry = value; } } } });
  return entry.factory(id => id === 'react' ? react : { Button() {} });
}

test('right-pane settings default to manual and preserve an explicit legacy choice', async () => {
  const values = new Map();
  const client = await monitorClient({}, {localStorage:{getItem:key=>values.get(key)??null}});
  assert.equal(client.readPanePreferences().open,'manual');
  values.set('studio-monitor.auto-open.v1','true');
  assert.equal(client.readPanePreferences().open,'resources');
  values.set('studio-monitor.pane-preferences.v1',JSON.stringify({open:'both',placement:'catalogLeft'}));
  assert.equal(client.readPanePreferences().open,'both');
  assert.equal(client.readPanePreferences().placement,'catalogLeft');
  values.set('studio-monitor.pane-preferences.v1','invalid');
  assert.equal(client.readPanePreferences().open,'manual');
});

test('auto-open uses an empty or guide-only collapsed pane and requests DSH horizontal placement for the second tab', async () => {
  const {autoOpenPanes}=await monitorClient(),opened=[];
  let expanded=false,active={kind:'guide',id:'guide'};
  const sidebar={isExpanded:()=>expanded,active:()=>active,openTab:(kind,options)=>opened.push({kind,...options})};
  autoOpenPanes(sidebar,{open:'manual',placement:'tabs'},true);
  autoOpenPanes(sidebar,{open:'both',placement:'catalogLeft'},false);
  expanded=true;autoOpenPanes(sidebar,{open:'both',placement:'catalogLeft'},true);
  expanded=false;active={kind:'files',id:'file'};autoOpenPanes(sidebar,{open:'both',placement:'catalogLeft'},true);
  assert.deepEqual(opened,[]);
  active=undefined;
  assert.equal(autoOpenPanes(sidebar,{open:'resources',placement:'tabs'},true),true);
  assert.deepEqual(opened.splice(0),[{kind:'studio-monitor'}]);
  autoOpenPanes(sidebar,{open:'both',placement:'catalogLeft'},true);
  assert.deepEqual(opened.splice(0),[{kind:'studio-catalog'},{kind:'studio-monitor',preferNewPane:true}]);
  active={kind:'guide',id:'guide'};
  autoOpenPanes(sidebar,{open:'both',placement:'catalogLeft'},true);
  assert.deepEqual(opened.splice(0),[{kind:'studio-catalog',replaceTab:'guide'},{kind:'studio-monitor',preferNewPane:true}]);
  autoOpenPanes(sidebar,{open:'both',placement:'resourcesLeft'},true);
  assert.deepEqual(opened.splice(0),[{kind:'studio-monitor',replaceTab:'guide'},{kind:'studio-catalog',preferNewPane:true}]);
  autoOpenPanes(sidebar,{open:'both',placement:'tabs'},true);
  assert.deepEqual(opened.splice(0),[{kind:'studio-monitor',replaceTab:'guide'},{kind:'studio-catalog',preferNewPane:false}]);
  autoOpenPanes(sidebar,{open:'catalog',placement:'tabs'},true);
  assert.deepEqual(opened,[{kind:'studio-catalog',replaceTab:'guide'}]);
});

test('auto-open reacts to conversation selection without a header and skips superseded selections', async () => {
  const frames=new Map(),listeners=new Set(),opened=[],cleanups=[];
  let mounted,active,expanded=false,nextFrame=0,wide=true,settings,closeSettings,saved=JSON.stringify({open:'manual',placement:'resourcesLeft'});
  const client=await monitorClient({
    createElement:(type,props,...children)=>({type,props,children}),
    useState:value=>[typeof value==='function'?value():value,()=>{}],
    useRef:current=>({current}),useEffect:callback=>{closeSettings=callback();},
  }, {
    localStorage:{getItem:()=>saved,setItem:(_key,value)=>{saved=value;}},
    matchMedia:query=>({matches:query==='(min-width: 768px)'&&wide}),
    requestAnimationFrame:callback=>{frames.set(++nextFrame,callback);return nextFrame;},
    cancelAnimationFrame:frame=>frames.delete(frame),
  });
  client.apply({
    effect:fn=>cleanups.push(fn()),locale:{register(){}},
    slots:{inject(name,callback){if(name==='settings.general.item')callback();},register(slot,render){settings={slot,render};}},
    sidebarRightTabs:{register(){}},
    sidebarRight:{
      mounted:{getSnapshot:()=>mounted,subscribe:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}},
      isExpanded:()=>expanded,active:()=>active,
      openTab:(kind,options)=>{opened.push({session:mounted,kind,...options});active={kind};expanded=true;},
    },
  });
  function select(value){mounted=value;for(const callback of listeners)callback();}
  function paint(){const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();}
  select('first');paint();paint();assert.deepEqual(opened,[]);
  const form=settings.render(settings.slot.inject());
  form.children[2].children[1].props.onChange({target:{value:'both'}});
  assert.deepEqual(opened,[]);
  closeSettings();paint();select('new');paint();paint();
  assert.deepEqual(opened.splice(0),[
    {session:'new',kind:'studio-monitor'},
    {session:'new',kind:'studio-catalog',preferNewPane:true},
  ]);
  expanded=false;select(undefined);select('new');paint();paint();assert.deepEqual(opened,[]);
  active=undefined;settings.render(settings.slot.inject()).children[2].children[1].props.onChange({target:{value:'catalog'}});
  closeSettings();paint();paint();assert.deepEqual(opened.splice(0),[{session:'new',kind:'studio-catalog'}]);
  active=undefined;expanded=false;wide=false;select('narrow');paint();paint();assert.deepEqual(opened,[]);
  select('pending');for(const dispose of cleanups)dispose?.();paint();paint();
  assert.equal(listeners.size,0);assert.deepEqual(opened,[]);
});

test('Strata model cards distinguish configured, loaded, unloaded and unverified states', async () => {
  const { CoreModel, apply } = await monitorClient({
    createElement: (type, props, ...children) => ({ type, props, children }),
  });
  let labels;
  apply({
    effect: fn => fn(),
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    locale: { register: (_, dictionaries) => { labels = dictionaries.ja; } },
    sidebarRightTabs: { register() {} },
    slots: { inject() {} },
  });
  const configured = { model: 'startup-model' };
  const loaded = { model: 'live-model', state: 'loaded' };
  const render = (running, configurationMatch = null) => CoreModel({
    data: { configured, running, configurationMatch }, t: key => labels[key],
  });
  const stats = view => view.children[0].children.map(card => card.children.map(part => part.children[0]));
  const verified = render(loaded, true);
  assert.deepEqual(stats(verified), [['起動設定のモデル', 'startup-model'], ['ロード済みモデル', 'live-model']]);
  assert.equal(verified.children[1], null);
  assert.deepEqual(stats(render({ ...loaded, state: 'unloaded' }))[1], ['ロード済みモデル', '未ロード']);
  assert.deepEqual(stats(render(null))[1], ['ロード済みモデル', '確認できません']);
  assert.match(JSON.stringify(render(loaded, false).children[1]), /起動時と設定が異なります/);
});

test('Catalog is beside Resources and opens its own pane in the mounted conversation', async () => {
  const client = await monitorClient({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect() {}, useState: value => [value, () => {}],
  });
  const tabs = [], slots = [], opened = [], draftRequests = [];
  let mounted = 'current', draftResult = 'applied';
  const binding = { id: 'current' };
  client.apply({
    effect: fn => fn(),
    locale: { register() {}, bind: () => key => key },
    sessions: { binding: id => { assert.equal(id, binding.id); return binding; } },
    conversation: { input: { requestDraftInitialization: (target, options) => {
      draftRequests.push({ target, ...options });
      return draftResult;
    } } },
    sidebarRight: { mounted: { getSnapshot: () => mounted, subscribe: () => () => {} }, openTab: kind => opened.push(kind) },
    sidebarRightTabs: { register: tab => tabs.push(tab) },
    slots: { inject: (_, register) => register(), register: (slot, render) => slots.push({ ...slot, render }) },
  });
  assert.deepEqual(tabs.map(tab => tab.kind), ['studio-monitor', 'studio-catalog']);
  assert.equal(tabs[1].title(), 'Catalog');
  const tabTitle = slots.find(slot => slot.name === 'sidebar.right.pane.tab.title' && slot.key === 'studio-catalog');
  assert.equal(tabTitle.render({ useTabInfo: () => ({ tab: { title: 'カタログ' } }) }), 'Catalog');
  const utility = slots.find(slot => slot.name === 'conversation.session.header.utilities');
  const buttons = client.PaneButtons(utility.inject('current')).children.filter(Boolean);
  assert.deepEqual(buttons.map(button => button.children[0].children[1]), ['Catalog', 'Resources']);
  buttons.forEach(button => button.props.onClick());
  assert.deepEqual(opened, ['studio-catalog', 'studio-monitor']);
  const dock = slots.find(slot => slot.name === 'conversation.input.dock');
  const dockProps = dock.inject('current');
  assert.equal(dock.render({ ...dockProps, session: { blank: false } }), null);
  const launcher = dock.render({ ...dockProps, session: { blank: true } });
  assert.equal(launcher.props.composer, true);
  client.PaneButtons(launcher.props).children[0].props.onClick();
  assert.equal(opened.at(-1), 'studio-catalog');

  const catalog = slots.find(slot => slot.name === 'sidebar.right.pane.tab' && slot.key === 'studio-catalog');
  const { appendPrompt } = catalog.inject('current');
  assert.equal(appendPrompt('workflow prompt'), true);
  assert.deepEqual(draftRequests[0], { target: binding, prompt: 'workflow prompt', whenDraftExists: 'append' });
  draftResult = 'blocked';
  assert.equal(appendPrompt('blocked prompt'), false);
  mounted = 'different';
  assert.equal(appendPrompt('stale prompt'), false);
  assert.equal(draftRequests.length, 2);
});

test('workflow prompts retain the exact managed profile and hand off standalone workflows', async () => {
  const { workflowPrompt } = await monitorClient();
  const row = { family: 'MOSS-Image', label: 'Text to image', mode: 't2i', dshProfile: 'moss-image-sft-int8-v1', state: 'static-ready' };
  assert.match(workflowPrompt(row, true), /MOSS-Image \/ Text to image.*moss-image-sft-int8-v1.*t2i/);
  assert.match(workflowPrompt({ ...row, state: 'dependencies-missing' }, false), /Check its dependencies and availability/);
  const standalone = { family: 'ControlNet', label: 'Pose', file: 'ControlNet/pose.json' };
  assert.match(workflowPrompt(standalone, true), /ComfyUI単体.*ControlNet\/pose\.json.*実行手順/);
  assert.match(workflowPrompt(standalone, false), /^Explain the required inputs.*standalone ComfyUI/);
  assert.match(workflowPrompt({ ...standalone, unavailableDshProfile: 'sd15-pose-v1', mode: 'pose' }, true), /sd15-pose-v1.*pose.*保守作業/);
});
