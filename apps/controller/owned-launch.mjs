// An accepted request must not crash the Controller if its deferred launch
// throws (including an error in the launcher's own rejection handler).
// Preserve a snapshot of the committed owner, and never restart or release it.
const ownerKeys=['id','requestId','controllerId','sessionId','productionId','kind'];
export function recordOwnedLaunchFailure(store,owner) {
  try {
    if(typeof owner?.id!=='string'||typeof owner.requestId!=='string'||typeof owner.controllerId!=='string') throw Error('owner unavailable');
    if(store.markLaunchFailure(owner))return;
    const current=store.get(owner.id);
    if(current&&ownerKeys.every(key=>current[key]===owner[key])&&['completed','failed','cancelled'].includes(current.phase))return;
    throw Error('owner mismatch or run unavailable');
  } catch {
    // Do not log user input, generated content or error details.
    try { console.error('Owned run launch or execution failed; durable status could not be updated.'); } catch {}
  }
}

export function scheduleOwnedLaunch({store,run,launch}) {
  const owner=Object.fromEntries(ownerKeys.map(key=>[key,run?.[key]]));
  setImmediate(async()=>{
    try { await launch(); }
    catch {
      // If recording fails, leave run and lease untouched. Recovery must be
      // inspected; the generic diagnostic contains no user data.
      recordOwnedLaunchFailure(store,owner);
    }
  });
}
