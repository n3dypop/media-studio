// Process-local liveness gate for the exact managed provider call. This is
// not a substitute for Controller ownership or durable wire evidence.
const seen=new Map();
export function resetScopeFeature(sessionId){seen.delete(sessionId);}
export function observeScopeFeature(sessionId,scopeId){seen.set(sessionId,scopeId);}
export function requireScopeFeature(sessionId){if(!seen.has(sessionId))throw Error('The active DSH provider did not invoke the required managed inference hook. Upgrade to a verified DSH 0.2.2-rc.1 runtime; no mutation was sent.');}
