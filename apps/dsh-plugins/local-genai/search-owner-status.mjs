// Per-Host advisory gate only. Controller's durable ownership remains the
// authority; this map is not proof that a previous stop was persisted.
const turns=new Map();
const transitions={pending:['pending','active','blocked','ended'],active:['active','ended','blocked'],ended:['ended','completed','blocked'],completed:['completed','blocked'],blocked:['blocked']};
export function setSearchOwnerStatus(sessionId,turn,state){if(typeof sessionId!=='string'||!Number.isSafeInteger(turn)||turn<1||!Object.hasOwn(transitions,state))throw Error('Invalid search owner status');const previous=turns.get(sessionId);if(previous?.turn>turn||previous?.turn===turn&&!transitions[previous.state].includes(state))return false;turns.set(sessionId,{turn,state});return true;}
export function requireSearchOwnerStatus(sessionId,turn){const value=turns.get(sessionId);if(value?.turn!==turn||value.state!=='active')throw Error('Search ownership is unresolved. Continue local work; ask a maintenance agent to inspect search before proposing external requests.');}
export function isSearchOwnerOpen(sessionId,turn){const value=turns.get(sessionId);return value?.turn===turn&&(value.state==='active'||value.state==='completed');}
export function clearSearchOwnerStatus(sessionId){turns.delete(sessionId);}
