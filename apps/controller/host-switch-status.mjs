// Read-only snapshot for an operator who has already stopped the old Host.
// It does not fence new HTTP requests and is not a GPU or Host lease.
export function controllerSwitchStatus({controllerId, closing, mutations, resourceOperation, store, engine, gate, inferenceScope, inferenceBySession, searches, search, mossPe, qwenPe, isIdle}) {
  const busy=new Set(), unknown=new Set();
  const number=value=>Number.isSafeInteger(value)&&value>=0;
  const collection=(value,label)=>{
    if(!value||!number(value.size))unknown.add(label);
    else if(value.size>0)busy.add(label);
  };
  try {
    if(typeof controllerId!=='string'||!controllerId)unknown.add('controller-identity');
    if(typeof closing!=='boolean'||!number(mutations)||typeof resourceOperation!=='boolean')unknown.add('controller-admission');
    else if(closing||mutations>0||resourceOperation)busy.add('controller-admission');
    if(typeof isIdle!=='function')unknown.add('controller-activity');
    else {const idle=isIdle();if(typeof idle!=='boolean')unknown.add('controller-activity');else if(!idle)busy.add('controller-activity');}
    if(typeof store?.active!=='function')unknown.add('run-ledger');
    else {const active=store.active();if(active===undefined)unknown.add('run-ledger');else if(active!==null)busy.add('run-ledger');}
    collection(engine?.work,'generation');
    collection(mossPe?.work,'moss-enhancement');
    collection(qwenPe?.work,'qwen-enhancement');
    if(inferenceScope===undefined)unknown.add('inference');else if(inferenceScope!==null)busy.add('inference');
    collection(inferenceBySession,'inference');
    collection(searches,'search');
    collection(search?.active,'search');
    if(typeof search?.list!=='function'||search?.persistenceFault!==false)unknown.add('search-ledger');
    else {
      const records=search.list();
      if(!Array.isArray(records))unknown.add('search-ledger');
      else for(const record of records){
        if(['awaiting_approval','approved','running'].includes(record?.phase))busy.add('search-ledger');
        else if(!['completed','cancelled'].includes(record?.phase))unknown.add('search-ledger');
      }
    }
    if(typeof gate?.status!=='function')unknown.add('resource-gate');
    else {
      const current=gate.status();
      if(!current||current.initialized!==true||typeof current.blocked!=='boolean'||!number(current.activeCore)||!Object.hasOwn(current,'generationRunId')||!['none','core','unknown','draining_core','loading_core','generator','enhancer','releasing_resources','restoring_core'].includes(current.owner))unknown.add('resource-gate');
      else if(current.owner==='unknown'||current.blocked)unknown.add('resource-gate');
      else if(current.activeCore>0||current.generationRunId!==null||!['none','core'].includes(current.owner))busy.add('resource-gate');
    }
  } catch { unknown.add('controller-observation'); }
  return {
    scope:'controller-only',controllerId:typeof controllerId==='string'&&controllerId?controllerId:null,processId:process.pid,
    state:unknown.size?'unknown':busy.size?'busy':'idle',
    busy:[...busy].sort(),unknown:[...unknown].sort(),
    externalChecksRequired:['previous-host-exited','comfy-queue','strata-inference','service-operations'],
    note:'Snapshot only; it does not freeze admission or establish exclusive ownership.',
  };
}
