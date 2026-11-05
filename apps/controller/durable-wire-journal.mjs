// Read-only view of the DSH journal. No prompt, image, raw nonce or response
// text is returned. The caller must treat every error as unconfirmed evidence.
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {wireInputReceipts} from './durable-wire-evidence.mjs';

const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function identity(path,{directory=false,optional=false}={}){
  let stat;try{stat=lstatSync(path);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||(!directory&&stat.nlink>1)||!same(resolve(realpathSync(path)),resolve(path)))throw Error('Journal path is unsafe or redirected');
  return {dev:stat.dev,ino:stat.ino};
}
function equal(a,b){return a===null?b===null:b!==null&&a.dev===b.dev&&a.ino===b.ino;}

export class DurableWireJournalReader {
  constructor(root){if(typeof root!=='string'||!isAbsolute(root)||/^[\\/]{2}/.test(root))throw Error('An absolute local runtime root is required');this.root=resolve(root);}
  collect(sessionId,messages){
    const root=this.root,data=join(root,'data'),directory=join(data,'dsh-mutations'),file=join(directory,'intents.sqlite'),wal=file+'-wal',shm=file+'-shm';
    const before=[identity(root,{directory:true}),identity(data,{directory:true}),identity(directory,{directory:true}),identity(file),identity(wal,{optional:true}),identity(shm,{optional:true})];
    if(before[4]&&!before[5])throw Error('Journal WAL identity is incomplete');
    const db=new DatabaseSync(file,{readOnly:true});let result;
    try{
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN;');
      if(db.prepare('PRAGMA user_version').get()?.user_version!==4)throw Error('Journal generation is unsupported');
      const find=db.prepare('SELECT state,receipt_hash,ack_nonce_hash,call_id_hash,delivery_call_id_hash FROM intents WHERE session_id=? AND id=?');
      result=wireInputReceipts({sessionId,messages,verify:record=>{const row=find.get(sessionId,record.intentId);if(!row||row.state!=='receipt')return 'not-current';return row.receipt_hash===record.receiptHash&&row.ack_nonce_hash===record.receiptNonceHash&&(row.delivery_call_id_hash??row.call_id_hash)===record.priorCallIdHash?true:'not-current';}});
      db.exec('COMMIT');
    }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
    const after=[identity(root,{directory:true}),identity(data,{directory:true}),identity(directory,{directory:true}),identity(file),identity(wal,{optional:true}),identity(shm,{optional:true})];
    if(before.some((item,index)=>!equal(item,after[index])))throw Error('Journal generation changed during evidence collection');
    return result;
  }
}
