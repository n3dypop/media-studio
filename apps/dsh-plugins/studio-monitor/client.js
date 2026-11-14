// Independent page type in DSH's public right-sidebar extension API.
window.__ModuleLoader__.load({
  id:'local-studio-monitor',
  factory(require){
    const {createElement:h,useEffect,useState}=require('react');
    const {Button}=require('@deepseek-ai/dsh-client-ui-primitives');
    const ID='local-studio-monitor',KIND='studio-monitor',AUTO_KEY='studio-monitor.auto-open.v1';
    const phase={planning:'制作条件を整理',ready:'フロー準備済み',generating:'生成中',awaiting_evaluation:'レビュー待ち',revising:'改善を計画',needs_user:'利用者の確認待ち',completed:'完了',failed:'失敗',cancelled:'停止済み',cancelling:'停止処理中',queued:'キュー待機',preparing:'実行準備',draining_core:'Strataを解放中',enhancing:'プロンプト調整',submitting:'ComfyUIへ送信',submission_unknown:'送信結果を確認中',saving:'成果物を保存中',releasing:'生成資源を解放中',restoring_core:'Strataへ復帰中',recovery_required:'復旧の確認が必要',needs_attention:'確認が必要'};
    const owner={core:'Strata',generator:'ComfyUI',enhancer:'エンハンサー',none:'割当なし',unknown:'確認できません',draining_core:'Strataから切替中',loading_core:'Strataを読込中',restoring_core:'Strataへ復帰中'};
    const css=`
      body[data-studio-wallpaper][data-studio-wallpaper-scope='window'] .studio-monitor{--sm-surface:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 84%,transparent)}
      .studio-monitor{--sm-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-link));--sm-muted:var(--dsw-alias-label-secondary);--sm-border:var(--dsw-alias-border-l1);--sm-surface:var(--dsw-alias-bg-layer-1);font-family:var(--dsh-font-family-text,inherit);color:var(--dsw-alias-label-primary);padding:16px;box-sizing:border-box;font-size:13px;line-height:1.55;min-width:0;overflow:auto;height:100%;scrollbar-gutter:stable}
      .studio-monitor *{box-sizing:border-box}.studio-monitor h2,.studio-monitor h3,.studio-monitor p{margin:0}.studio-monitor h2{font-size:18px;letter-spacing:-.02em}.studio-monitor h3{font-size:14px}.studio-monitor small{font-size:11px}.sm-heading,.sm-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.sm-heading{margin-bottom:16px}.sm-eyebrow{font-size:10px;letter-spacing:.12em;color:var(--sm-muted);font-weight:600}.sm-muted{color:var(--sm-muted);font-size:11px}.sm-card{border:1px solid var(--sm-border);border-radius:16px;padding:16px;margin-bottom:12px;background:var(--sm-surface);box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}.sm-card-title{margin-bottom:14px!important}.sm-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--sm-border);border-radius:999px;padding:3px 8px;white-space:nowrap;font-size:10px;line-height:1.4;color:var(--sm-muted);background:var(--dsw-alias-bg-layer-2)}.sm-badge[data-tone=active]{color:var(--sm-accent);border-color:color-mix(in srgb,var(--sm-accent) 32%,transparent);background:color-mix(in srgb,var(--sm-accent) 10%,var(--sm-surface))}.sm-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary)}.sm-badge[data-tone=warning]{color:var(--dsw-alias-state-warn-primary)}.sm-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary)}.sm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}.sm-service+.sm-service{margin-top:16px;border-top:1px solid var(--sm-border);padding-top:16px}.sm-service-name{display:flex;align-items:center;gap:9px;font-weight:650}.sm-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--sm-border);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--sm-accent)}.sm-statgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.sm-stat{padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.sm-stat-label{font-size:10px;color:var(--sm-muted)}.sm-stat-value{font-size:14px;font-variant-numeric:tabular-nums;font-weight:600;margin-top:2px;overflow-wrap:anywhere}.sm-divider{height:1px;background:var(--sm-border);margin:16px 0}.sm-ownergrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}.sm-owner{padding:10px;border-radius:11px;border:1px solid var(--sm-border);color:var(--sm-muted)}.sm-owner[data-active=true]{border-color:color-mix(in srgb,var(--sm-accent) 60%,var(--sm-border));color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--sm-accent) 10%,var(--sm-surface))}.sm-owner strong{font-size:12px;display:block}.sm-meter{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:7px}.sm-meter-fill{height:100%;border-radius:999px;background:var(--sm-accent);transition:width .25s ease}.sm-meter[data-tone=warning] .sm-meter-fill{background:var(--dsw-alias-state-warn-primary)}.sm-meter[data-tone=error] .sm-meter-fill{background:var(--dsw-alias-state-error-primary)}.sm-usage+.sm-usage{margin-top:12px}.sm-numeric{font-variant-numeric:tabular-nums}.sm-joblist{list-style:none;padding:0;margin:0}.sm-job{border:1px solid var(--sm-border);border-radius:12px;padding:13px;margin-top:10px}.sm-job[data-active=true]{border-color:color-mix(in srgb,var(--sm-accent) 35%,var(--sm-border))}.sm-job-model{margin-top:7px!important;overflow-wrap:anywhere}.sm-job-label{font-size:12px;font-weight:650}.sm-stage-list{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:7px}.sm-stage{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--sm-muted)}.sm-stage-marker{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--sm-border);border-radius:50%;width:17px;height:17px;font-size:10px;flex-shrink:0}.sm-stage[data-state=done] .sm-stage-marker{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--sm-border))}.sm-stage[data-state=current]{color:var(--sm-accent);font-weight:600}.sm-stage[data-state=current] .sm-stage-marker{background:color-mix(in srgb,var(--sm-accent) 14%,transparent);border-color:var(--sm-accent)}.sm-node{margin-top:13px;padding-top:11px;border-top:1px solid var(--sm-border)}.sm-empty{padding:16px 4px;text-align:center;color:var(--sm-muted)}.sm-empty svg{margin-bottom:7px}.sm-notice{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--sm-border));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,var(--sm-surface));border-radius:10px;padding:10px 12px;margin-bottom:12px;color:var(--dsw-alias-label-primary);font-size:12px}.sm-settings{display:flex;align-items:center;gap:7px;color:var(--sm-muted);font-size:11px;margin:12px 0}.sm-settings input{accent-color:var(--sm-accent)}.sm-footnote{font-size:10px;color:var(--sm-muted);margin-top:9px!important}.sm-history{margin-top:12px}.sm-history summary{cursor:pointer;color:var(--sm-muted);font-size:11px;padding:6px 0}.sm-header-button{display:inline-flex;gap:6px;align-items:center}@media(max-width:400px){.studio-monitor{padding:10px}.sm-card{padding:12px}.sm-heading{flex-wrap:wrap}.sm-stat-value{font-size:12px}}@media(prefers-reduced-motion:reduce){.studio-monitor *{transition:none!important}}
      .studio-monitor{container-type:inline-size}.sm-resource-card{padding:14px}.sm-resource-card .sm-card-title{margin-bottom:12px!important}.sm-services{display:grid;gap:12px}.sm-services>.sm-service{min-width:0}.sm-services>.sm-service+.sm-service{margin-top:0;padding-top:12px}.sm-resource-card .sm-icon{width:26px;height:26px;border-radius:8px}.sm-resource-card .sm-statgrid{gap:8px;margin-top:8px}.sm-resource-card .sm-stat{padding:8px 10px}.sm-resource-card .sm-divider{margin:11px 0}.sm-system-grid{display:grid;gap:10px;margin-top:9px}.sm-system-grid>.sm-usage{margin-top:0}.sm-system-grid .sm-numeric{font-size:11px}.sm-resource-card .sm-ownergrid{margin-top:8px;gap:8px}.sm-resource-card .sm-owner{padding:7px 9px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:3px 7px}.sm-resource-card .sm-owner strong{font-size:11px}.sm-resource-card .sm-owner small{font-size:10px}.sm-resource-card .sm-history{margin-top:10px}.sm-scope-service+.sm-scope-service{margin-top:8px}.sm-scope-service strong{font-size:11px}.sm-resource-card .sm-scope-service .sm-footnote{margin-top:3px!important}
      @container (min-width:460px){.sm-services{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.sm-services>.sm-service+.sm-service{padding-top:0;border-top:0;border-left:1px solid var(--sm-border);padding-left:12px}.sm-system-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}}
      @container (max-width:459px){.sm-resource-card .sm-stat-value{font-size:12px}.sm-resource-card .sm-stat{padding:8px 9px}.sm-resource-card{padding:12px}}
      .studio-monitor{--sm-strata:var(--dsw-static-blue-500);--sm-comfy:var(--dsw-static-green-500);--sm-other:var(--dsw-alias-label-tertiary,var(--sm-muted))}.sm-resource-card .sm-owner{align-items:flex-start;flex-direction:column;flex-wrap:nowrap;gap:3px;min-width:0}.sm-resource-card .sm-owner small{white-space:normal;overflow-wrap:anywhere}.sm-meter-stacked{display:flex;height:7px}.sm-meter-segment{height:100%;min-width:0;flex:none}.sm-meter-segment[data-source=strata]{background:var(--sm-strata)}.sm-meter-segment[data-source=comfyui]{background:var(--sm-comfy)}.sm-meter-segment[data-source=other]{background:var(--sm-other)}.sm-meter-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px;font-size:10px;color:var(--sm-muted)}.sm-meter-legend span{display:inline-flex;align-items:center;gap:4px}.sm-meter-key{width:6px;height:6px;border-radius:2px;display:inline-block}.sm-meter-key[data-source=strata]{background:var(--sm-strata)}.sm-meter-key[data-source=comfyui]{background:var(--sm-comfy)}.sm-meter-key[data-source=other]{background:var(--sm-other)}
    `;
    const bytes=value=>Number.isSafeInteger(value)&&value>=0?`${(value/1073741824).toFixed(2)} GiB`:'取得不可';
    const clock=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'時刻不明':d.toLocaleTimeString();};
    const stale=(value,now=Date.now())=>!Number.isFinite(Date.parse(value))||now-Date.parse(value)>30000||Date.parse(value)>now+5000;
    function elapsed(start,end,now=Date.now()){
      const a=Date.parse(start),b=end?Date.parse(end):now;if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '経過時間不明';
      const s=Math.floor((b-a)/1000);return s<60?`${s}秒`:s<3600?`${Math.floor(s/60)}分${s%60}秒`:`${Math.floor(s/3600)}時間${Math.floor(s%3600/60)}分`;
    }
    const ratio=(value,total)=>Number.isSafeInteger(value)&&value>=0&&Number.isSafeInteger(total)&&total>0&&value<=total?value/total:null;
    const readAuto=()=>{try{return window.localStorage.getItem(AUTO_KEY)!=='false';}catch{return true;}};
    const writeAuto=value=>{try{window.localStorage.setItem(AUTO_KEY,String(value));}catch{}};
    function Icon({kind='activity',size=16}){
      const paths={activity:'M3 12h4l3-8 4 16 3-8h4',chip:'M8 8h8v8H8zM9 3v3m6-3v3m-6 12v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01',layers:'m12 3 9 5-9 5-9-5 9-5zm-9 9 9 5 9-5M3 16l9 5 9-5',check:'m5 12 4 4L19 6'};
      return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[kind]??paths.activity}));
    }
    const badge=(text,tone='idle')=>h('span',{className:'sm-badge','data-tone':tone},h('span',{className:'sm-dot','aria-hidden':true}),text);
    const stat=(label,value,title)=>h('div',{className:'sm-stat'},h('div',{className:'sm-stat-label'},label),h('div',{className:'sm-stat-value',title},value));
    function Meter({value,total,label,unit='bytes'}){
      const amount=ratio(value,total);if(amount===null)return h('p',{className:'sm-muted'},`${label}: 取得不可`);
      const percent=Math.round(amount*100);
      return h('div',{className:'sm-meter','data-tone':unit==='bytes'&&percent>=95?'error':unit==='bytes'&&percent>=85?'warning':'normal',role:'progressbar','aria-label':label,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':percent,'aria-valuetext':unit==='count'?`${value} / ${total}`:`${bytes(value)} / ${bytes(total)}`},h('div',{className:'sm-meter-fill',style:{width:`${percent}%`}}));
    }
    function resourceBreakdown(resources,kind){
      const system=resources?.system?.[kind];if(ratio(system?.usedBytes,system?.totalBytes)===null)return null;
      const parts=[];let approximate=false,unmatched=false;
      for(const [key,label] of [['strata','Strata'],['comfyui','ComfyUI']]){
        const service=resources?.services?.[key];let value=null,partial=false;
        if(service?.status==='observed'){
          if(kind==='ram'){
            const ram=service.ram;
            if(Number.isSafeInteger(ram?.residentPrivateBytes)&&ram.residentPrivateBytes>=0)value=ram.residentPrivateBytes;
            else if(Number.isSafeInteger(ram?.workingSetBytes)&&ram.workingSetBytes>=0){value=ram.workingSetBytes;approximate=true;}
          }else{
            const gpu=service.vram,comparable=gpu?.source==='nvidia-smi'||gpu?.comparableToSystem===true&&typeof gpu.adapterKey==='string'&&gpu.adapterKey===system.adapterKey;
            if(comparable&&Number.isSafeInteger(gpu?.usedBytes)&&gpu.usedBytes>=0){value=gpu.usedBytes;partial=gpu.complete===false;}
            else if(gpu)unmatched=true;
          }
        }
        if(value!==null)parts.push({key,label,value,partial});
      }
      const sum=parts.reduce((value,part)=>value+part.value,0);
      if(!Number.isSafeInteger(sum)||sum>system.usedBytes)return {system,parts:[{key:'other',label:'Other / 未分類',value:system.usedBytes}],note:'プロセス計測とシステム計測が一致しないため、内訳を色分けしていません。',approximate:false};
      parts.push({key:'other',label:'Other / 未分類',value:system.usedBytes-sum});
      return {system,parts,approximate,note:unmatched?'GPUアダプター対応を確認できない計測は内訳に含めていません。':approximate?'RAM内訳はプロセスのワーキングセットによる目安です。共有ページが重複する場合があります。':''};
    }
    function UsageMeter({resources,kind,label}){
      const breakdown=resourceBreakdown(resources,kind);if(!breakdown)return h('p',{className:'sm-muted'},`${label}: 取得不可`);
      const {system,parts,note}=breakdown,percent=Math.round(system.usedBytes/system.totalBytes*100);
      return h('div',null,
        h('div',{className:'sm-meter sm-meter-stacked',role:'progressbar','aria-label':label,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':percent,'aria-valuetext':`${bytes(system.usedBytes)} / ${bytes(system.totalBytes)}; ${parts.map(p=>`${p.label} ${bytes(p.value)}${p.partial?'（観測分）':''}`).join('; ')}`},...parts.map(p=>h('div',{key:p.key,className:'sm-meter-segment','data-source':p.key,style:{width:`${p.value/system.totalBytes*100}%`},title:`${p.label}: ${bytes(p.value)}${p.partial?'（観測できたプロセスのみ）':''}`,'aria-hidden':true}))),
        h('div',{className:'sm-meter-legend'},...parts.map(p=>h('span',{key:p.key,title:p.partial?'観測できたプロセスのみ。残りはOther / 未分類に含まれます。':undefined},h('i',{className:'sm-meter-key','data-source':p.key,'aria-hidden':true}),`${p.label} ${(p.value/system.totalBytes*100).toFixed(1)}%`))),
        note?h('p',{className:'sm-footnote'},note):null);
    }
    function ServiceCard({label,service,active,icon,fresh}){
      const vram=service?.vram,windows=vram?.source==='windows-gpu-process-memory',partial=vram?.complete===false;
      const known=Number.isSafeInteger(vram?.usedBytes)&&vram.usedBytes>=0;
      const privateRam=Number.isSafeInteger(service?.ram?.residentPrivateBytes)&&service.ram.residentPrivateBytes>=0;
      return h('div',{className:'sm-service'},
        h('div',{className:'sm-row'},h('div',{className:'sm-service-name'},h('span',{className:'sm-icon'},h(Icon,{kind:icon})),label),badge(!fresh?'過去の観測':service?.status!=='observed'?'未取得':active?'割当中':'観測済み',!fresh?'warning':active?'active':'idle')),
        h('div',{className:'sm-statgrid'},
          stat('RAM',bytes(privateRam?service.ram.residentPrivateBytes:service?.ram?.workingSetBytes),privateRam?'照合済みプロセスの専用常駐RAM':'照合済みプロセスのワーキングセット（共有ページを含む場合があります）'),
          stat(windows?'専用GPUメモリ':'VRAM',bytes(vram?.usedBytes),partial&&known?'観測できたプロセスのみの値です。計測範囲の詳細を確認してください。':undefined)));
    }
    function ServiceScope({label,service}){
      const vram=service?.vram,windows=vram?.source==='windows-gpu-process-memory',partial=vram?.complete===false;
      const observed=Array.isArray(vram?.observedPids)?vram.observedPids.filter(pid=>Number.isSafeInteger(pid)&&pid>0):[];
      return h('div',{className:'sm-scope-service'},h('strong',null,label),
        h('p',{className:'sm-footnote'},vram?.source?`${windows?'Windows GPU Process Memory':'NVIDIA SMI'} · ${observed.length?`観測PID ${observed.join(', ')}`:'観測プロセスの詳細は未取得'}`:'プロセス別GPU計測は取得不可'),
        partial?h('p',{className:'sm-footnote'},'値は観測できたプロセスだけの合計です。未取得プロセスを含む総量は不明です。'):null);
    }
    function ResourceCard({state,now}){
      const resources=state.resources,fresh=!stale(resources?.observedAt,now),lease=state.lease,leaseFresh=!stale(state.observedAt,now),leaseOwner=leaseFresh?lease?.owner:'unknown';
      const vram=resources?.system?.vram,ram=resources?.system?.ram;
      const windows=Object.values(resources?.services??{}).some(service=>service?.vram?.source==='windows-gpu-process-memory'&&!(service.vram.comparableToSystem===true&&typeof service.vram.adapterKey==='string'&&service.vram.adapterKey===vram?.adapterKey));
      return h('section',{className:'sm-card sm-resource-card','aria-label':'リソース'},
        h('div',{className:'sm-row sm-card-title'},h('h3',null,'リソース'),badge(fresh?'観測中':'観測が古い',fresh?'success':'warning')),
        h('div',{className:'sm-services'},h(ServiceCard,{label:'Strata',service:resources?.services?.strata,active:leaseOwner==='core',icon:'chip',fresh}),h(ServiceCard,{label:'ComfyUI',service:resources?.services?.comfyui,active:leaseOwner==='generator',icon:'image',fresh})),
        h('div',{className:'sm-divider'}),h('h3',null,'システム全体'),
        h('div',{className:'sm-system-grid'},...[['VRAM',vram,'vram'],['RAM',ram,'ram']].map(([label,value,kind])=>h('div',{className:'sm-usage',key:label},h('div',{className:'sm-row'},h('span',{className:'sm-muted'},label),h('span',{className:'sm-numeric'},value?`${bytes(value.usedBytes)} / ${bytes(value.totalBytes)}`:'取得不可')),h(UsageMeter,{resources,kind,label:`システム${label}使用率`}),value?h('div',{className:'sm-muted',style:{marginTop:4}},`空き ${bytes(value.freeBytes)}`):null))),
        h('div',{className:'sm-divider'}),h('div',{className:'sm-row'},h('h3',null,'管理上のGPU割当'),badge(owner[leaseOwner]??'確認できません',leaseOwner==='unknown'?'warning':'active')),
        h('div',{className:'sm-ownergrid'},...['core','generator'].map(key=>h('div',{key,className:'sm-owner','data-active':leaseOwner===key},h('strong',null,key==='core'?'Strata':'ComfyUI'),h('small',null,leaseOwner===key?'管理上の所有者':leaseOwner==='unknown'?'割当の確認不可':'割当なし')))),
        lease?.blocked&&leaseFresh?h('p',{className:'sm-footnote'},'切替または状態確認のため、新しい処理は待機しています。'):null,
        h('details',{className:'sm-history sm-resource-scope'},h('summary',null,'計測元と観測範囲'),h(ServiceScope,{label:'Strata',service:resources?.services?.strata}),h(ServiceScope,{label:'ComfyUI',service:resources?.services?.comfyui}),
          windows?h('p',{className:'sm-footnote'},'Windowsの専用GPUメモリとシステム全体のNVIDIA VRAMとのアダプター対応は未確認のため、両者を同じ集計として比較しないでください。'):null,
          h('p',{className:'sm-footnote'},'RAMは専用常駐メモリを優先し、取得できない場合はワーキングセットを表示します。照合済みの管理・待受プロセスと、Strataの配置・親PID・開始時刻を照合したnative engineが対象です。全子プロセスの総量ではありません。ワーキングセットには共有ページを含む場合があります。プロセス別GPUメモリが取得できない環境では「取得不可」と表示します。'),
          h('p',{className:'sm-footnote'},'割当はControllerの管理情報です。モデルのロード状態や実測VRAMとは異なります。'),h('p',{className:'sm-footnote'},`資源の観測 ${clock(resources?.observedAt)}`)));
    }
    function stageIndex(job){
      if(job.phase==='completed'||job.phase==='needs_user'&&job.evaluations>0)return 5;
      return ({planning:0,ready:1,generating:2,awaiting_evaluation:3,revising:4})[job.phase]??-1;
    }
    function jobRow(job,progress,now=Date.now(),renderActions){
      const run=job.run,adopted=Boolean(job.latestUserDecision&&run&&job.latestUserDecision.sourceRunId===run.id&&job.latestUserDecision.productionRevision===job.revision&&job.latestUserDecision.decision==='accept'),done=adopted||['completed','failed','cancelled','needs_user'].includes(job.phase),activeRun=run&&!['completed','failed','cancelled'].includes(run.phase),stage=adopted?'採用済み':activeRun?phase[run.phase]??'処理中':phase[job.phase]??'状態を確認中';
      const matching=progress&&run?.id===progress.runId&&!stale(progress.observedAt,now)?progress:null;
      const nodes=(matching?.nodes??[]).filter(n=>typeof n.nodeId==='string'&&Number.isSafeInteger(n.value)&&Number.isSafeInteger(n.max)&&n.max>0&&n.value>=0&&n.value<=n.max);
      const index=stageIndex(job),tone=['failed','recovery_required'].includes(job.phase)?'error':job.phase==='completed'?'success':done?'warning':'active';
      return h('li',{key:job.id,className:'sm-job','data-active':!done},
        h('div',{className:'sm-row'},h('span',{className:'sm-job-label'},job.mode==='prompt-enhancement'?'プロンプト調整':'画像制作'),badge(stage,tone)),
        h('p',{className:'sm-job-model sm-muted'},[job.model,job.mode].filter(Boolean).join(' · ')||'モデル情報なし'),
        h('div',{className:'sm-row',style:{marginTop:9}},h('span',{className:'sm-muted'},`試行 ${Number.isSafeInteger(job.attempts)?job.attempts:0} · 評価 ${Number.isSafeInteger(job.evaluations)?job.evaluations:0}`),h('span',{className:'sm-muted sm-numeric'},`経過 ${elapsed(job.createdAt,done?job.updatedAt:null,now)}`)),
        index>=0&&job.mode!=='prompt-enhancement'?h('ol',{className:'sm-stage-list','aria-label':'制作工程の位置（実施済み一覧ではありません）'},...['制作仕様','フロー準備','生成','レビュー','改善（必要時）','結果の確認'].map((label,i)=>h('li',{key:label,className:'sm-stage','data-state':i===index?'current':'other','aria-current':i===index?'step':undefined},h('span',{className:'sm-stage-marker','aria-hidden':true},i===index?'●':String(i+1)),h('span',null,label)))):null,
        activeRun&&['generating','enhancing'].includes(run.phase)&&run.queueState?h('p',{className:'sm-footnote'},run.queueState==='running'?'ComfyUIで実行中':run.queueState==='pending'?'ComfyUIのキューで待機中':'停止状況を確認中'):null,
        nodes.length?h('div',{className:'sm-node'},...nodes.map(node=>h('div',{key:node.nodeId},h('div',{className:'sm-row'},h('span',{className:'sm-muted'},`ComfyUI ノード ${node.nodeId}`),h('strong',{className:'sm-numeric'},`${node.value} / ${node.max}`)),h(Meter,{value:node.value,total:node.max,label:`ノード${node.nodeId}内の進捗`,unit:'count'}),h('p',{className:'sm-footnote'},`観測 ${clock(matching.observedAt)} · このノード内の進捗です`)))):activeRun?h('p',{className:'sm-footnote'},'現在ノードの進捗は未取得です。生成失敗を意味しません。'):null,
        typeof renderActions==='function'?renderActions(job):null);
    }
    function Dashboard({state,error,now=Date.now(),auto,onAutoChange,renderActions,renderSessionActions,renderServices}){
      const jobs=Array.isArray(state?.jobs)?state.jobs:[],working=jobs.filter(j=>!['completed','failed','cancelled','needs_user'].includes(j.phase)&&j.latestUserDecision?.decision!=='accept'),history=jobs.filter(j=>!working.includes(j));
      return h('div',{className:'studio-monitor','data-studio-monitor':true},h('style',null,css),
        h('header',{className:'sm-heading'},h('div',null,h('div',{className:'sm-eyebrow'},'MEDIA STUDIO'),h('h2',null,'Media & Resources')),badge(error?'更新停止':state?'接続中':'接続待ち',error?'warning':state?'success':'idle')),
        error?h('p',{className:'sm-notice',role:'status'},error):null,
        state?h(ResourceCard,{state,now}):h('div',{className:'sm-card sm-empty',role:'status'},h(Icon,{kind:'activity',size:28}),h('p',null,'リソースと制作状況を確認中…')),
        typeof renderServices==='function'?renderServices():null,
        h('section',{className:'sm-card','aria-label':'この会話のジョブ'},h('div',{className:'sm-row sm-card-title'},h('h3',null,'この会話の制作'),badge(`${working.length} 件進行中`,working.length?'active':'idle')),
          state?.conversationInference?.active?h('p',{className:'sm-muted',style:{marginBottom:10}},'Strataが会話を処理しています。'):null,
          working.length?h('ul',{className:'sm-joblist'},...working.map(job=>jobRow(job,state.nodeProgress,now,renderActions))):h('div',{className:'sm-empty'},h(Icon,{kind:'layers',size:25}),h('p',null,'実行中の制作はありません')),
          history.length?h('details',{className:'sm-history',open:working.length===0},h('summary',null,`完了・確認待ちなど ${history.length} 件`),h('ul',{className:'sm-joblist'},...history.map(job=>jobRow(job,null,now,renderActions)))):null,
          h('p',{className:'sm-footnote'},'工程の位置とノード内の進捗を表示します。制作全体の進捗率や残り時間ではありません。'),typeof renderSessionActions==='function'?renderSessionActions():null),
        h('label',{className:'sm-settings'},h('input',{type:'checkbox',checked:auto,onChange:e=>onAutoChange?.(e.target.checked)}),'広い画面で未使用の右ペインに自動表示'),
        h('p',{className:'sm-footnote'},state?`状態の取得 ${clock(state.observedAt)} · 資源は約12秒ごとの計測`:'状態を取得してから制作の操作を表示します。'));
    }
    function Monitor({sessionId,useTabInfo,renderSlot}){
      const info=useTabInfo(),visible=info.tab.visible;
      const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[now,setNow]=useState(Date.now()),[auto,setAuto]=useState(readAuto);
      const state=snapshot&&snapshot.sessionId===sessionId?snapshot.value:null;
      useEffect(()=>{
        setSnapshot(null);setError('');if(!visible||!sessionId)return;
        let done=false,timer=null,request=null,tick=null;
        const poll=async()=>{
          if(done)return;
          if(document.visibilityState==='hidden'){timer=setTimeout(poll,8000);return;}
          request=new AbortController();
          try{
            const response=await fetch('/api/local-studio/monitor?'+new URLSearchParams({sessionId}),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([request.signal,AbortSignal.timeout(22000)])});
            if(!response.ok)throw Error();const value=await response.json();
            if(!done){setSnapshot({sessionId,value});setError('');}
          }catch{if(!done)setError('状態の更新を停止しています。最後の観測時刻を確認してください。');}
          finally{request=null;if(!done)timer=setTimeout(poll,8000);}
        };
        poll();tick=setInterval(()=>{if(document.visibilityState!=='hidden')setNow(Date.now());},1000);
        return()=>{done=true;if(timer)clearTimeout(timer);if(tick)clearInterval(tick);request?.abort();};
      },[visible,sessionId]);
      return h(Dashboard,{state,error,now,auto,onAutoChange:value=>{writeAuto(value);setAuto(value);},renderActions:typeof renderSlot==='function'?job=>renderSlot('studio.monitor.production.actions',{job}):undefined,renderSessionActions:typeof renderSlot==='function'?()=>renderSlot('studio.monitor.session.actions',{}):undefined,renderServices:typeof renderSlot==='function'?()=>renderSlot('studio.monitor.services',{visible}):undefined});
    }
    const CATALOG='studio-catalog', LOCALE='studio.catalog', CATALOG_TITLE='Catalog';
    function PaneButtons({open,considerAuto}){
      const [error,setError]=useState('');
      useEffect(()=>{considerAuto?.();},[considerAuto]);
      const button=(kind,label,title,icon)=>h(Button,{variant:'outline',size:'sm',type:'button',title,onClick:()=>{
        try{open(kind);setError('');}catch{setError('右ペインを開けません。会話を選び直してください。');}
      }},h('span',{style:{display:'inline-flex',alignItems:'center',gap:6}},h(Icon,{kind:icon}),label));
      return h('div',{style:{display:'flex',alignItems:'center',gap:6}},
        button(CATALOG,CATALOG_TITLE,'Open Catalog','layers'),button(KIND,'Resources','Open Media & Resources','activity'),
        error?h('span',{role:'status'},error):null);
    }
    const dictionaries={
      ja:{description:'ComfyUIのワークフローとStrataのモデル',refresh:'更新',core:'Strata モデル',configured:'設定されたモデル',running:'稼働中のモデル',loaded:'ロード済み',unloaded:'未ロード',unknown:'確認できません',matched:'起動時の設定と一致',changed:'起動時の設定から変更あり',repository:'配布元',quantization:'量子化',weights:'重みファイル',revision:'配布版',context:'コンテキスト',engine:'エンジン',vision:'画像入力',available:'利用可能',off:'無効',workflows:'ComfyUI ワークフロー',search:'モデル名・キーワード',searchButton:'検索',media:'メディア',mode:'操作',all:'すべて',image:'画像',video:'動画',ready:'依存関係確認済み',missing:'不足あり',invalid:'テンプレート確認不可',standalone:'ComfyUI単体',managed:'DSH管理',details:'保存場所・詳細',models:'不足モデル',nodes:'不足ノード',prev:'前へ',next:'次へ',loading:'読み込み中…',error:'取得できません。サービスの状態を確認して更新してください。',empty:'該当するワークフローはありません。',unconfigured:'ワークフロー一覧が設定されていません。',checked:'取得時刻',scope:'実行可否はモデルと空き資源に依存します。'},
      en:{description:'ComfyUI workflows and Strata model',refresh:'Refresh',core:'Strata model',configured:'Configured model',running:'Running model',loaded:'Loaded',unloaded:'Unloaded',unknown:'Unavailable',matched:'Matches startup configuration',changed:'Configuration changed since startup',repository:'Source',quantization:'Quantization',weights:'Weights file',revision:'Revision',context:'Context',engine:'Engine',vision:'Image input',available:'Available',off:'Disabled',workflows:'ComfyUI workflows',search:'Model or keyword',searchButton:'Search',media:'Media',mode:'Operation',all:'All',image:'Image',video:'Video',ready:'Dependencies found',missing:'Missing dependencies',invalid:'Template unavailable',standalone:'Standalone ComfyUI',managed:'Managed by DSH',details:'Location and details',models:'Missing models',nodes:'Missing nodes',prev:'Previous',next:'Next',loading:'Loading…',error:'Unable to load. Check the service and refresh.',empty:'No matching workflows.',unconfigured:'The workflow library is unconfigured.',checked:'Checked at',scope:'Execution depends on the model and available resources.'},
    };
    Object.assign(dictionaries.ja,{
      addPrompt:'プロンプトに追加',promptAdded:'入力欄に追加しました。',promptBlocked:'入力欄に追加できません。会話と入力欄の状態を確認してください。',
      resourceUse:'予想リソース消費量',modelDisk:'モデルのディスク容量',peakVram:'VRAM増加・観測最大',
      peakRam:'ComfyUIの物理RAM・観測最大',ramBudget:'Strataの常駐RAM設定',unmeasured:'未測定',
      sample:'測定条件',resourceNote:'既定フローでの参考値です。モデル、寸法、同時作業によって変動します。',
    });
    Object.assign(dictionaries.en,{
      addPrompt:'Add to prompt',promptAdded:'Added to the message draft.',promptBlocked:'Could not add to the draft. Check the conversation and composer.',
      resourceUse:'Expected resource use',modelDisk:'Model files on disk',peakVram:'Largest sampled VRAM increase',
      peakRam:'Peak sampled ComfyUI working set',ramBudget:'Strata resident RAM setting',unmeasured:'Unmeasured',
      sample:'Measurement conditions',resourceNote:'Reference values for the default workflow. Usage varies with models, dimensions and concurrent work.',
    });
    const modes=['t2i','i2i','edit','layout','depth','background-removal','upscale','t2v','i2v','pose','mixed-controlnet'];
    const modeLabels={
      ja:['テキスト→画像','画像→画像','画像編集','レイアウト','深度制御','背景除去','拡大','テキスト→動画','画像→動画','ポーズ制御','複数ControlNet'],
      en:['Text to image','Image to image','Image editing','Layout','Depth control','Background removal','Upscale','Text to video','Image to video','Pose control','Mixed ControlNet'],
    };
    const catalogCss=`
      .msc-content{display:grid;gap:10px;min-width:0}.msc-content .sm-statgrid{margin-top:0}
      .msc-line,.msc-filters{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.msc-badges{display:flex;gap:5px;flex-wrap:wrap}
      .msc-fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:4px 8px;margin:6px 0;font-size:11px;overflow-wrap:anywhere}.msc-fields dt{color:var(--sm-muted)}.msc-fields dd{margin:0}
      .msc-search{display:flex;gap:6px}.msc-search input{flex:1;min-width:0}.msc-filters label{display:grid;gap:3px;flex:1 1 100px;min-width:0}
      .ms-catalog input,.ms-catalog select{color:inherit;background:var(--sm-surface);border:1px solid var(--sm-border);border-radius:8px;padding:5px 8px;font:inherit;width:100%;min-width:0}
      .msc-row{display:grid;gap:8px;overflow-wrap:anywhere}.msc-row h4{font-size:13px;margin:0}.msc-row .sm-history{margin-top:0}.msc-row .sm-history summary{padding:2px 0}.msc-row ul{margin:3px 0;padding-left:18px}
      .msc-action{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    `;
    function useCatalogData(path,query,enabled,revision){
      const [result,setResult]=useState(null);
      const key=path+'?'+query;
      useEffect(()=>{
        if(!enabled)return;
        const controller=new AbortController();
        let active=true;
        setResult({key,revision,loading:true});
        (async()=>{
          const response=await fetch(key,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(22000)])});
          if(!response.ok)throw Error('Catalog unavailable');
          const value=await response.json();
          if(active)setResult({key,revision,value});
        })().catch(()=>{if(active)setResult({key,revision,error:true});});
        return()=>{active=false;controller.abort();};
      },[key,enabled,revision]);
      return result?.key===key&&result.revision===revision?result:{loading:true};
    }
    const gib=value=>typeof value==='number'?`${(value/1024**3).toLocaleString(undefined,{maximumFractionDigits:2})} GiB`:null;
    function CoreModel({data,t}){
      const config=data.configured, live=data.running;
      const line=(key,value)=>value==null?null:[h('dt',{key:key+'-label'},t(key)),h('dd',{key},value)];
      const format=value=>value==null?null:Number(value).toLocaleString();
      return h('div',{className:'msc-content'},
        h('div',{className:'sm-statgrid'},
          stat(t('configured'),config?.model??t('unknown')),
          stat(t('running'),live?.model??t(live?.state??'unknown'))),
        live?h('div',{className:'msc-badges',role:'status'},badge(t(live.state),live.state==='loaded'?'success':'idle'),
          data.configurationMatch!=null?badge(t(data.configurationMatch?'matched':'changed'),data.configurationMatch?'idle':'warning'):null):null,
        config||live?h('details',{className:'sm-history'},h('summary',null,t('details')),h('dl',{className:'msc-fields'},
          line('engine',live?.engine),line('context',format(live?.context??config?.context)),line('vision',live?.vision?t(live.vision):null),
          line('repository',config?.repository),line('quantization',config?.quantization),line('weights',config?.weights),line('revision',config?.revision),line('ramBudget',gib(config?.residentRamBudgetBytes)))):null,
        data.observedAt?h('p',{className:'sm-footnote'},`${t('checked')} ${clock(data.observedAt)}`):null);
    }
    function WorkflowResources({data,t}){
      const runtime=data?.runtime;
      const fields=[
        ['modelDisk',gib(data?.modelDiskBytes)??t('unknown')],
        ['peakVram',gib(runtime?.vramPeakDeltaBytes)??t('unmeasured')],
        ['peakRam',gib(runtime?.ramWorkingSetPeakBytes)??t('unmeasured')],
      ];
      if(runtime)fields.push(['sample',[`${runtime.width}×${runtime.height}`,runtime.frames?`${runtime.frames}f`:null,
        runtime.gpu,`${runtime.sampleIntervalMs} ms`].filter(Boolean).join(' · ')]);
      return h('details',{className:'sm-history'},h('summary',null,t('resourceUse')),
        h('dl',{className:'msc-fields'},...fields.flatMap(([key,value])=>[h('dt',{key:key+'-label'},t(key)),h('dd',{key},value)])),
        h('p',{className:'sm-muted'},t('resourceNote')));
    }
    function workflowPrompt(row,ja){
      const name=[row.family,row.label].filter(Boolean).join(' / ');
      if(row.dshProfile){
        const check=row.state!=='static-ready';
        return ja
          ? `ComfyUIワークフロー「${name}」を使いたいです。モデルプロファイルは ${row.dshProfile}、操作は ${row.mode} を指定します。${check?'実行前に依存関係と利用可否を確認してください。':''}`
          : `Use the ComfyUI workflow “${name}” with model profile ${row.dshProfile} and operation ${row.mode}.${check?' Check its dependencies and availability before running it.':''}`;
      }
      return ja
        ? `ComfyUI単体のワークフロー「${name}」（${row.file}）について、必要な入力素材・依存関係と実行手順を教えてください。`
        : `Explain the required inputs, dependencies and steps for the standalone ComfyUI workflow “${name}” (${row.file}).`;
    }
    function WorkflowRow({row,t,operation,onSelect}){
      const [feedback,setFeedback]=useState('');
      const state={'static-ready':'ready','dependencies-missing':'missing'}[row.state]??'invalid';
      const missing=(label,values)=>values?.length?h('div',null,t(label),h('ul',null,...values.map(value=>h('li',{key:value},value)))):null;
      return h('article',{className:'sm-job msc-row'},
        h('div',null,row.family&&row.family!==row.label?h('p',{className:'sm-muted'},row.family):null,h('h4',null,row.label)),
        h('div',{className:'msc-badges'},badge(operation(row.mode)),badge(t(row.dshProfile?'managed':'standalone'),row.dshProfile?'active':'idle'),
          badge(t(state),state==='ready'?'success':'warning')),
        h('div',{className:'msc-action'},h(Button,{type:'button',size:'sm',variant:'outline',onClick:()=>setFeedback(onSelect(row)?'promptAdded':'promptBlocked')},t('addPrompt')),
          h('span',{className:'sm-muted',role:'status'},feedback?t(feedback):'')),
        h(WorkflowResources,{data:row.resourceUsage,t}),
        h('details',{className:'sm-history'},h('summary',null,t('details')),h('p',null,row.file),
          row.dshProfile?h('p',null,row.dshProfile):null,missing('models',row.missingModels),missing('nodes',row.missingNodes)));
    }
    function Catalog({sessionId,useTabInfo,appendPrompt,t=key=>dictionaries.en[key]}){
      const visible=useTabInfo().tab.visible;
      const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[media,setMedia]=useState(''),[mode,setMode]=useState('');
      const [page,setPage]=useState(1),[revision,setRevision]=useState(0);
      const scope=new URLSearchParams({sessionId});
      const filters=new URLSearchParams(scope);
      if(query)filters.set('query',query);
      if(media)filters.set('media',media);
      if(mode)filters.set('mode',mode);
      filters.set('page',String(page));
      const enabled=Boolean(visible&&sessionId);
      const core=useCatalogData('/api/local-studio/core-model',scope,enabled,revision);
      const list=useCatalogData('/api/local-studio/catalog',filters,enabled,revision);
      const last=Math.max(1,Math.ceil((list.value?.total??0)/(list.value?.limit??12)));
      const ja=t('mode')===dictionaries.ja.mode;
      const operation=value=>modeLabels[ja?'ja':'en'][modes.indexOf(value)]??value;
      const status=state=>h('p',{role:state.error?'alert':'status',className:state.error?'sm-notice':'sm-muted'},t(state.error?'error':'loading'));
      const button=(key,onClick,disabled=false)=>h(Button,{type:'button',size:'sm',variant:'outline',onClick,disabled},t(key));
      const select=(label,value,change,options,caption)=>h('label',null,t(label),h('select',{value,onChange:event=>{change(event.target.value);setPage(1);}},
        h('option',{value:''},t('all')),...options.map(item=>h('option',{value:item,key:item},caption(item)))));
      return h('div',{className:'studio-monitor ms-catalog','data-studio-catalog':true},h('style',null,css+catalogCss),
        h('header',{className:'sm-heading'},h('div',null,h('div',{className:'sm-eyebrow'},'MEDIA STUDIO'),h('h2',null,CATALOG_TITLE)),
          button('refresh',()=>setRevision(n=>n+1),core.loading&&list.loading)),
        h('section',{className:'sm-card'},h('h3',{className:'sm-card-title'},t('core')),core.value?h(CoreModel,{data:core.value,t}):status(core)),
        h('section',{className:'sm-card'},h('h3',{className:'sm-card-title'},t('workflows')),
          h('div',{className:'msc-content'},h('form',{className:'msc-search',onSubmit:event=>{event.preventDefault();setQuery(draft.trim());setPage(1);}},
            h('input',{type:'search',value:draft,maxLength:80,placeholder:t('search'),'aria-label':t('search'),onChange:event=>setDraft(event.target.value)}),
            h(Button,{type:'submit',size:'sm',variant:'outline'},t('searchButton'))),
          h('div',{className:'msc-filters'},select('media',media,setMedia,['image','video'],t),select('mode',mode,setMode,modes,operation))),
          list.value?h('div',null,...list.value.workflows.map(row=>h(WorkflowRow,{key:row.id,row,t,operation,onSelect:item=>appendPrompt(workflowPrompt(item,ja))})),
            list.value.workflows.length===0?h('p',{className:'sm-empty',role:'status'},t(list.value.state==='unconfigured'?'unconfigured':'empty')):null,
            page>1||last>1?h('nav',{className:'msc-line sm-history','aria-label':t('workflows')},button('prev',()=>setPage(n=>n-1),page===1),
              h('span',{className:'sm-muted'},`${page} / ${last}`),button('next',()=>setPage(n=>n+1),page>=last)):null):status(list),
          h('p',{className:'sm-footnote'},t('scope'))));
    }
    function apply(ctx){
      const considered=new Set();
      const mounted=sessionId=>ctx.sidebarRight.mounted.getSnapshot()===sessionId;
      const openFor=sessionId=>kind=>{
        if(!mounted(sessionId))throw Error('Conversation changed');
        ctx.sidebarRight.openTab(kind);
      };
      ctx.effect(()=>ctx.sidebarRightTabs.register({id:ID,kind:KIND,keepMounted:true,title:()=> 'Media & Resources',guide:[{id:ID,order:20,title:()=> 'Media & Resources',description:()=> 'Strata・ComfyUIの資源と、この会話の制作工程',icon:Icon}]}));
      ctx.effect(()=>ctx.locale.register(LOCALE,dictionaries));
      ctx.effect(()=>ctx.sidebarRightTabs.register({id:CATALOG,kind:CATALOG,title:()=>CATALOG_TITLE,
        guide:[{id:CATALOG,order:21,title:()=>CATALOG_TITLE,description:()=>ctx.locale.bind(LOCALE)('description'),icon:()=>h(Icon,{kind:'layers'})}]}));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({
        name:'sidebar.right.pane.tab',key:CATALOG,locale:LOCALE,inject:sessionId=>({sessionId,appendPrompt:prompt=>{
          if(!mounted(sessionId))return false;
          try{
            const binding=ctx.sessions.binding(sessionId);
            return Boolean(binding&&ctx.conversation.input.requestDraftInitialization(binding,{prompt,whenDraftExists:'append'})==='applied');
          }catch{return false;}
        }}),
      },Catalog));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID,children:{'studio.monitor.production.actions':{kind:'list',scope:'session'},'studio.monitor.session.actions':{kind:'list',scope:'session'},'studio.monitor.services':{kind:'list',scope:'session'}},inject:sessionId=>({sessionId})},Monitor));
      ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:ID,order:-20,inject:sessionId=>({
        open:openFor(sessionId),
        considerAuto:()=>{
          if(considered.has(sessionId)||!mounted(sessionId))return;
          considered.add(sessionId);if(considered.size>256)considered.delete(considered.values().next().value);
          if(!readAuto()||!window.matchMedia?.('(min-width: 1100px)').matches)return;
          try{const current=ctx.sidebarRight.active();if(!ctx.sidebarRight.isExpanded()&&(!current||current.kind==='guide'))ctx.sidebarRight.openTab(KIND);}catch{}
        },
      })},PaneButtons));
      ctx.slots.inject('conversation.hero.options',()=>ctx.slots.register({
        name:'conversation.hero.options',id:ID,order:-20,inject:sessionId=>({open:openFor(sessionId)}),
      },PaneButtons));
      ctx.effect(()=>()=>considered.clear());
    }
    return {inject:['slots','sidebarRight','sidebarRightTabs','locale','sessions','conversation'],apply,Monitor,PaneButtons,Dashboard,ResourceCard,ServiceCard,ServiceScope,Meter,UsageMeter,resourceBreakdown,Icon,elapsed,bytes,ratio,stale,stageIndex,jobRow,Catalog,workflowPrompt};
  },
});
