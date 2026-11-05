import {mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,lstatSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {readPublicPage,pageUrl} from './page.mjs';

export class SearchError extends Error {
  constructor(code,message,status=400){super(message);this.name='SearchError';this.code=code;this.status=status;}
}
const fail=(code,message,status)=>{throw new SearchError(code,message,status);};
const clone=v=>structuredClone(v);
const now=()=>new Date().toISOString();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const terminal=new Set(['completed','cancelled','needs_attention']);
const idPattern=/^[a-f0-9-]{36}$/;
function text(value,name,max){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('INVALID_INPUT',`Invalid ${name}`);return value;}
function queryList(queries){
  if(!Array.isArray(queries)||queries.length<1||queries.length>5)fail('INVALID_QUERIES','Provide one to five explicit search queries');
  const result=queries.map(q=>text(q,'query',240));
  if(new Set(result).size!==result.length)fail('DUPLICATE_QUERY','Each approved query is sent once');
  // RustXNG's query parser can select engines, languages, external redirects and timeouts.
  // These controls must never bypass the engine/word set displayed for approval.
  if(result.some(q=>/(?:^|\s)[!:<]/u.test(q)))fail('QUERY_CONTROL_FORBIDDEN','RustXNG bang, language and timeout operators are not accepted');
  return result;
}
function publicResultUrl(value){
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return null;
    const host=url.hostname.toLowerCase();if(!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||isIP(host.replace(/^\[|\]$/g,'')))return null;
    return url.href;
  }catch{return null;}
}
async function boundedJson(response,maxBytes=1024*1024){
  if(!response.ok)throw new SearchError('UPSTREAM_HTTP',`RustXNG returned HTTP ${response.status}`,502);
  if(!response.body)throw new SearchError('UPSTREAM_EMPTY','RustXNG response has no body',502);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new SearchError('UPSTREAM_TOO_LARGE','RustXNG response exceeds the response budget',502);}chunks.push(value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SearchError('UPSTREAM_JSON','RustXNG response is not valid JSON',502);}
}

