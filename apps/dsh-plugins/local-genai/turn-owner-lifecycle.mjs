// Serialize the persisted end of one turn before
// registering the next one. A failure remains unresolved for this Host.
export function createTurnOwnerLifecycle({owner,mapSessionId,hostId,sessions,persistence}){
 if(typeof owner?.begin!=='function'||typeof owner?.complete!=='function'||typeof mapSessionId!=='function'||typeof hostId!=='string')throw Error('Turn owner lifecycle dependencies are unavailable');
 const tails=new Map(),active=new Map(),failed=new Map();
 function identity(session){const id=mapSessionId(session?.id);if(typeof id!=='string'||!id)throw Error('Turn owner session identity is unavailable');return id;}
 function enqueue(id,operation){
  const prior=tails.get(id)??Promise.resolve();
  const task=prior.then(()=>{if(failed.has(id))throw failed.get(id);return operation();});
  tails.set(id,task.then(()=>{},error=>{if(!failed.has(id))failed.set(id,error);}));
  return task;
 }
 return Object.freeze({
  begin(session,turn){const id=identity(session);return enqueue(id,async()=>{if(active.has(id))throw Error('An earlier owned turn remains unresolved');const result=await owner.begin({session,sessions,persistence,mapSessionId,turn,hostId});active.set(id,{session,turn});return result;});},
  end(session,event){const id=identity(session);if(event?.type!=='turn/end')return Promise.resolve(false);return enqueue(id,async()=>{const current=active.get(id);if(!current||current.session!==session||current.turn!==event.data?.turn)return false;if(event.data?.reason?.kind!=='completed')throw Error('The owned turn did not complete normally; search remains unresolved');
   // DSH invokes listeners synchronously while appending its end event. Give
   // that append a chance to return before reading through the official flush.
   await new Promise(resolve=>setImmediate(resolve));await owner.complete({session,sessions,persistence,mapSessionId,turn:current.turn,hostId});active.delete(id);return true;});},
  async drain(){await Promise.all(tails.values());return {active:active.size,failed:failed.size};}
 });
}
