import {createHash} from 'node:crypto';

// Shared by Controller and DSH Host. All reads/writes run in the caller's
// SQLite transaction; the manifest covers identities, not resource cleanup.
const tables={
  search_turn_owners:['session_id','turn'],
  search_turn_owner_run_states:['proposal_id'],
  search_turn_owner_recoveries:['session_id','turn'],
  search_turn_owner_run_processes:['proposal_id'],
  search_turn_owner_uncertain_claims:['proposal_id'],
  search_turn_owner_legacy_attestations:['session_id','turn'],
  search_turn_owner_legacy_migrations:['session_id','turn'],
  search_session_host_generations:['session_id','host_id'],
};
const key='searchTurnOwnershipManifest:v1',marker='searchTurnOwnershipIntegrity:v1';
function value(db){const data={};for(const [table,pk] of Object.entries(tables))data[table]=db.prepare(`SELECT * FROM ${table} ORDER BY ${pk.join(',')}`).all();const sha256=createHash('sha256').update(JSON.stringify(data)).digest('hex');return JSON.stringify({sha256,counts:Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,rows.length]))});}
export function initializeOwnerManifest(db){
  const m=db.prepare('SELECT value FROM meta WHERE key=?').get(marker),saved=db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  if(m&&m.value!=='done'||m&&!saved||saved&&!m)throw Error('Search owner marker or manifest is invalid');
  const actual=value(db);if(saved&&saved.value!==actual)throw Error('Search owner manifest differs');
  if(!m)db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker,'done');if(!saved)db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key,actual);
}
export function assertOwnerManifest(db){const m=db.prepare('SELECT value FROM meta WHERE key=?').get(marker),saved=db.prepare('SELECT value FROM meta WHERE key=?').get(key);if(m?.value!=='done'||!saved||saved.value!==value(db))throw Error('Search owner manifest is unavailable or differs');}
export function updateOwnerManifest(db){const m=db.prepare('SELECT value FROM meta WHERE key=?').get(marker);if(m?.value!=='done'||db.prepare('UPDATE meta SET value=? WHERE key=?').run(value(db),key).changes!==1)throw Error('Search owner manifest is unavailable');}
