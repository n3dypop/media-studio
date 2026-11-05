// Service management remains available when Controller or the model is stopped.
window.__ModuleLoader__.load({
  id:'studio-services',
  factory(require){
    const {createElement:h,useEffect,useSyncExternalStore}=require('react');
    const {Button}=require('@deepseek-ai/dsh-client-ui-primitives');
    const PATH='/api/local-studio/services',PENDING_KEY='studio-services.pending.v1';
    const SERVICES=['Strata','ComfyUI','Controller'],ACTIONS=['start','stop','restart','unload'];
    const SETTINGS_PATH='/api/local-studio/service-settings';
    const PATH_FIELDS=[['comfyDirectory','ComfyUI folder'],['comfyPythonExecutable','ComfyUI Python'],['strataPythonExecutable','Strata Python'],['controllerNodeExecutable','Controller Node.js']];
    const en={title:'Services','paths.title':'Service paths',start:'Start',stop:'Stop',restart:'Restart',unload:'Unload',refresh:'Refresh',checking:'Checking…',checkReceipt:'Check receipt',retrySameRequest:'Retry same request','paths.comfyDirectory':'ComfyUI folder','paths.comfyPythonExecutable':'ComfyUI Python','paths.strataPythonExecutable':'Strata Python','paths.controllerNodeExecutable':'Controller Node.js','paths.save':'Save paths','paths.saving':'Saving…','paths.reload':'Reload paths','paths.loading':'Loading…'};
    // BEGIN GENERATED JAPANESE DICTIONARY
    const ja={
      "title": "サービス",
      "paths.title": "起動パス",
      "start": "起動",
      "stop": "停止",
      "restart": "再起動",
      "unload": "リソース解放",
      "refresh": "更新",
      "checking": "確認中…",
      "checkReceipt": "受付記録を確認",
      "retrySameRequest": "同じ要求を再試行",
      "paths.comfyDirectory": "ComfyUIフォルダー",
      "paths.comfyPythonExecutable": "ComfyUI Python",
      "paths.strataPythonExecutable": "Strata Python",
      "paths.controllerNodeExecutable": "Controller Node.js",
      "paths.save": "パスを保存",
      "paths.saving": "保存中…",
      "paths.reload": "パスを再読み込み",
      "paths.loading": "読み込み中…"
    };
    // END GENERATED JAPANESE DICTIONARY
    const defaultText=key=>en[key]??key;
    const terminal=new Set(['completed','failed','cancelled','succeeded']);
    const stateNames={running:'稼働中',ready:'稼働中',stopped:'停止中',starting:'起動中',stopping:'停止中…',restarting:'再起動中',unknown:'確認できません',unavailable:'確認できません',unmanaged:'管理外のプロセス',failed:'失敗',error:'確認が必要',checking:'確認中',queued:'待機中',completed:'完了',succeeded:'完了',pending:'待機中',cancelled:'停止済み',active:'処理中'};
    const css=`
      .studio-services{color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-family-text,inherit);font-size:12px;line-height:1.55;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);padding:14px;margin:0 0 12px;box-sizing:border-box}
      .studio-services *{box-sizing:border-box}.studio-services h3,.studio-services p{margin:0}.ss-heading,.ss-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.ss-heading{margin-bottom:12px}.ss-heading h3{font-size:14px;font-weight:650}.ss-muted{color:var(--dsw-alias-label-secondary);font-size:11px}.ss-list{display:grid;gap:10px}.ss-service{padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-2);min-width:0}.ss-service strong{font-size:13px}.ss-state{font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 7px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.ss-state[data-state=running],.ss-state[data-state=ready]{color:var(--dsw-alias-state-success-primary)}.ss-state[data-state=unknown],.ss-state[data-state=failed]{color:var(--dsw-alias-state-warn-primary)}.ss-buttons{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.ss-detail{margin-top:6px!important;overflow-wrap:anywhere}.ss-notice{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);margin-top:10px!important;overflow-wrap:anywhere}.ss-operation{margin-top:12px;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px}.ss-operation ol{padding-left:20px;margin:8px 0 0}.ss-operation li{padding:3px 0;overflow-wrap:anywhere}.ss-paths{margin-top:12px}.ss-paths summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px}.ss-paths dl{display:grid;gap:3px;margin:8px 0 0}.ss-paths dt{font-size:11px;color:var(--dsw-alias-label-secondary)}.ss-paths dd{margin:0 0 7px;overflow-wrap:anywhere;font-size:11px;white-space:pre-wrap}.ss-settings{padding-top:10px}.ss-settings>.ss-muted{margin:0 0 10px}
      .ss-operation-details{margin-top:9px}.ss-operation-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px}
      .ss-path-editor{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}.ss-path-editor h4{font-size:13px;font-weight:650;margin:0 0 8px}.ss-path-field{display:grid;gap:5px;margin:12px 0;font-size:11px;color:var(--dsw-alias-label-secondary)}.ss-path-field input{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.ss-path-field input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.ss-path-field input:disabled{opacity:.65}
    `;
    const operationState=operation=>operation?.state??operation?.phase??operation?.status??null;
    const operationBusy=operation=>Boolean(operation&&!terminal.has(operationState(operation)));
    function serviceRows(value){
      const source=value?.services;
      return SERVICES.map(id=>{const row=Array.isArray(source)?source.find(item=>(item.id??item.service??item.name)===id):source?.[id]??source?.[id.toLowerCase()];return {id,...(row&&typeof row==='object'?row:{}),state:row?.state??row?.status??'unknown'};});
    }
    const validIntent=value=>value&&SERVICES.includes(value.service)&&ACTIONS.includes(value.action)&&typeof value.requestId==='string'&&/^[a-f0-9-]{36}$/i.test(value.requestId);
    async function desktopProof(target,signal){
      if(window.location?.protocol!=='dsh-app:'||window.location.host!=='app')return null;
      const response=await fetch('/api/local-studio/desktop-proof/'+target,{credentials:'same-origin',cache:'no-store',headers:{'X-Local-Studio-Proof-Request':'1'},signal});
      if(!response.ok)throw Object.assign(Error('Desktopの操作権限を確認できません。'),{definite:true});
      const value=await response.json();if(typeof value?.proof!=='string')throw Object.assign(Error('Desktopの操作権限を確認できません。'),{definite:true});
      return value.proof;
    }
    async function servicesRequest(body,{signal,requestId}={}){
      const url=!body&&requestId?PATH+'?'+new URLSearchParams({requestId}):PATH;
      const headers=body?{'Content-Type':'application/json','X-Local-Studio-Service':'1'}:{};
      const proof=body?await desktopProof('services',signal):null;if(proof)headers['X-Local-Studio-Desktop-Proof']=proof;
      const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers,...(body?{body:JSON.stringify(body)}:{}),signal});
      let result;try{result=await response.json();}catch{throw Error('サービス管理の応答を確認できません。');}
      if(!response.ok)throw Object.assign(Error(typeof result.error==='string'?result.error:'サービス管理を実行できません。'),{definite:response.status>=400&&response.status<500,status:response.status});
      return result;
    }
    function createController({request=servicesRequest,storage=null,uuid=()=>window.crypto.randomUUID(),visibility=()=>document.visibilityState,timer=setTimeout,clear=clearTimeout}={}){
      const listeners=new Set();let active=0,disposed=false,pollTimer=null,inflight=null,postLock=false;
      let pending=null;try{const value=JSON.parse(storage?.getItem(PENDING_KEY)??'null');if(validIntent(value))pending=value;}catch{}
      let state={value:null,loading:false,error:'',pending,uncertain:Boolean(pending),posting:false};
      const publish=patch=>{if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();};
      const savePending=value=>{pending=value;try{value?storage?.setItem(PENDING_KEY,JSON.stringify(value)):storage?.removeItem(PENDING_KEY);}catch{}};
      const reconcile=value=>{
        const operation=value?.operation;
        if(pending&&operation?.requestId===pending.requestId){
          if(terminal.has(operationState(operation)))savePending(null);
          publish({value,pending,uncertain:false,error:''});
        }else publish({value,pending,error:''});
      };
      const schedule=()=>{if(disposed||active===0)return;clear(pollTimer);pollTimer=timer(()=>{pollTimer=null;void poll();},5000);};
      async function refresh(){
        if(disposed)return;
        if(inflight)return inflight.promise;
        const abort=new AbortController();publish({loading:!state.value});
        const promise=(async()=>{try{const value=await request(null,{requestId:pending?.requestId,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(20000)])});if(!disposed&&!abort.signal.aborted)reconcile(value);}catch(e){if(!disposed&&!abort.signal.aborted)publish({error:typeof e.message==='string'?e.message:'サービス状態を確認できません。'});}finally{if(inflight?.abort===abort){inflight=null;if(!disposed)publish({loading:false});}}})();
        inflight={abort,promise};return promise;
      }
      async function poll(){if(disposed||active===0)return;if(visibility()!=='hidden')await refresh();schedule();}
      async function submitIntent(intent,{retry=false}={}){
        postLock=true;inflight?.abort.abort();inflight=null;
        savePending(intent);publish({pending,posting:true,uncertain:false,error:''});
        try{
          const value=await request(intent,{signal:AbortSignal.timeout(30000)});
          if(disposed)return true;
          if(value?.operation?.requestId===intent.requestId)reconcile({...state.value,...value});
          else publish({uncertain:true,error:'受付結果を照合しています。状態を確認し、自動再送はしません。'});
          return true;
        }catch(e){
          if(disposed)return false;
          if(e.definite&&!retry){savePending(null);publish({pending:null,uncertain:false,error:e.message});}
          else publish({uncertain:true,error:'受付結果を確認できません。状態を照合し、同じ操作を自動再送しません。'});
          return false;
        }finally{postLock=false;publish({posting:false});if(active)void refresh();}
      }
      async function act(service,action){
        if(disposed||postLock||state.uncertain||operationBusy(state.value?.operation)||pending)return false;
        if(!SERVICES.includes(service)||!ACTIONS.includes(action)||action==='unload'&&service==='Controller')throw Error('未対応のサービス操作です。');
        const intent={service,action,requestId:uuid()};if(!validIntent(intent))throw Error('操作IDを作成できません。');
        return submitIntent(intent);
      }
      async function retryPending(){
        if(disposed||postLock||!pending||!state.uncertain||!state.value||state.value.operation)return false;
        // Explicit user retry only: backend deduplicates this exact request ID.
        return submitIntent(pending,{retry:true});
      }
      return {snapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},refresh,act,retryPending,
        activate(){if(disposed)return()=>{};active++;if(active===1)void poll();let live=true;return()=>{if(!live)return;live=false;active--;if(active===0){clear(pollTimer);pollTimer=null;const current=inflight;inflight=null;current?.abort.abort();}};},
        dispose(){disposed=true;clear(pollTimer);inflight?.abort.abort();listeners.clear();}};
    }
    function Operation({operation}){
      if(!operation)return null;
      const state=operationState(operation),steps=Array.isArray(operation.steps)?operation.steps:[];
      if(['completed','succeeded','cancelled'].includes(state))return null;
      const needsAttention=['failed','unknown','error','unavailable'].includes(state);
      const current=steps.find(step=>step&&typeof step==='object'&&['running','active','starting','stopping','restarting'].includes(step.state??step.status));
      return h('section',{className:'ss-operation','aria-label':'サービス操作の進行',role:needsAttention?'alert':'status'},h('div',{className:'ss-row'},h('strong',null,`${operation.service??''} ${{start:'起動',stop:'停止',restart:'再起動',unload:'リソース解放'}[operation.action]??'操作'}`),h('span',{className:'ss-state','data-state':state},['running','active'].includes(state)?'処理中':stateNames[state]??'状態を確認中')),
        needsAttention&&operation.detail?h('p',{className:'ss-muted ss-detail'},String(operation.detail)):null,
        !needsAttention&&current?h('p',{className:'ss-muted ss-detail'},String(current.label??current.name??current.service??'サービスを準備中')):null,
        operation.error?h('p',{className:'ss-notice'},String(operation.error?.message??operation.error)):null,
        needsAttention&&steps.length?h('details',{className:'ss-operation-details'},h('summary',null,'診断用の操作記録'),h('ol',null,...steps.map((step,i)=>h('li',{key:i},typeof step==='string'?step:`${step.label??step.name??step.service??'手順'}${step.state||step.status?' · '+(stateNames[step.state??step.status]??step.state??step.status):''}`)))):null);
    }
    async function settingsRequest(body,{signal}={}){
      const headers=body?{'Content-Type':'application/json','X-Local-Studio-Service-Settings':'1'}:{};
      const proof=body?await desktopProof('service-settings',signal):null;if(proof)headers['X-Local-Studio-Desktop-Proof']=proof;
      const response=await fetch(SETTINGS_PATH,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers,...(body?{body:JSON.stringify(body)}:{}),signal});
      let value;try{value=await response.json();}catch{throw Error('起動パス設定の応答を確認できません。');}
      if(!response.ok)throw Object.assign(Error(typeof value.error==='string'?value.error:'起動パス設定を取得できません。'),{definite:response.status>=400&&response.status<500,status:response.status});
      if(typeof value.revision!=='string'||!PATH_FIELDS.every(([key])=>typeof value.values?.[key]==='string'))throw Error('起動パス設定の内容を確認できません。');
      return value;
    }
    function createSettingsController({request=settingsRequest}={}){
      const listeners=new Set();let disposed=false,active=0,read=null,saveLock=false;
      let state={value:null,draft:null,loading:false,saving:false,error:'',message:'',uncertain:false};
      const publish=patch=>{if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();};
      const adopt=value=>publish({value,draft:{...value.values},error:'',uncertain:false});
      async function reload(){
        if(disposed||saveLock)return;
        read?.abort.abort();const abort=new AbortController(),current={abort};read=current;
        publish({loading:true,error:'',message:''});
        const promise=(async()=>{try{const value=await request(null,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(20000)])});if(!disposed&&read===current&&!abort.signal.aborted)adopt(value);}catch(e){if(!disposed&&read===current&&!abort.signal.aborted)publish({error:e.message});}finally{if(read===current){read=null;publish({loading:false});}}})();
        current.promise=promise;return promise;
      }
      async function save(){
        if(disposed||saveLock||state.loading||state.uncertain||!state.value||!state.draft)return false;
        saveLock=true;const body={expectedRevision:state.value.revision,values:{...state.draft}};publish({saving:true,error:'',message:''});
        try{const value=await request(body,{signal:AbortSignal.timeout(30000)});if(!disposed){adopt(value);publish({message:'保存しました。次回のサービス起動から使用します。'});}return true;}
        catch(e){if(!disposed)publish({uncertain:!e.definite,error:e.definite?e.message:'保存結果を確認できません。Reload pathsで保存済みの値を確認してください。自動再送はしません。'});return false;}
        finally{saveLock=false;publish({saving:false});}
      }
      return {snapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},reload,save,
        change(key,value){if(!disposed&&!state.loading&&!saveLock&&PATH_FIELDS.some(([field])=>field===key))publish({draft:{...state.draft,[key]:value},message:''});},
        activate(){if(disposed)return()=>{};active++;if(active===1&&!state.value)void reload();let live=true;return()=>{if(!live)return;live=false;active--;if(active===0&&read){const pending=read;read=null;pending.abort.abort();publish({loading:false});}};},
        dispose(){disposed=true;read?.abort.abort();listeners.clear();}};
    }
    function Paths({controller,canSave=false,t=defaultText}){
      const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
      useEffect(()=>controller.activate(),[controller]);
      return h('section',{className:'ss-path-editor','aria-label':'Service paths'},h('h4',null,t('paths.title')),
        h('p',{className:'ss-muted'},'Strata・ComfyUI・Controllerを停止してから保存します。保存だけでは起動・再起動しません。'),
        ...PATH_FIELDS.map(([key,label])=>h('label',{key,className:'ss-path-field'},h('span',null,t('paths.'+key)),h('input',{type:'text','aria-label':label,value:state.draft?.[key]??'',disabled:state.loading||state.saving||!state.value,maxLength:4096,spellCheck:false,autoComplete:'off',onChange:e=>controller.change(key,e.target.value)}))),
        h('p',{className:'ss-muted'},'Strataは導入済みruntimeのPythonを指定します。モデル・入力・出力の場所とDSH自身のNode設定は保持します。'),
        h('div',{className:'ss-buttons'},h(Button,{type:'button',variant:'primary',size:'sm','aria-label':'Save service paths',disabled:!canSave||!state.value||state.loading||state.saving||state.uncertain,onClick:()=>void controller.save()},t(state.saving?'paths.saving':'paths.save')),h(Button,{type:'button',variant:'outline',size:'sm',disabled:state.saving||state.loading,onClick:()=>void controller.reload()},t(state.loading?'paths.loading':'paths.reload'))),
        !canSave?h('p',{className:'ss-muted ss-detail'},'保存するには、上のServicesで3サービスを停止してください。'):null,
        state.error?h('p',{role:'alert',className:'ss-notice'},state.error):null,state.message?h('p',{role:'status',className:'ss-muted ss-detail'},state.message):null);
    }
    function ServicesView({controller,pathController,visible=true,settings=false,t=defaultText}){
      const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
      useEffect(()=>visible?controller.activate():undefined,[controller,visible]);
      const busy=state.posting||state.uncertain||Boolean(state.pending)||operationBusy(state.value?.operation);
      const rows=serviceRows(state.value);
      return h('section',{className:`studio-services${settings?' ss-settings':''}`,'data-studio-services':true,'aria-label':'Services'},h('style',null,css),
        h('header',{className:'ss-heading'},h('h3',null,t('title')),h(Button,{type:'button',size:'sm',variant:'outline',disabled:state.loading,onClick:()=>void controller.refresh()},t(state.loading?'checking':state.uncertain?'checkReceipt':'refresh'))),
        h('p',{className:'ss-muted',style:{marginBottom:10}},'DSHから起動・停止します。処理中や所有状態が不明なサービスは保護されます。'),
        h('div',{className:'ss-list'},...rows.map(service=>h('article',{key:service.id,className:'ss-service','aria-label':`${service.id} service`},h('div',{className:'ss-row'},h('strong',null,service.id),h('span',{className:'ss-state','data-state':service.state},stateNames[service.state]??'確認できません')),
          service.detail?h('p',{className:'ss-muted ss-detail'},String(service.detail)):null,
          h('div',{className:'ss-buttons'},...ACTIONS.filter(action=>action!=='unload'||service.id!=='Controller').map(action=>h(Button,{key:action,type:'button',variant:'outline',size:'sm','aria-label':`${service.id} ${action}`,disabled:!state.value||busy||!['running','ready','stopped'].includes(service.state)||action==='start'&&['running','ready'].includes(service.state)||action!=='start'&&service.state==='stopped'||action==='unload'&&rows.find(row=>row.id==='Controller')?.state!=='running',onClick:()=>void controller.act(service.id,action)},t(action))))))),
        state.error?h('p',{role:'alert',className:'ss-notice'},state.error):state.uncertain?h('p',{role:'status',className:'ss-notice'},'前回の操作の受付を照合しています。同じ操作を自動再送しません。'):null,
        state.uncertain&&state.pending&&state.value&&!state.value.operation?h('div',{className:'ss-buttons'},h(Button,{type:'button',variant:'outline',size:'sm',disabled:state.posting||state.loading,onClick:()=>void controller.retryPending()},t('retrySameRequest')),h('span',{className:'ss-muted'},`${state.pending.service} ${{start:'起動',stop:'停止',restart:'再起動',unload:'リソース解放'}[state.pending.action]}：同じ操作IDで受付を再試行`)):null,
        h(Operation,{operation:state.value?.operation}),
        h('p',{className:'ss-muted',style:{marginTop:10}},'Controllerの起動には必要なサービスも起動します。リソース解放はサービスを止めずモデルをアンロードします。Strataは次の依頼時に再ロードします。'),
        settings&&pathController?h(Paths,{controller:pathController,canSave:!busy&&rows.every(service=>service.state==='stopped'),t}):null);
    }
    function apply(ctx){
      let storage;try{storage=window.sessionStorage;}catch{}
      const controller=createController({storage}),pathController=createSettingsController();ctx.effect(()=>()=>{controller.dispose();pathController.dispose();});
      ctx.effect(()=>ctx.locale.register('studio.services','en',en));
      ctx.effect(()=>ctx.locale.register('studio.services','ja',ja));
      ctx.slots.inject('studio.monitor.services',()=>ctx.slots.register({name:'studio.monitor.services',id:'studio-services',order:10,locale:'studio.services',inject:()=>({controller})},ServicesView));
      ctx.slots.inject('settings.general.item',()=>ctx.slots.register({name:'settings.general.item',id:'studio-services-settings',order:14,locale:'studio.services',inject:()=>({controller,pathController,settings:true})},ServicesView));
    }
    return {inject:['slots','locale'],apply,ServicesView,Operation,Paths,createController,createSettingsController,settingsRequest,servicesRequest,serviceRows,operationState,operationBusy,en,ja};
  },
});
