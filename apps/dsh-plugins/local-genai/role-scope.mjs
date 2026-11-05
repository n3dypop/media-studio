// The gateway may recognize only agents whose opaque scope has actually been
// matched to a retained local-genai preset. Never infer this from model names.
const managedAgents=new WeakMap();
export function isManagedAgent(agent){if(!agent||typeof agent!=='object')return false;for(const matches of managedAgents.get(agent)??[])try{if(matches())return true;}catch{/* Unknown scope never becomes permission. */}return false;}

/** Keep an agent-local inherited-tool mask aligned with its retained preset scope. */
export function installRoleRestriction(ctx, { scopeOf, scopeChainOf, allowedTools }) {
  if (typeof scopeOf !== 'function' || typeof scopeChainOf !== 'function') throw new TypeError('DSH scope bindings are required.');
  const owner = scopeOf(ctx);
  if (owner === undefined) throw new Error('Role restrictions require a preset scope.');
  if (!Array.isArray(allowedTools) || !allowedTools.length || allowedTools.some(name => typeof name !== 'string' || !name)) {
    throw new TypeError('Role restrictions require explicit tool names.');
  }
  if (typeof ctx.agents?.get !== 'function') throw new Error('Role restrictions require the DSH agent registry.');
  const allow = [...new Set(allowedTools)];
  const masks = new Map();
  let disposed = false;

  function remove(agent) {
    const entry = masks.get(agent);
    if (!entry) return;
    masks.delete(agent);
    const validators=managedAgents.get(agent);validators?.delete(entry.matches);if(!validators?.size)managedAgents.delete(agent);
    entry.release();
  }
  function reconcile(agent) {
    if (disposed || !agent?.ctx) return;
    // Preset IDs can outlive revisions; compare opaque scope identity instead.
    let belongs=false;try{belongs=scopeChainOf(scopeOf(agent.ctx)).includes(owner);}catch{/* Unknown scope is outside the preset. */}
    if (!belongs) { remove(agent); return; }
    if (!masks.has(agent)){const matches=()=>scopeChainOf(scopeOf(agent.ctx)).includes(owner),release=agent.ctx.tools.restrict({ allow });masks.set(agent,{release,matches});const validators=managedAgents.get(agent)??new Set();validators.add(matches);managedAgents.set(agent,validators);}
  }
  const offCreated = ctx.on('agent/created', ({ agent }) => reconcile(agent));
  const offSelected = ctx.on('agent-preset/selected', sessionId => {
    const agent = ctx.agents.get(sessionId);
    // A reused session ID must never retain an earlier Agent object's mask.
    for (const retained of masks.keys()) if (retained.id === sessionId && retained !== agent) remove(retained);
    if (agent) reconcile(agent);
  });
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => remove(agent));
  return ctx.effect(() => () => {
    if (disposed) return;
    disposed = true;
    offCreated(); offSelected(); offDisposed();
    for (const agent of masks.keys()) remove(agent);
  }, 'local-genai.role-restriction');
}
