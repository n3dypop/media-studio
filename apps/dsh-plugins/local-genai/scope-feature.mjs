// Process-local liveness gate for the exact managed provider call. This is
// not a substitute for Controller ownership or durable wire evidence.
const seen=new Map();
export function resetScopeFeature(sessionId){seen.delete(sessionId);}
export function observeScopeFeature(sessionId,scopeId){seen.set(sessionId,scopeId);}
export function requireScopeFeature(sessionId){if(!seen.has(sessionId))throw Error('The active DSH provider did not invoke the required managed inference hook. Use a supported DSH build with the managed provider configured; no mutation was sent.');}
