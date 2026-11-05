// Stop-only shared Controller ledger. This code never creates a database or
// table and never writes anything except the monotonic session/turn stop row.
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {assertCutoverLedger,currentCutoverTurn,writeCutoverTurn} from '../../controller/search/cutover-ledger.mjs';

const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function identity(path,directory=false){
 const s=lstatSync(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(!directory&&s.nlink>1)||!same(resolve(realpathSync(path)),resolve(path)))throw Error('Search stop database path is unsafe');
 return {dev:s.dev,ino:s.ino};
}
const equal=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function sidecars(file){
 const result=[];for(const suffix of ['-wal','-shm'])try{result.push(identity(file+suffix));}catch(error){if(error.code!=='ENOENT')throw error;result.push(null);}
 if(result[0]&&!result[1])throw Error('Search stop WAL identity is incomplete');return result;
}
export function pinSearchStopDatabase(runtimeRoot){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||/^[\\/]{2}/.test(runtimeRoot))throw Error('Search stop root must be local and absolute');
 const root=resolve(runtimeRoot),data=join(root,'data'),directory=join(data,'controller'),file=join(directory,'controller.db'),paths=[root,data,directory,file],original=paths.map((p,i)=>identity(p,i<3));
 const unchanged=()=>{const current=paths.map((p,i)=>identity(p,i<3));if(current.some((x,i)=>!equal(x,original[i])))throw Error('Search stop database generation changed');};
 // Require the Controller's completed migration, not merely a lookalike file.
 sidecars(file);const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');if(db.prepare("SELECT value FROM meta WHERE key='searchSessionTurns:v1'").get()?.value!=='done')throw Error('Search stop ledger is not initialized');assertCutoverLedger(db);const columns=db.prepare('PRAGMA table_info(search_session_turns)').all();if(columns.map(c=>c.name).join(',')!=='session_id,latest,stopped_at'||columns[0].pk!==1||db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='search_session_turns'").get().n!==0||db.prepare('PRAGMA foreign_key_list(search_session_turns)').all().length!==0)throw Error('Search stop schema differs');}finally{db.close();}unchanged();sidecars(file);
 return Object.freeze({stop(sessionId,turn){
  if(typeof sessionId!=='string'||!/^[\x21-\x7e]{1,150}$/.test(sessionId)||!Number.isSafeInteger(turn)||turn<1)throw Error('Search stop identity is invalid');
  unchanged();sidecars(file);
  const db=new DatabaseSync(file);let result;
  try{
   db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');if(db.prepare('PRAGMA synchronous').get()?.synchronous!==2||db.prepare('PRAGMA journal_mode').get()?.journal_mode?.toLowerCase()!=='wal')throw Error('Search stop durability mode differs');db.exec('BEGIN IMMEDIATE;');unchanged();sidecars(file);
   if(db.prepare("SELECT value FROM meta WHERE key='searchSessionTurns:v1'").get()?.value!=='done')throw Error('Search stop ledger generation differs');
   if(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='search_session_turns'").get().n!==0||db.prepare('PRAGMA foreign_key_list(search_session_turns)').all().length!==0)throw Error('Search stop schema changed');
   const scoped=currentCutoverTurn(db,sessionId),old=scoped?scoped.row:db.prepare('SELECT latest,stopped_at FROM search_session_turns WHERE session_id=?').get(sessionId),count=db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n;if(scoped&&turn<=scoped.generation.boundary_turn)throw Error('A legacy turn cannot stop the new generation');
   if((old&&(!Number.isSafeInteger(old.latest)||old.latest<0||!(old.stopped_at===null||Number.isSafeInteger(old.stopped_at)&&old.stopped_at>=0)))||(!old&&count>=10000))throw Error('Search stop ledger row is invalid');
   if(old&&old.latest>turn)result='superseded';else{
    if(scoped)writeCutoverTurn(db,sessionId,turn,Math.max(old?.stopped_at??0,turn));else db.prepare('INSERT INTO search_session_turns(session_id,latest,stopped_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET latest=excluded.latest,stopped_at=MAX(COALESCE(search_session_turns.stopped_at,0),excluded.stopped_at) WHERE search_session_turns.latest<=excluded.latest').run(sessionId,turn,turn);
    const saved=scoped?currentCutoverTurn(db,sessionId).row:db.prepare('SELECT latest,stopped_at FROM search_session_turns WHERE session_id=?').get(sessionId);if(saved?.latest!==turn||!Number.isSafeInteger(saved.stopped_at)||saved.stopped_at<turn)throw Error('Search stop was not durably recorded');result='stopped';
   }
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  unchanged();sidecars(file);return result;
 }});
}