/** Local approval ledger. Approval methods must be exposed only by the controller's user/admin route. */
export class SearchService {
  constructor({root,baseUrl='http://127.0.0.1:29483',enabled=true,fetchImpl=fetch,pageReader=readPublicPage,timeoutMs=20000,maxResults=5}={}){
    if(!root)fail('ROOT_REQUIRED','A workspace root is required');
    if(typeof enabled!=='boolean')fail('INVALID_SEARCH_CONFIGURATION','Search enabled must be boolean');
    this.enabled=enabled;
    const url=new URL(baseUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('INVALID_UPSTREAM','RustXNG must use an explicit loopback HTTP endpoint');
    this.root=resolve(root);this.directory=join(this.root,'data','search');this.baseUrl=url.origin;this.fetchImpl=fetchImpl;this.pageReader=pageReader;
    this.timeoutMs=Math.max(100,Math.min(Number(timeoutMs)||20000,60000));this.maxResults=Math.max(1,Math.min(Number(maxResults)||5,5));this.records=new Map();this.active=new Map();
    for(const p of [this.root,join(this.root,'data'),this.directory])if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('UNSAFE_STORAGE','Search ledger must not use links');
    mkdirSync(this.directory,{recursive:true});
    this.sessionStopsPath=join(this.directory,'session-stops.json');this.turns=new Map();this.persistenceFault=false;
    if(existsSync(this.sessionStopsPath)){
      const state=lstatSync(this.sessionStopsPath);
      if(!state.isFile()||state.isSymbolicLink()||state.size>2*1024*1024)fail('UNSAFE_STORAGE','Search session stop ledger must be a bounded regular file');
      let stops;try{stops=JSON.parse(readFileSync(this.sessionStopsPath,'utf8'));}catch{fail('LEDGER_CORRUPT','Search session stop ledger requires inspection',503);}
      if(![1,2].includes(stops.schema)||!Array.isArray(stops.sessions)||stops.sessions.length>10000)fail('LEDGER_CORRUPT','Search session stop ledger is invalid',503);
      for(const row of stops.sessions){
        // A legacy stopped session has no trustworthy turn. Keep it closed
        // rather than guessing that an incoming delayed turn is new.
        if(stops.schema===1){text(row,'sessionId',150);this.turns.set(row,{latest:0,stoppedAt:Number.MAX_SAFE_INTEGER});continue;}
        if(!row||typeof row!=='object')fail('LEDGER_CORRUPT','Invalid search turn record',503);
        text(row.sessionId,'sessionId',150);
        if(!Number.isSafeInteger(row.latest)||row.latest<0||!(row.stoppedAt===null||Number.isSafeInteger(row.stoppedAt)&&row.stoppedAt>=0)||this.turns.has(row.sessionId))fail('LEDGER_CORRUPT','Invalid search turn generation',503);
        this.turns.set(row.sessionId,{latest:row.latest,stoppedAt:row.stoppedAt});
      }
    }
    for(const name of readdirSync(this.directory)){
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=join(this.directory,name);if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())fail('UNSAFE_STORAGE','Search record must be a regular file');
      let record;try{record=JSON.parse(readFileSync(file,'utf8'));}catch{fail('LEDGER_CORRUPT','Search ledger requires inspection',503);}
      if(record.schema!==1||record.id+'.json'!==name||!Array.isArray(record.items)||!['awaiting_approval','approved','running',...terminal].includes(record.phase))fail('LEDGER_CORRUPT','Search ledger has an unknown record',503);
      const proposal=record.kind==='pages'?{kind:'pages',productionId:record.productionId,sessionId:record.sessionId,sourceProposalId:record.sourceProposalId,urls:record.urls,engine:record.engine,purpose:record.purpose}:{kind:'queries',productionId:record.productionId,sessionId:record.sessionId,queries:record.queries,engine:record.engine,purpose:record.purpose};
      if(record.proposalHash!==hash(proposal))fail('LEDGER_CORRUPT','Search proposal hash differs',503);
      if(record.phase==='running'){record.phase='needs_attention';record.error={code:'RESTART_AFTER_SEND',message:'An interrupted search may have been sent. It will not be retried automatically.'};for(const item of record.items)if(item.state==='sent')item.state='uncertain';this.save(record);}
      this.records.set(record.id,record);
    }
  }
  save(record){
    record.updatedAt=now();const target=join(this.directory,record.id+'.json');
    if(!idPattern.test(record.id)||!target.startsWith(this.directory+sep))fail('INVALID_ID','Invalid search grant id');
    const temporary=target+'.'+randomUUID()+'.partial';writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,target);this.records.set(record.id,record);
  }
  get(id){if(!idPattern.test(String(id)))fail('INVALID_ID','Invalid search grant id');const record=this.records.get(id);if(!record)fail('NOT_FOUND','Search grant not found',404);return record;}
  owned(id,sessionId){const record=this.get(id);if(typeof sessionId!=='string'||record.sessionId!==sessionId)fail('SESSION_MISMATCH','Search grant belongs to another session',403);return record;}
  saveSessionStops(){
    if(existsSync(this.sessionStopsPath)&&lstatSync(this.sessionStopsPath).isSymbolicLink())fail('UNSAFE_STORAGE','Search session stop ledger must not use links');
    const temporary=this.sessionStopsPath+'.'+randomUUID()+'.partial';
    writeFileSync(temporary,JSON.stringify({schema:2,sessions:[...this.turns].map(([sessionId,state])=>({sessionId,...state}))},null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,this.sessionStopsPath);
  }
  ensureSessionOpen(sessionId){if(this.persistenceFault)fail('LEDGER_WRITE_FAILED','Search ledger persistence failed; search is blocked until inspected',503);if(this.turns.get(sessionId)?.stoppedAt!==null&&this.turns.has(sessionId))fail('SESSION_STOPPED','The conversation was stopped; a new user turn is required',409);}
  // The trusted DSH pre-step hook calls this only on an explicit user turn.
  registerUserTurn(sessionId,turn){
    if(this.persistenceFault)fail('LEDGER_WRITE_FAILED','Search ledger persistence failed; search is blocked until inspected',503);
    text(sessionId,'sessionId',150);if(!Number.isSafeInteger(turn)||turn<1)fail('INVALID_TURN','A positive user-turn number is required');
    const previous=this.turns.get(sessionId);
    if(!previous&&this.turns.size>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
    if(previous&&turn<previous.latest)fail('STALE_TURN','The user turn is older than the current turn',409);
    if(previous?.stoppedAt!==null&&previous?.stoppedAt!==undefined&&turn<=previous.stoppedAt)fail('SESSION_STOPPED','The stopped turn cannot be reopened',409);
    if(previous&&turn===previous.latest&&previous.stoppedAt===null)return;
    this.turns.set(sessionId,{latest:turn,stoppedAt:null});try{this.saveSessionStops();}catch(error){if(previous)this.turns.set(sessionId,previous);else this.turns.delete(sessionId);throw error;}
  }
  ensureCurrentTurn(sessionId,turn){
    this.ensureSessionOpen(sessionId);
    const state=this.turns.get(sessionId);
    if(!state||!Number.isSafeInteger(turn)||turn<1||turn!==state.latest)fail('STALE_TURN','Search must belong to the current explicit user turn',409);
  }
  propose({productionId=null,sessionId,queries,engine='duckduckgo',purpose,turn}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    if(productionId!==null)text(productionId,'productionId',100);text(sessionId,'sessionId',150);text(purpose,'purpose',500);
    if(turn!==undefined)this.ensureCurrentTurn(sessionId,turn);else this.ensureSessionOpen(sessionId);
    if(engine!=='duckduckgo')fail('ENGINE_NOT_ALLOWED','Only the explicitly configured DuckDuckGo engine is available');
    queries=queryList(queries);
    const proposal={kind:'queries',productionId,sessionId,queries,engine,purpose};
    const record={schema:1,id:randomUUID(),...proposal,proposalHash:hash(proposal),phase:'awaiting_approval',createdAt:now(),updatedAt:now(),approvedAt:null,approval:null,items:queries.map(query=>({query,state:'unsent',sentAt:null,completedAt:null,results:[]})),error:null};
    this.save(record);return clone(record);
  }
  proposePageReads({productionId=null,sessionId,sourceProposalId,urls,purpose,turn}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    if(productionId!==null)text(productionId,'productionId',100);text(sessionId,'sessionId',150);
    if(turn!==undefined)this.ensureCurrentTurn(sessionId,turn);else this.ensureSessionOpen(sessionId);
    text(purpose,'purpose',500);
    const source=this.owned(sourceProposalId,sessionId);
    if(source.kind!=='queries'||source.phase!=='completed'||source.productionId!==productionId)fail('SOURCE_NOT_COMPLETED','Page reads require a completed search from the same session and production scope',409);
    if(!Array.isArray(urls)||urls.length<1||urls.length>3||new Set(urls).size!==urls.length)fail('INVALID_URLS','Provide one to three distinct search-result URLs');
    const returned=new Set(source.items.flatMap(item=>item.results.map(result=>result.url)));
    for(const url of urls){if(!returned.has(url))fail('URL_NOT_RETURNED','Only exact URLs returned by the approved search can be proposed',403);pageUrl(url);}
    const proposal={kind:'pages',productionId,sessionId,sourceProposalId,urls:clone(urls),engine:'website-fetch',purpose};
    const record={schema:1,id:randomUUID(),...proposal,proposalHash:hash(proposal),phase:'awaiting_approval',createdAt:now(),updatedAt:now(),approvedAt:null,approval:null,items:urls.map(url=>({url,state:'unsent',sentAt:null,completedAt:null,results:[]})),error:null};
    this.save(record);return clone(record);
  }
  list({productionId,sessionId}={}){return [...this.records.values()].filter(r=>(!productionId||r.productionId===productionId)&&(!sessionId||r.sessionId===sessionId)).map(clone);}
  status(id,{sessionId}={}){return clone(sessionId===undefined?this.get(id):this.owned(id,sessionId));}
  approve(id,{queries,urls,engine,actor,proposalHash}={}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    const record=this.get(id);this.ensureSessionOpen(record.sessionId);if(record.phase!=='awaiting_approval')fail('NOT_AWAITING_APPROVAL','This proposal cannot be approved',409);
    if(actor!=='user')fail('USER_APPROVAL_REQUIRED','Only an authenticated user approval is accepted',403);
    if((record.kind==='pages'?JSON.stringify(urls)!==JSON.stringify(record.urls):JSON.stringify(queries)!==JSON.stringify(record.queries))||engine!==record.engine||(proposalHash!==undefined&&proposalHash!==record.proposalHash))fail('APPROVAL_MISMATCH','The displayed query/URL set or engine differs from the proposal',409);
    record.approvedAt=now();record.approval={actor,proposalHash:record.proposalHash,...(record.kind==='pages'?{urls:clone(urls)}:{queries:clone(queries)}),engine,pageReadsAllowed:record.kind==='pages'};record.phase='approved';this.save(record);return clone(record);
  }
  cancel(id){const record=this.get(id);if(terminal.has(record.phase))return clone(record);record.phase='cancelled';record.cancelledAt=now();this.active.get(id)?.abort(new Error('Search cancelled'));try{this.save(record);}catch(error){this.persistenceFault=true;throw error;}return clone(record);}
  cancelProduction(productionId){return this.list({productionId}).map(r=>this.cancel(r.id));}
  cancelTurn(sessionId,turn){
    text(sessionId,'sessionId',150);
    if(!Number.isSafeInteger(turn)||turn<1||this.turns.get(sessionId)?.latest!==turn)fail('STALE_TURN','Only the current user turn can be stopped',409);
    return this.cancelSession(sessionId,turn);
  }
  validateStopTurn(sessionId,turn){
    text(sessionId,'sessionId',150);
    if(turn!==undefined&&(!Number.isSafeInteger(turn)||turn<1))fail('INVALID_TURN','A valid stopped turn is required');
    if(turn!==undefined&&turn<(this.turns.get(sessionId)?.latest??0))fail('STALE_TURN','The stop request refers to an older conversation turn',409);
  }
  cancelSession(sessionId,turn){
    this.validateStopTurn(sessionId,turn);
    const previous=this.turns.get(sessionId);if(!previous&&this.turns.size>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
    const latest=Math.max(previous?.latest??0,turn??0);
    // Without either a registered or observed turn, never infer a safe resume.
    const stoppedAt=Math.max(previous?.stoppedAt??0,latest||Number.MAX_SAFE_INTEGER);
    this.turns.set(sessionId,{latest,stoppedAt});
    let failure;const cancelled=[];
    try{this.saveSessionStops();}catch(error){this.persistenceFault=true;failure=error;}
    // Even if persistence failed, stop all owned outbound work immediately.
    for(const record of this.list({sessionId}))try{cancelled.push(this.cancel(record.id));}catch(error){failure??=error;}
    if(failure)throw failure;
    return cancelled;
  }
  async run(id,{sessionId,signal}={}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    const record=this.owned(id,sessionId);
    this.ensureSessionOpen(sessionId);
    if(record.phase!=='approved'||!record.approval||record.items.some(x=>x.state!=='unsent'))fail('SEARCH_NOT_RUNNABLE','Only an unused, explicitly approved search grant can run',409);
    if(signal?.aborted){this.cancel(id);return clone(record);}
    const controller=new AbortController();const abort=()=>this.cancel(id);signal?.addEventListener('abort',abort,{once:true});this.active.set(id,controller);record.phase='running';this.save(record);
    try{
      for(const item of record.items){
        if(record.phase==='cancelled'||controller.signal.aborted)break;
        // Commit intent before the first byte is sent. Uncertainty is never treated as permission to retry.
        item.state='sent';item.sentAt=now();this.save(record);
        const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]);
        if(record.kind==='pages'){
          const page=await this.pageReader(item.url,{signal:requestSignal});item.results=[{...page,engine:'website-fetch'}];
        }else{
          const url=new URL('/search',this.baseUrl);url.searchParams.set('q',item.query);url.searchParams.set('format','json');url.searchParams.set('engines',record.engine);url.searchParams.set('categories','general');url.searchParams.set('max_results',String(this.maxResults));url.searchParams.set('include_raw_content','0');
          const response=await this.fetchImpl(url,{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:requestSignal});
          const body=await boundedJson(response);
          if(!Array.isArray(body.results))throw new SearchError('UPSTREAM_CONTRACT','RustXNG results are missing',502);
          if(Array.isArray(body.unresponsive_engines)&&body.unresponsive_engines.length)throw new SearchError('UPSTREAM_ENGINE_FAILURE','The approved engine reported a failure',502);
          if(body.results.some(r=>r.engine!==record.engine||!Array.isArray(r.engines)||r.engines.some(e=>e!==record.engine)))throw new SearchError('UPSTREAM_ENGINE_MISMATCH','RustXNG returned an unapproved or unknown engine',502);
          item.results=body.results.slice(0,this.maxResults).flatMap(result=>{const url=publicResultUrl(result.url);return url?[{title:String(result.title??'').slice(0,240),url,content:String(result.content??'').slice(0,700),engine:record.engine,retrievedAt:now()}]:[];});
        }
        item.state='completed';item.completedAt=now();item.resultCount=item.results.length;this.save(record);
      }
      if(record.phase!=='cancelled'){record.phase='completed';record.completedAt=now();this.save(record);}
    }catch(error){
      for(const item of record.items)if(item.state==='sent')item.state='uncertain';
      if(record.phase!=='cancelled'){record.phase='needs_attention';record.error={code:error instanceof SearchError?error.code:(error?.name==='TimeoutError'?'SEARCH_TIMEOUT':'SEARCH_UNCERTAIN'),message:'Search did not finish with a verified response. No automatic retry or provider fallback was made.'};}
      this.save(record);
    }finally{signal?.removeEventListener('abort',abort);this.active.delete(id);}
    return clone(record);
  }
}
