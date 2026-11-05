import test from 'node:test';
import assert from 'node:assert/strict';
import {installRoleRestriction,isManagedAgent} from '../apps/dsh-plugins/local-genai/role-scope.mjs';

test('managed scope follows the actual opaque preset scope and disposal',()=>{
 const handlers=new Map(),owner={},other={},agents=new Map();let released=0;
 const ctx={agents:{get:id=>agents.get(id)},on:(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name);},effect:fn=>fn()};
 const scopeOf=value=>value===ctx?owner:value.scope,scopeChainOf=scope=>[scope],agent=(id,scope)=>({id,ctx:{scope,tools:{restrict:()=>()=>released++}}}),a=agent('a',owner),b=agent('b',other);
 const dispose=installRoleRestriction(ctx,{scopeOf,scopeChainOf,allowedTools:['fixture']});try{handlers.get('agent/created')({agent:a});handlers.get('agent/created')({agent:b});assert.equal(isManagedAgent(a),true);assert.equal(isManagedAgent(b),false);a.ctx.scope=other;assert.equal(isManagedAgent(a),false,'Scope changes are rechecked even before a selection event');agents.set('a',a);handlers.get('agent-preset/selected')('a');assert.equal(isManagedAgent(a),false);assert.equal(released,1);a.ctx.scope=owner;handlers.get('agent-preset/selected')('a');assert.equal(isManagedAgent(a),true);}finally{dispose();}assert.equal(isManagedAgent(a),false);assert.equal(released,2);
});
