// DSH public client-plugin closure. This plugin owns its slots and lifecycle.
window.__ModuleLoader__.load({
  id:"local-genai-studio-controls",
  factory(require){
    const {createElement:h,useState,useRef,useEffect}=require('react');
    const {Button}=require('@deepseek-ai/dsh-client-ui-primitives');
    const card={padding:'18px',margin:'12px 0',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'var(--dsw-radius-lg, 16px)',background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',fontFamily:'inherit',minWidth:0,boxSizing:'border-box'};
    const secondary={color:'var(--dsw-alias-label-secondary)',fontSize:'0.8rem',lineHeight:1.65};
    const heading={display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px',flexWrap:'wrap',margin:'0 0 10px',fontSize:'0.95rem',fontWeight:650,lineHeight:1.5};
    const recordStyle={marginTop:'12px',padding:'10px 12px',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'var(--dsw-radius-md, 12px)',fontSize:'0.8rem'};
    const phaseNames={awaiting_approval:'承認待ち',approved:'承認済み',running:'実行中',completed:'取得済み',cancelled:'停止済み',needs_attention:'確認が必要'};
    const statusBadge=(label,tone='idle')=>h('span',{style:{display:'inline-flex',alignItems:'center',gap:'6px',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'999px',padding:'3px 9px',fontSize:'0.72rem',fontWeight:550,color:`var(--dsw-alias-state-${tone}-primary, var(--dsw-alias-label-secondary))`,background:'var(--dsw-alias-bg-layer-2)',whiteSpace:'nowrap'}},h('span',{'aria-hidden':true,style:{width:'5px',height:'5px',borderRadius:'50%',background:'currentColor'}}),label);
    async function actionRequest(sessionId,query,body,signal){
      const url='/api/local-studio/actions?'+new URLSearchParams({sessionId,...(query?.proposalId?{proposalId:query.proposalId}:{}),...(query?.sessionOnly?{sessionOnly:'1'}:{})});
      const headers=body?{'Content-Type':'application/json','X-Local-Studio-Action':'1'}:{};
      if(body&&window.location?.protocol==='dsh-app:'&&window.location.host==='app'){
        const challenge=await fetch('/api/local-studio/desktop-proof/actions',{credentials:'same-origin',cache:'no-store',headers:{'X-Local-Studio-Proof-Request':'1'},...(signal?{signal}:{})});
        if(!challenge.ok)throw Error('Desktopの操作権限を確認できません。');
        const value=await challenge.json();if(typeof value?.proof!=='string')throw Error('Desktopの操作権限を確認できません。');
        headers['X-Local-Studio-Desktop-Proof']=value.proof;
      }
      const response=await fetch(body?'/api/local-studio/actions':url,{method:body?'POST':'GET',credentials:'same-origin',headers,...(body?{body:JSON.stringify({sessionId,...body})}:{}),...(signal?{signal}:{})});
      const value=await response.json();if(!response.ok)throw new Error(value.error??'状態を確認できません。');return value;
    }
    function SearchEvidence({proposal}){
      const items=Array.isArray(proposal?.items)?proposal.items:[];
      const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
      return items.length?h('div',{'aria-label':'検索結果',style:{marginTop:'12px'}},...items.map((item,index)=>h('section',{key:index,style:{marginTop:'12px'}},h('strong',{style:secondary},item.query??item.url??'取得結果'),...(Array.isArray(item.results)?item.results:[]).map((result,i)=>{const url=safeUrl(result.url);return h('article',{key:i,style:{...recordStyle,marginTop:'8px'}},h('strong',null,url?h('a',{href:url,target:'_blank',rel:'noopener noreferrer',style:{color:'var(--dsw-alias-link)'}},String(result.title??url)):String(result.title??'取得した本文')),h('p',{style:{...secondary,whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginTop:6}},String(result.content??result.text??'').slice(0,20000)));})))):null;
    }
    function SearchActions({sessionId,proposalId,initialProposal}){
      const [snapshot,setSnapshot]=useState(()=>({sessionId,proposalId,proposal:initialProposal??null,searchEnabled:null})),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[refreshKey,setRefreshKey]=useState(0),[checking,setChecking]=useState(false),[readError,setReadError]=useState('');
      const proposal=snapshot?.sessionId===sessionId&&snapshot?.proposalId===proposalId?snapshot.proposal:null;
      const lock=useRef(false),uncertain=useRef(false),cancelUncertain=useRef(false),scope=useRef(null);scope.current={sessionId,proposalId};
      useEffect(()=>{
        let live=true,timer=null,request=null;
        const refresh=async()=>{
          if(!live)return;
          if(lock.current||typeof document!=='undefined'&&document.visibilityState==='hidden'){timer=setTimeout(refresh,5000);return;}
          request=new AbortController();setChecking(true);
          let again=true;
          try{const value=await actionRequest(sessionId,{proposalId},null,AbortSignal.any([request.signal,AbortSignal.timeout(15000)]));if(!live)return;setSnapshot({sessionId,proposalId,proposal:value.proposal,searchEnabled:value.searchEnabled===true});setReadError('');again=value.searchEnabled!==false&&['awaiting_approval','approved','running'].includes(value.proposal?.phase);}
          catch{if(live)setReadError('検索状態を更新できません。表示した内容を保ち、自動で再確認します。');}
          finally{request=null;if(live){setChecking(false);if(again)timer=setTimeout(refresh,5000);}}
        };
        void refresh();return()=>{live=false;if(timer)clearTimeout(timer);request?.abort();};
      },[sessionId,proposalId,refreshKey]);
      const act=async(action)=>{const cancel=action==='cancel-search';if(lock.current||(cancel?cancelUncertain.current:uncertain.current)||!proposal)return;lock.current=true;if(cancel)cancelUncertain.current=true;else uncertain.current=true;setBusy(true);const current=()=>scope.current?.sessionId===sessionId&&scope.current?.proposalId===proposalId;try{const field=proposal.kind==='pages'?'urls':'queries';await actionRequest(sessionId,null,{action,proposalId,proposalHash:proposal.proposalHash,engine:proposal.engine,[field]:proposal[field]});if(!current())return;setMessage(cancel?'停止を受け付けました。完了は自動更新で確認します。':'送信を受け付けました。取得結果は自動更新で表示します。');setSnapshot(null);if(cancel)cancelUncertain.current=false;else uncertain.current=false;}catch(e){if(current())setMessage(`受付結果を確認できません。自動再送せず、状態を確認してください。 ${e.message}`);}finally{lock.current=false;if(current()){setBusy(false);setRefreshKey(value=>value+1);}}};
      const pending=proposal&&['awaiting_approval','approved','running'].includes(proposal.phase),canApprove=proposal&&snapshot?.searchEnabled===true&&['awaiting_approval','approved'].includes(proposal.phase);
      return h('section',{'aria-label':'検索の確認','aria-busy':busy||checking,style:{marginTop:'12px'}},h('p',{role:'status',style:secondary},snapshot?.searchEnabled===false?'資料検索は無効です。保存済みの検索結果は確認できます。':checking?'検索状態を更新中…':proposal?'検索状態は自動更新されます。':'検索状態を取得しています…'),
        proposal?h('div',{style:{...recordStyle,background:'var(--dsw-alias-bg-layer-2)'}},h('p',{style:{...secondary,margin:'0 0 8px',display:'flex',alignItems:'center',gap:'8px',flexWrap:'wrap'}},statusBadge(phaseNames[proposal.phase]??'状態不明',proposal.phase==='needs_attention'?'warn':proposal.phase==='completed'?'success':'idle'),`送信先: ${proposal.engine}`),h('p',{style:{fontSize:'0.85rem',margin:'8px 0',lineHeight:1.6}},`目的: ${proposal.purpose}`),
          h('div',{style:{...secondary,marginBottom:'6px',fontWeight:600}},proposal.kind==='pages'?'取得するページのURL':'外部へ送信する検索語'),
          h('ul',{style:{paddingLeft:'20px',margin:'0 0 14px',fontSize:'0.85rem',lineHeight:1.7,overflowWrap:'anywhere'}},...(proposal.kind==='pages'?proposal.urls??[]:proposal.queries??[]).map((item,i)=>h('li',{key:i},item))),
          canApprove?h(Button,{type:'button',variant:'primary',size:'sm',style:{margin:'0 8px 8px 0'},disabled:busy||uncertain.current,onClick:()=>act('approve-search')},proposal.kind==='pages'?'表示したURLの取得を許可':'表示した検索語の送信を許可'):null,
          pending?h(Button,{type:'button',variant:'outline',size:'sm',style:{marginBottom:'8px'},disabled:busy||cancelUncertain.current,onClick:()=>act('cancel-search')},'この検索を停止'):null):null,
        h(SearchEvidence,{proposal}),readError?h('p',{role:'status',style:secondary},readError):null,message?h('p',{role:'status',style:{...secondary,marginBottom:0}},message):null,
        cancelUncertain.current?h('p',{style:{...secondary,color:'var(--dsw-alias-state-warn-primary)'}},'停止結果を確認できない場合はMedia & Resourcesの「会話の推論・検索を停止」で対象を確認してください。'):null);
    }
    function SessionControls({sessionId}){
      const [target,setTarget]=useState(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
      const lock=useRef(false),uncertainTarget=useRef(null);
      const refresh=async()=>{if(lock.current)return;lock.current=true;setBusy(true);try{const value=await actionRequest(sessionId,{sessionOnly:true});setTarget(value.stopTarget);setMessage(value.stopTarget?'この会話の推論・検索を停止できます。':'停止できる推論・検索はありません。');}catch(e){setMessage(e.message);}finally{lock.current=false;setBusy(false);}};
      const key=target?`${target.kind}:${target.id}:${target.runId??''}:${target.revision??''}:${target.searchTurn??''}`:null;
      const stop=async()=>{if(lock.current||!target||uncertainTarget.current===key)return;lock.current=true;uncertainTarget.current=key;setBusy(true);try{await actionRequest(sessionId,null,{action:'stop-session',...target});setTarget(null);setMessage('停止を受け付けました。完了は状態で確認してください。');}catch(e){setMessage(`停止の受付結果を確認できません。自動再送せず状態を確認してください。 ${e.message}`);}finally{lock.current=false;setBusy(false);}};
      return h('details',{className:'local-studio-controls',style:{...recordStyle,marginTop:'8px',background:'var(--dsw-alias-bg-layer-1)',fontFamily:'inherit',color:'var(--dsw-alias-label-primary)'},'aria-busy':busy},h('summary',{style:{cursor:'pointer',fontWeight:600,padding:'2px 0 6px'}},'会話の推論・検索を停止'),h(Button,{type:'button',variant:'outline',size:'sm',style:{margin:'8px 8px 0 0'},disabled:busy,onClick:refresh},busy?'対象を確認中…':'停止対象を確認'),target?h(Button,{type:'button',variant:'outline',size:'sm',style:{marginTop:'8px',color:'var(--dsw-alias-state-error-primary)'},disabled:busy||uncertainTarget.current===key,onClick:stop},'表示した推論・検索を停止'):null,message?h('p',{role:'status',style:{...secondary,marginBottom:0}},message):null,
        target?h('p',{style:{...secondary,margin:'8px 0 0'}},`停止対象: ${{production:'画像・動画の制作',scope:'この会話の推論', 'search-session':'この会話の検索'}[target.kind]??'この会話の処理'}。受付後も停止完了までは状態を確認してください。`):null);
    }
    function ProductionActions({sessionId,job}){
      const [reason,setReason]=useState(''),[rejecting,setRejecting]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[settled,setSettled]=useState(false);
      const lock=useRef(false),uncertain=useRef(false);
      const planUncertain=useRef(false);
      const candidate=job.confirmation;
      const userDecision=job.latestUserDecision&&job.run&&job.latestUserDecision.sourceRunId===job.run.id&&job.latestUserDecision.productionRevision===job.revision?job.latestUserDecision:null;
      const canStop=userDecision?.decision!=='accept'&&!['completed','cancelled','failed','needs_user','cancelling'].includes(job.phase)&&job.mode!=='prompt-enhancement';
      const requestPlan=async planningRequestId=>{await actionRequest(sessionId,null,{action:'plan-production',productionId:job.id,planningRequestId});};
      const resumePlan=async()=>{if(lock.current||planUncertain.current)return;lock.current=true;planUncertain.current=true;setBusy(true);try{await requestPlan(userDecision.planningRequestId);setMessage('同じ検討依頼の受付を確認しました。会話を確認してください。');}catch(e){setMessage(`否認記録は保存済みです。検討依頼の受付を確認できません。 ${e.message}`);}finally{lock.current=false;setBusy(false);}};
      const submit=async decision=>{
        if(lock.current||uncertain.current||settled)return;lock.current=true;uncertain.current=true;setBusy(true);
        try{
          const result=await actionRequest(sessionId,null,decision==='stop'?{action:'stop-production',productionId:job.id,expectedRunId:job.run?.id??null,expectedRevision:job.revision}:{action:'production-decision',productionId:job.id,expectedRevision:job.revision,sourceRunId:candidate.runId,artifactSha256:candidate.artifactSha256,requestId:window.crypto.randomUUID(),decision,feedback:reason});
          setSettled(true);
          if(result.planning){setMessage('否認を保存しました。次工程の検討依頼を送信しています。');try{await requestPlan(result.planning.requestId);setMessage('否認を保存し、同じ制作の次工程の検討を依頼しました。追加生成は指示していません。');}catch{setMessage('否認は保存済みです。検討依頼の受付を確認できません。再送せず会話の状態を確認してください。');}}
          else setMessage(decision==='stop'?'この制作の停止を受け付けました。完了は状態で確認してください。':'この候補の採用を記録しました。未確認の評価条件は変更していません。');
        }catch(e){setMessage(`受付結果を確認できません。自動再送せず状態を確認してください。 ${e.message}`);}finally{lock.current=false;setBusy(false);}
      };
      return h('section',{'aria-label':'制作の操作','aria-busy':busy,style:{marginTop:'12px'}},
        userDecision?h('p',{style:secondary},userDecision.decision==='accept'?'利用者がこの候補を採用しました。':userDecision.planningState==='accepted'?'この候補は否認済みです。次工程の検討を依頼済みです。':'この候補は否認済みです。次工程の検討依頼は未送信または受付未確認です。'):null,
        userDecision?.decision==='reject'&&userDecision.planningState!=='accepted'&&job.phase==='revising'?h(Button,{type:'button',variant:'outline',size:'sm',disabled:busy||planUncertain.current,onClick:resumePlan},'検討依頼を確認・再開'):null,
        canStop?h(Button,{type:'button',variant:'outline',size:'sm',disabled:busy||uncertain.current,onClick:()=>submit('stop')},'この制作を停止'):null,
        candidate&&!settled?h('div',null,h('p',{style:secondary},'最新の評価済み候補に対する採否です。'),h('p',{style:{...secondary,overflowWrap:'anywhere'},title:`run ${candidate.runId} / SHA-256 ${candidate.artifactSha256}`},`候補 ${Number.isSafeInteger(job.attempts)?job.attempts:'最新'}（最新の評価済み画像）`),h('div',{style:{display:'flex',gap:'8px',flexWrap:'wrap'}},h(Button,{type:'button',variant:'primary',size:'sm',disabled:busy||uncertain.current,onClick:()=>submit('accept')},'承認して採用'),h(Button,{type:'button',variant:'outline',size:'sm',disabled:busy||uncertain.current,onClick:()=>setRejecting(true)},'否認する')),
          rejecting?h('div',{style:{marginTop:10}},h('label',{style:secondary},'修正要望（任意）',h('textarea',{value:reason,maxLength:4000,onChange:e=>setReason(e.target.value),'aria-label':'否認の理由・修正要望',rows:3,style:{display:'block',width:'100%',boxSizing:'border-box',margin:'6px 0',padding:8,border:'1px solid var(--dsw-alias-border-l2)',borderRadius:8,background:'var(--dsw-alias-bg-layer-2)',color:'inherit',font:'inherit'}})),h(Button,{type:'button',variant:'outline',size:'sm',disabled:busy||uncertain.current,onClick:()=>submit('reject')},'否認して次工程を検討')):null):null,
        message?h('p',{role:'status',style:secondary},message):null);
    }
    function ProductionActionSeat(props){return h(ProductionActions,{...props,key:`${props.job.id}:${props.job.revision}`});}
    function SearchToolView(props){
      const content=Array.isArray(props.block?.content)?props.block.content:[];
      const texts=content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text);
      let value;try{value=JSON.parse(texts[0]??'null');}catch{}
      const failed=Boolean(props.block?.isError);
      const title=props.toolName==='local_search_propose'?'検索・ページ取得を提案':'承認した検索結果を確認';
      const proposalId=!failed&&typeof value?.proposal?.id==='string'?value.proposal.id:null;
      const states={awaiting_approval:'承認待ちです。ここで検索語と送信先を確認できます。',approved:'承認済みです。検索の状態を確認してください。',running:'承認された検索を実行中です。',completed:'検索結果を取得しました。外部情報として内容を確認してください。',cancelled:'検索を停止しました。',needs_attention:'検索結果が不確定です。再送せず実行状態を確認してください。'};
      const summary=failed?'処理に失敗しました。詳細を確認してください。':props.phase!=='result'?'処理中…':states[value?.proposal?.phase]??'検索の状態を確認してください。';
      return h('section',{className:'local-studio-controls','aria-label':title,style:card},h('h3',{style:heading},title,statusBadge(failed?'処理失敗':props.phase!=='result'?'処理中':phaseNames[value?.proposal?.phase]??'状態を確認',failed?'error':value?.proposal?.phase==='needs_attention'?'warn':value?.proposal?.phase==='completed'?'success':'idle')),
        h('p',{role:failed?'alert':'status',style:{...secondary,margin:'0 0 8px'}},summary),
        props.sessionId&&proposalId?h(SearchActions,{key:`${props.sessionId}:${proposalId}`,sessionId:props.sessionId,proposalId,initialProposal:value.proposal}):h(SearchEvidence,{proposal:value?.proposal}),
        texts.length?h('details',{style:recordStyle},h('summary',{style:{cursor:'pointer',color:'var(--dsw-alias-label-secondary)'}},'検索結果と詳細'),h('pre',{style:{fontFamily:'var(--dsh-font-family-code, monospace)',fontSize:'0.75rem',lineHeight:1.65,whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'22rem',overflow:'auto'}},texts.join('\n'))):null,
        typeof props.inspect==='function'?h(Button,{type:'button',variant:'outline',size:'sm',style:{marginTop:'12px'},onClick:props.inspect},'実行記録を確認'):null);
    }
    function apply(ctx){
      for(const name of ['local_search_propose','local_search_result'])ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:name,inject:sessionId=>({sessionId})},SearchToolView));
      ctx.slots.inject('studio.monitor.session.actions',()=>ctx.slots.register({name:'studio.monitor.session.actions',id:'local-genai-session-controls',inject:sessionId=>({sessionId})},SessionControls));
      ctx.slots.inject('studio.monitor.production.actions',()=>ctx.slots.register({name:'studio.monitor.production.actions',id:'local-genai-production-controls',inject:sessionId=>({sessionId})},ProductionActionSeat));
    }
    return{inject:['slots'],apply,SearchActions,SearchEvidence,SessionControls,ProductionActions,ProductionActionSeat,SearchToolView,actionRequest};
  },
});
