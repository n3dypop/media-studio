// Synthetic witnesses only; never use this helper for a real runtime.
import {beginCutover,initializeCutoverLedger} from '../../apps/controller/search/cutover-ledger.mjs';
import {initializeSearchLedger} from '../../apps/controller/search/ledger-schema.mjs';
import {commitPreparedCutover} from '../../apps/controller/search/cutover-transaction.mjs';
export function fixtureRow(session='fixture-setup'){return {session_id:session,generation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)};}
export function stageAndRecord(store,row){beginCutover(store,row,()=>true);return commitPreparedCutover(store,row,()=>true);}
export function migrateFixture(store){initializeSearchLedger(store);store.transaction(()=>initializeCutoverLedger(store.db));const row=fixtureRow();beginCutover(store,row,()=>true);return commitPreparedCutover(store,row,()=>true);}
