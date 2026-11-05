import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const h=(type,props,...children)=>({type,props:{...props,children}}),Button=()=>null;
const text=node=>typeof node==='string'?node:node?.props?.children?.map(text).join('')??'';
const walk=node=>node&&typeof node==='object'?[node,...(node.props?.children??[]).flatMap(walk)]:[];
async function setup(available){
  let entry,index=0,refIndex=0,effects=[];const states=[],refs=[],requests=[];
  const React={createElement:h,useEffect:fn=>effects.push(fn),useState(value){const i=index++;if(!(i in states))states[i]=typeof value==='function'?value():value;return [states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next;}];},useRef(value){const i=refIndex++;return refs[i]??(refs[i]={current:value});}};
  const proposal={id:'proposal',phase:'awaiting_approval',kind:'queries',queries:['fixture'],purpose:'test',engine:'duckduckgo',proposalHash:'a'.repeat(64)};
  const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({proposal,searchEnabled:available})};};
  runInNewContext(await readFile(new URL('../apps/dsh-plugins/studio-controls/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:v=>{entry=v;}}},URL,URLSearchParams,AbortController,AbortSignal,setTimeout:()=>0,clearTimeout(){},fetch});
  const module=entry.factory(id=>id==='react'?React:id==='@deepseek-ai/dsh-client-ui-primitives'?{Button}:assert.fail(id));
  const render=()=>{index=0;refIndex=0;effects=[];return module.SearchActions({sessionId:'session',proposalId:'proposal',initialProposal:proposal});};
  const initial=render(),cleanup=effects.map(fn=>fn());await new Promise(setImmediate);const current=render();cleanup.forEach(fn=>fn?.());
  return {initial,current,requests};
}

test('historical search proposals show disabled state and never offer approval while search is unavailable',async()=>{
  const {initial,current,requests}=await setup(false);
  assert.equal(walk(initial).some(x=>x.type===Button&&/送信を許可/.test(text(x))),false);
  assert.match(text(current),/資料検索は無効です/);
  assert.equal(walk(current).some(x=>x.type===Button&&/送信を許可/.test(text(x))),false);
  assert.ok(walk(current).some(x=>x.type===Button&&text(x)==='この検索を停止'));
  assert.equal(requests.filter(x=>x.options.method==='POST').length,0);
});

test('configured search enables approval only after the authenticated state refresh',async()=>{
  const {initial,current}=await setup(true);
  assert.equal(walk(initial).some(x=>x.type===Button&&/送信を許可/.test(text(x))),false);
  assert.ok(walk(current).some(x=>x.type===Button&&/送信を許可/.test(text(x))));
});
