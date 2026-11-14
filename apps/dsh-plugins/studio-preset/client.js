// DSH public client-plugin closure. This plugin owns its slots and lifecycle.
window.__ModuleLoader__.load({
  id:"local-genai-studio-preset",
  factory(require){
    const {createElement:h}=require('react');
    const legacyPresets=new Set(['local-workflow-development','local-image-generation']);
    function studioSeatState(state){
      return{...state,current:legacyPresets.has(state.current)?'local-image':state.current,
        options:state.options.filter(option=>!legacyPresets.has(option.id)).map(option=>option.id==='local-image'?{...option,name:'media-studio'}:option)};
    }
    // Reuse the official component, store hooks and selection callback. Only the
    // two known compatibility ids are removed from this new-session picker.
    function installStudioPicker(ctx){
      if(typeof ctx.slots.entries!=='function'||typeof ctx.on!=='function')return;
      const key='conversation.hero.agentPreset';let source,dispose,changing=false;
      const update=()=>{
        if(changing)return;
        changing=true;
        try{
          const found=ctx.slots.entries(key).find(entry=>entry.locale==='settings.agentPreset'&&entry.component!==source?.adapter&&entry.inject&&entry.options.priority!==-1000);
          if(source?.entry===found)return;
          dispose?.();dispose=undefined;source=undefined;
          if(!found)return;
          const adapter=props=>h(found.component,{...props,useAgentPresetSeat:selector=>props.useAgentPresetSeat(state=>selector(studioSeatState(state)))});
          source={entry:found,adapter};
          dispose=ctx.slots.register({name:key,priority:-1000,locale:found.locale,inject:found.inject},adapter);
        }finally{changing=false;}
      };
      const unsubscribe=ctx.on('slots/changed',changed=>{if(changed===key)update();});
      ctx.effect(()=>()=>{unsubscribe?.();dispose?.();});
      update();
    }
    function apply(ctx){installStudioPicker(ctx);}
    return{inject:['slots'],apply,studioSeatState,installStudioPicker};
  },
});
