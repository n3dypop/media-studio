// DSH public client-plugin closure. This plugin owns its slots and lifecycle.
window.__ModuleLoader__.load({
  id:"local-genai-media-results",
  factory(require){
    const {createElement:h,useSyncExternalStore}=require('react');
    const {Button}=require('@deepseek-ai/dsh-client-ui-primitives');
    const card={padding:'18px',margin:'12px 0',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'var(--dsw-radius-lg, 16px)',background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',fontFamily:'inherit',minWidth:0,boxSizing:'border-box'};
    const heading={display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px',flexWrap:'wrap',margin:'0 0 10px',fontSize:'0.95rem',fontWeight:650,lineHeight:1.5};
    const secondary={color:'var(--dsw-alias-label-secondary)',fontSize:'0.8rem',lineHeight:1.65};
    const linkStyle={color:'var(--dsw-alias-text-link, var(--dsw-alias-label-primary))',textUnderlineOffset:'3px',fontSize:'0.8rem',overflowWrap:'anywhere'};
    const recordStyle={marginTop:'12px',padding:'10px 12px',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'var(--dsw-radius-md, 12px)',fontSize:'0.8rem'};
    const preStyle={fontFamily:'var(--dsh-font-family-code, monospace)',fontSize:'0.75rem',lineHeight:1.65,whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'22rem',overflow:'auto'};
    const sizeText=bytes=>integer(bytes)?bytes<1048576?`${Math.ceil(bytes/1024)} KiB`:`${(bytes/1048576).toFixed(1)} MiB`:'サイズ不明';
    const defaultImageFactory=()=> 'conversation.images.content';
    const noFactoryChanges=()=>()=>{};
    function createImageFactories(ctx){
      let enhanced=false;const listeners=new Set();
      const publish=value=>{enhanced=value;for(const listener of listeners)listener();};
      ctx.slots.inject('studio.images.viewer.available',()=>{publish(true);return()=>publish(false);});
      ctx.effect(()=>()=>listeners.clear());
      return {subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},snapshot:()=>enhanced?'studio.images.content':'conversation.images.content'};
    }
    function ImageContent({imageFactories,renderFactorySlot,...props}){
      const name=useSyncExternalStore(imageFactories?.subscribe??noFactoryChanges,imageFactories?.snapshot??defaultImageFactory,defaultImageFactory);
      return renderFactorySlot(name,props);
    }
    const badge=(label,tone='idle')=>h('span',{style:{display:'inline-flex',alignItems:'center',gap:'6px',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'999px',padding:'3px 9px',fontSize:'0.72rem',fontWeight:550,color:`var(--dsw-alias-state-${tone}-primary, var(--dsw-alias-label-secondary))`,background:'var(--dsw-alias-bg-layer-2)',whiteSpace:'nowrap'}},h('span',{'aria-hidden':true,style:{width:'5px',height:'5px',borderRadius:'50%',background:'currentColor'}}),label);
    const titles={
      local_production_create:'制作条件を保存',local_workflow_catalog:'利用できるモデルとノードを確認',
      local_workflow_draft:'ワークフローを設計・検証',local_production_render:'画像・動画を生成',local_prepared_render:'画像を生成',
      local_image_prepare:'生成条件を準備',
      local_moss_official_prepare:'MOSSの生成条件を準備',local_qwen21_prepare:'Qwenの生成条件を準備',local_catalog_prepare:'ワークフローの生成条件を準備',
      local_moss_pe_start:'MOSSのプロンプト改善を開始',local_moss_pe_result:'MOSSのプロンプト改善結果を確認',local_moss_pe_decide:'MOSSの改善結果を判断',local_moss_pe_reconcile:'MOSSの改善処理を照合',
      local_qwen_pe_start:'Qwenのプロンプト改善を開始',local_qwen_pe_result:'Qwenのプロンプト改善結果を確認',local_qwen_pe_decide:'Qwenの改善結果を判断',local_qwen_pe_reconcile:'Qwenの改善処理を照合',
      local_render_result:'保存した成果物を表示',local_production_evaluate:'成果物を評価',local_production_cancel:'制作を停止',
      local_production_history:'制作履歴を確認',local_production_feedback:'利用者の評価を記録',
      local_production_iteration:'改善案を記録',local_resource_status:'実行資源を確認',
      local_input_images:'添付画像を確認',local_asset_import:'入力・参照画像を保存',local_asset_view:'入力・参照画像を表示',
    };
    const media=new Set(['image/png','image/jpeg','image/webp','image/gif']);
    const imageTools=new Set(['local_production_render','local_prepared_render','local_render_result']);
    const imageDataKey='local-genai-generated-images';
    const integer=value=>Number.isSafeInteger(value)&&value>0;
    function imageReference(value){
      if(!value||typeof value!=='object'||typeof value.attachmentId!=='string'||!value.attachmentId||!media.has(value.mediaType)
        ||!integer(value.bytes)||!integer(value.width)||!integer(value.height))return null;
      if(value.name!==undefined&&typeof value.name!=='string')return null;
      return value;
    }
    function videoReference(value){
      return value&&/^sha256:[a-f0-9]{64}$/.test(value.attachmentId??'')&&typeof value.name==='string'&&/\.mp4$/i.test(value.name)
        &&!/[\\/\x00-\x1f\x7f]/.test(value.name)&&integer(value.bytes)&&value.bytes<=256*1024*1024?value:null;
    }
    function videoUrl(sessionId,attachment){
      if(typeof sessionId!=='string'||!sessionId||!videoReference(attachment))throw new Error('A recorded session video is required.');
      return `/api/local-studio/video?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachment.attachmentId)}`;
    }
    function originalReference(meta,image){
      if(!meta||typeof meta.runId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(meta.runId)
        ||!image||typeof image.name!=='string'||image.name.length>200||!/^[a-zA-Z0-9_.-]+\.png$/i.test(image.name)||image.name.includes('..')||!/^[a-f0-9]{64}$/.test(image.artifactSha256??''))return null;
      return {runId:meta.runId,name:image.name,sha256:image.artifactSha256};
    }
    function originalUrl(sessionId,original){
      if(typeof sessionId!=='string'||!sessionId||!originalReference({runId:original?.runId},{name:original?.name,artifactSha256:original?.sha256}))throw new Error('A recorded original is required.');
      return `/api/local-studio/original-image?sessionId=${encodeURIComponent(sessionId)}&runId=${encodeURIComponent(original.runId)}&name=${encodeURIComponent(original.name)}&sha256=${encodeURIComponent(original.sha256)}`;
    }
    function VideoResult({attachment,loadVideo}){
      if(typeof loadVideo!=='function')return h('p',null,'動画は保存されています。会話を開き直すと再生できます。');
      const url=loadVideo(attachment);
      return h('figure',{className:'local-genai-video',style:{margin:'12px 0',maxWidth:'100%',minWidth:0}},
        h('video',{controls:true,preload:'metadata',playsInline:true,src:url,style:{display:'block',width:'100%',maxHeight:'640px',borderRadius:'var(--dsw-radius-md, 12px)',background:'var(--dsw-alias-bg-base)'},'aria-label':attachment.name}),
        h('figcaption',{style:{...secondary,paddingTop:'8px'}},h('a',{href:url,download:attachment.name,style:linkStyle},`${attachment.name} を保存`),` · ${sizeText(attachment.bytes)} · 評価画像は抜粋フレームです。動きは再生して確認できます。`));
    }
    // Replay the durable, human-visible content. Model-only replacements and
    // metadata do not supply images; the same projection works after a reload.
    const generatedImagesDefinition={
      kind:imageDataKey,
      match(event){
        if(event.type==='turn/start')return{id:String(event.data.turn),role:'start'};
        if(event.type==='tool/call'||(event.type==='tool/result'&&event.surfaceOp==='append'))return{id:String(event.data.turn),role:'update'};
        return null;
      },
      start(_context,{event}){return{turn:event.data.turn,calls:new Map(),images:[],files:[]};},
      update({state},{event}){
        if(event.type==='tool/call'){
          const calls=new Map(state.calls);calls.set(String(event.data.callId),event.data.name);
          return{...state,calls};
        }
        if(event.type!=='tool/result'||!imageTools.has(state.calls.get(String(event.data.message?.source?.callId))))return state;
        const content=event.data.message?.content;
        if(!Array.isArray(content))return state;
        let meta=null;try{meta=JSON.parse(content.find(part=>part?.type==='text'&&typeof part.text==='string')?.text??'null');}catch{}
        const imageParts=content.filter(part=>part?.type==='image');
        const completeMeta=Array.isArray(meta?.images)&&meta.images.length===imageParts.length;
        let imageIndex=0;
        const images=content.flatMap(part=>{
          const attachment=part?.type==='image'?imageReference(part.attachment):null;
          if(part?.type!=='image')return [];
          const original=completeMeta?originalReference(meta,meta.images[imageIndex]):null;imageIndex++;
          return attachment?[{seq:event.seq,attachment,...(original?{original}:{})}]:[];
        });
        const files=content.flatMap(part=>{const attachment=part?.type==='file'?videoReference(part.attachment):null;return attachment?[{seq:event.seq,attachment}]:[];});
        return images.length||files.length?{...state,images:[...state.images,...images],files:[...(state.files??[]),...files]}:state;
      },
      buildLocationData({state},scope,previous){
        if(scope!=='turn'||!state)return null;
        if(previous?.value.images===state.images&&previous?.value.files===state.files)return previous;
        return{kind:'turn',turn:state.turn,key:imageDataKey,value:{images:state.images,files:state.files}};
      },
    };
    function generatedImagesForTurn({turn,seq}){
      const data=turn?.data.get(imageDataKey);
      const files=(data?.files??[]).filter(file=>file.seq<=seq);
      const videoSequences=new Set(files.map(file=>file.seq));
      // A reopened result has the same content hash and run-specific name.
      // Different runs can have the same bytes, so the hash alone is not an identity.
      const latestVideos=new Map();
      for(const file of files)latestVideos.set(`${file.attachment.attachmentId}\0${file.attachment.name}`,file);
      const stillImages=new Map();
      for(const image of data?.images??[])if(image.seq<=seq&&!videoSequences.has(image.seq))stillImages.set(image.original?`${image.attachment.attachmentId}\0${image.original.runId}\0${image.original.name}\0${image.original.sha256}`:image.attachment.attachmentId,image);
      const events=[...stillImages.values()].map(image=>({kind:'image',seq:image.seq,image}));
      for(const [key,file] of latestVideos){
        // Do not deduplicate frame hashes: different time positions can be
        // pixel-identical, both within a clip and across different clips.
        const frames=(data?.images??[]).filter(image=>image.seq===file.seq&&image.seq<=seq);
        if(frames.length)events.push({kind:'video',seq:file.seq,key,file,frames});
      }
      events.sort((a,b)=>b.seq-a.seq);
      const visible=[];let stillIndex=0;
      for(const event of events){
        if(event.kind==='video'){
          const suffix=latestVideos.size>1?`（${event.file.attachment.name}）`:'';
          visible.push(...event.frames.map((frame,index)=>({attachment:frame.attachment,label:`評価フレーム ${index+1}${suffix}`,evaluationFrame:true,displayKey:`video:${event.key}:${index}`})));
        }else{
          visible.push({attachment:event.image.attachment,...(event.image.original?{original:event.image.original}:{}),label:stillIndex===0?'生成画像（最新）':`生成画像（以前の結果 ${stillIndex}）`,displayKey:`image:${event.image.attachment.attachmentId}:${event.image.original?.runId??''}:${event.image.original?.name??''}`});stillIndex++;
        }
      }
      return visible;
    }
    function generatedVideosForTurn({turn,seq}){
      const files=new Map();
      for(const file of turn?.data.get(imageDataKey)?.files??[])if(file.seq<=seq)files.set(`${file.attachment.attachmentId}\0${file.attachment.name}`,file);
      return[...files.values()].sort((a,b)=>b.seq-a.seq);
    }
    function GeneratedImagesTail(props){
      const images=generatedImagesForTurn(props);
      const videos=generatedVideosForTurn(props);
      if(!images.length&&!videos.length)return null;
      const frameCount=images.filter(image=>image.evaluationFrame).length;
      const title=videos.length?'今回の生成動画と評価フレーム':'今回の生成画像';
      const hint=frameCount?`評価用の抜粋フレーム ${frameCount} 枚。動画内の順に表示しています。${images.length>frameCount?'静止画像は最新の結果から表示しています。':''}クリックで拡大できます。動きや全編の品質は動画を再生して確認してください。`
        :images.length===1?'クリックで拡大できます。':`${images.length} 枚。最新の画像を先頭に表示しています。クリックで拡大できます。`;
      return h('section',{className:'local-genai-result local-genai-generated-images','aria-label':title,style:card},
        h('h3',{style:heading},title,badge(videos.length?`動画 ${videos.length} 本`:`画像 ${images.length} 枚`,'success')),
        ...videos.map(file=>h(VideoResult,{key:`${file.attachment.attachmentId}\0${file.attachment.name}`,attachment:file.attachment,loadVideo:props.loadVideo})),
        images.length?h('p',{style:{...secondary,margin:'0 0 14px'}},hint):null,
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',gap:'16px',alignItems:'start'}},...images.map(image=>
          h('figure',{key:image.displayKey??image.attachment.attachmentId,style:{margin:0,minWidth:0,padding:'10px',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:'var(--dsw-radius-md, 12px)',background:'var(--dsw-alias-bg-layer-2)'}},
            images.length>1||image.evaluationFrame?h('figcaption',{style:{...secondary,marginBottom:'8px',fontWeight:600}},image.label):null,
            h(ImageContent,{imageFactories:props.imageFactories,renderFactorySlot:props.renderFactorySlot,images:[image],loadImage:props.loadImage,align:'start',compact:false,thumbnail:false}),
            image.original&&typeof props.loadOriginal==='function'?h('figcaption',{style:{marginTop:'10px'}},h('a',{href:props.loadOriginal(image.original),download:image.original.name,style:linkStyle},'元のPNGを保存')):null,
            h('div',{style:{...secondary,marginTop:'6px'}},`${image.attachment.width} × ${image.attachment.height} px · プレビュー ${sizeText(image.attachment.bytes)}`)))));
    }
    /** Use the final content, never metadata's stale copy or a guessed artifact URL. */
    function resultView({toolName,phase,block}){
      const title=titles[toolName]??'画像制作';
      if(phase!=='result')return{title,state:'running',statusLabel:'処理中',summary:'処理中…',images:[],files:[],texts:[],facts:[]};
      const content=Array.isArray(block?.content)?block.content:[];
      const texts=content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text);
      const images=[];let invalidImage=false;
      const files=content.flatMap(part=>{const attachment=part?.type==='file'?videoReference(part.attachment):null;return attachment?[{attachment}]:[];});
      for(const part of content){
        if(part?.type!=='image')continue;
        const attachment=imageReference(part.attachment);
        if(attachment)images.push({attachment});else invalidImage=true;
      }
      let value=null;
      try{const parsed=JSON.parse(texts[0]);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=parsed;}catch{}
      const failed=Boolean(block?.isError);
      let summary=failed?'処理に失敗しました。詳細を確認してください。':files.length?`生成動画 ${files.length} 本・評価フレーム ${images.length} 枚`:images.length?`生成画像 ${images.length} 枚`:'完了';
      if(!failed&&value?.phase&&value.phase!=='completed')summary={failed:'生成に失敗しました。',cancelled:'停止済み',needs_attention:'確認が必要です。',recovery_required:'復旧の確認が必要です。'}[value.phase]??'処理結果を確認してください。';
      if(!failed&&toolName==='local_production_cancel')summary='停止を受け付けました。停止完了は制作状態で確認してください。';
      if(!failed&&toolName==='local_workflow_draft'&&Number.isSafeInteger(value?.workflow?.nodeCount))summary=`${value.workflow.nodeCount}ノードのワークフローを検証しました。`;
      const state=failed||value?.phase==='failed'?'error':['needs_attention','recovery_required','submission_unknown'].includes(value?.phase)?'attention':'result';
      const statusLabel=state==='error'?'処理失敗':state==='attention'?'確認が必要':value?.phase==='cancelled'?'停止済み':toolName==='local_production_cancel'?'停止受付':value?.phase&&value.phase!=='completed'?'状態を確認':'処理完了';
      const facts=[];
      const model=value?.brief?.modelProfile??value?.production?.modelProfile;
      const mode=value?.brief?.mode??value?.production?.mode;
      if(typeof model==='string')facts.push({label:'モデル',value:model});
      if(typeof mode==='string')facts.push({label:'モード',value:mode});
      const settings=value?.renderParameters;
      if(Number.isSafeInteger(settings?.width)&&Number.isSafeInteger(settings?.height))facts.push({label:'キャンバス',value:`${settings.width} × ${settings.height} px`});
      if(Number.isSafeInteger(settings?.steps))facts.push({label:'Steps',value:String(settings.steps)});
      if(typeof settings?.seed==='string'||Number.isSafeInteger(settings?.seed))facts.push({label:'Seed',value:String(settings.seed)});
      if(['complete','revise','needs_user'].includes(value?.decision))facts.push({label:'エージェントの判断',value:{complete:'評価基準に適合',revise:'改善へ進む',needs_user:'利用者の確認待ち'}[value.decision]});
      return{title,state,statusLabel,summary,images,files,texts,facts,invalidImage,proposalId:!failed&&typeof value?.proposal?.id==='string'?value.proposal.id:null};
    }
    function LocalProductionView(props){
      const view=resultView(props);
      const renderImage=image=>h(ImageContent,{imageFactories:props.imageFactories,renderFactorySlot:props.renderFactorySlot,images:[image],loadImage:props.loadImage,align:'start',compact:false,thumbnail:false});
      const gallery=view.images.length&&typeof props.renderFactorySlot==='function'
        ?view.images.length===1?renderImage(view.images[0]):h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',gap:'12px'}},...view.images.map((image,index)=>h('div',{key:`${image.attachment.attachmentId}:${index}`,style:{minWidth:0}},renderImage(image)))):null;
      return h('section',{className:'local-genai-result','data-local-genai-tool':props.toolName,'aria-label':view.title,style:card},
        h('h3',{style:heading},view.title,badge(view.statusLabel,view.state==='error'?'error':view.state==='attention'?'warn':view.state==='running'||['停止済み','停止受付','状態を確認'].includes(view.statusLabel)?'idle':'success')),h('p',{role:view.state==='error'?'alert':'status',style:{...secondary,margin:'0 0 12px'}},view.summary),
        ...view.files.map(file=>h(VideoResult,{key:file.attachment.attachmentId,attachment:file.attachment,loadVideo:props.loadVideo})),
        gallery,
        view.facts.length?h('dl',{style:{display:'grid',gridTemplateColumns:'max-content minmax(0, 1fr)',gap:'6px 16px',fontSize:'0.8rem',margin:'14px 0'}},...view.facts.flatMap(fact=>[h('dt',{key:fact.label+':label',style:secondary},fact.label),h('dd',{key:fact.label,style:{margin:0,overflowWrap:'anywhere'}},fact.value)])):null,
        view.invalidImage?h('p',{role:'alert'},'画像の参照情報が不完全です。保存結果を確認してください。'):null,
        view.images.length&&!gallery?h('p',{role:'alert'},'画像表示機能を読み込めませんでした。保存画像は保持されています。'):null,
        view.texts.length?h('details',{style:recordStyle},h('summary',{style:{cursor:'pointer',color:'var(--dsw-alias-label-secondary)'}},'制作記録と詳細'),h('pre',{style:preStyle},view.texts.join('\n'))):null,
        typeof props.inspect==='function'?h(Button,{type:'button',variant:'outline',size:'sm',style:{marginTop:'12px'},onClick:props.inspect},'実行記録を確認'):null);
    }
    function apply(ctx){
      const imageFactories=createImageFactories(ctx);
      for(const toolName of Object.keys(titles))ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:toolName,inject:sessionId=>({sessionId,imageFactories,loadVideo:attachment=>videoUrl(sessionId,attachment)})},LocalProductionView));
      ctx.effect(()=>ctx.uiConversation.events.register(generatedImagesDefinition));
      ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:imageDataKey,order:10,inject:sessionId=>({imageFactories,loadImage:Object.assign(attachment=>ctx.uiConversation.imageUrl(sessionId,attachment),{peek:attachment=>ctx.uiConversation.peekImageUrl(sessionId,attachment)}),loadVideo:attachment=>videoUrl(sessionId,attachment),loadOriginal:original=>originalUrl(sessionId,original)})},GeneratedImagesTail));
    }
    return{inject:['slots','uiConversation'],apply,createImageFactories,ImageContent,LocalProductionView,resultView,GeneratedImagesTail,generatedImagesDefinition,generatedImagesForTurn,generatedVideosForTurn,VideoResult,videoUrl,originalUrl};
  },
});
