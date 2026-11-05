// Strata v0.2.9 / c62d5e3a15b40ea51c96aae9e8d36928965f53ab.
// Model lifecycle is an internal controller capability. Inference must hold a ResourceGate lease.
export class StrataError extends Error {
  constructor(message,{status=503,code='STRATA_UNAVAILABLE'}={}) { super(message);this.status=status;this.code=code; }
}
const abortSignal=(signal,timeoutMs)=>signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
const fail=(message,options)=>{throw new StrataError(message,options);};

export class StrataClient {
  constructor({baseUrl,model=null,timeoutMs=180000,token=null,expectedStarted=null,verifyIdentity=null}) {
    const url=new URL(baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||!['/','/v1','/v1/'].includes(url.pathname)) throw new TypeError('Strata requires a fixed loopback HTTP base URL');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000) throw new TypeError('Invalid Strata timeout');
    if(model!==null&&(typeof model!=='string'||!model.trim()||model.length>200)) throw new TypeError('Invalid Strata model');
    if(token!==null&&(typeof token!=='string'||!token||/[\r\n]/.test(token))) throw new TypeError('Invalid Strata authentication token');
    if(expectedStarted!==null&&(!Number.isSafeInteger(expectedStarted)||expectedStarted<1)) throw new TypeError('Invalid Strata server epoch');
    if(verifyIdentity!==null&&typeof verifyIdentity!=='function')throw new TypeError('Invalid Strata process verifier');
    Object.assign(this,{baseUrl:url.origin,model,timeoutMs,token,started:expectedStarted,verifyIdentity});
    this._identity=verifyIdentity?.identity?.()??null;
  }
  get identity(){return this._identity?structuredClone(this._identity):null;}
  get currentIdentity(){return this.identity;}
  async checkIdentity(signal){
    signal?.throwIfAborted();
    if(!this.verifyIdentity)return;
    let identity;
    try{identity=await this.verifyIdentity();}
    catch{fail('Strataの管理プロセスと待受ポートの一致を確認できません。',{code:'STRATA_IDENTITY_UNKNOWN'});}
    signal?.throwIfAborted();
    if(!identity||!Number.isSafeInteger(identity.started)||identity.started<1)fail('Strataの管理世代を確認できません。',{code:'STRATA_IDENTITY_UNKNOWN'});
    if(this.started!==null&&identity.started!==this.started)fail('Strataの管理世代が変わりました。',{code:'STRATA_EPOCH_CHANGED'});
    this.started=identity.started;this._identity=structuredClone(identity);
  }
  headers() { return {'Content-Type':'application/json',...(this.token?{Authorization:'Bearer '+this.token}:{})}; }
  async request(path,{method='GET',body,signal,timeoutMs=this.timeoutMs}={}) {
    signal?.throwIfAborted();
    await this.checkIdentity(signal);
    let response;
    try { response=await fetch(this.baseUrl+path,{method,headers:this.headers(),body:body===undefined?undefined:JSON.stringify(body),signal:abortSignal(signal,timeoutMs),redirect:'error'}); }
    catch(error) { if(signal?.aborted) throw signal.reason;fail('Strataへの接続または応答を確認できません。',{code:error.name==='TimeoutError'?'STRATA_TIMEOUT':'STRATA_UNAVAILABLE'}); }
    const reader=response.body?.getReader(),chunks=[];let size=0;
    try {
      if(reader) while(true) { const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)fail('Strataの管理応答が大きすぎます。',{code:'STRATA_INVALID_RESPONSE'});chunks.push(Buffer.from(value)); }
    } finally { if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();} }
    // A successful reply from a replacement process cannot authorize load/unload
    // completion, even if the API's second-resolution started value is identical.
    await this.checkIdentity(signal);
    let result;
    try { result=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('Strataの管理応答を読み取れません。',{code:'STRATA_INVALID_RESPONSE'}); }
    if(!response.ok) fail(response.status===409?'Strataに実行中または待機中の推論があります。':'Strataが管理操作を受け付けませんでした。',{status:response.status,code:response.status===409?'STRATA_BUSY':'STRATA_HTTP_ERROR'});
    return result;
  }
  validateStatus(result) {
    if(!result||result.service!=='strata'||typeof result.loaded!=='boolean'||typeof result.model!=='string'||!result.model||!Number.isSafeInteger(result.started)||result.started<1||!Number.isSafeInteger(result.activity?.in_flight)||result.activity.in_flight<0||typeof result.vision?.enabled!=='boolean'||typeof result.vision?.available!=='boolean') fail('Strataの状態応答が契約と一致しません。',{code:'STRATA_INVALID_RESPONSE'});
    if(this.model!==null&&result.model!==this.model) fail('Strataのモデルが設定と一致しません。',{code:'STRATA_MODEL_CHANGED'});
    if(this.started!==null&&result.started!==this.started) fail('Strataの実行世代が変わりました。資源の受け渡しを保留します。',{code:'STRATA_EPOCH_CHANGED'});
    if(this.started===null)this.started=result.started;
    if(this.model===null)this.model=result.model;
    return result;
  }
  async status({signal}={}) { return this.validateStatus(await this.request('/v1/status',{signal,timeoutMs:Math.min(this.timeoutMs,10000)})); }
  requireVision(result) {
    if(result.vision?.enabled!==true||result.vision?.available!==true||result.vision?.error!=null) fail('Strataの画像入力機能を確認できません。',{code:'STRATA_VISION_UNAVAILABLE'});
    return result;
  }
  async load({signal}={}) {
    const result=this.validateStatus(await this.request('/v1/load',{method:'POST',body:this.model?{model:this.model}:{},signal}));
    if(result.status!=='loaded'||!result.loaded) fail('Strataのロード完了を確認できません。',{code:'STRATA_LOAD_UNKNOWN'});
    return this.requireVision(result);
  }
  async unload({signal}={}) {
    // No wait=1: that means 300 seconds in Strata. The controller owns bounded draining.
    const result=this.validateStatus(await this.request('/v1/unload',{method:'POST',body:this.model?{model:this.model}:{},signal,timeoutMs:Math.min(this.timeoutMs,30000)}));
    if(!['unloaded','not loaded'].includes(result.status)||result.loaded||result.activity.in_flight!==0) fail('Strataのアンロード完了を確認できません。',{code:'STRATA_UNLOAD_UNKNOWN'});
    return result;
  }
  async forward(body,{signal}={}) {
    signal?.throwIfAborted();
    if(!body||typeof body!=='object'||Array.isArray(body)||!this.model) throw new TypeError('A ready model and OpenAI request object are required');
    if(body.strata_mcp===true) fail('Strata内のMCP自動実行はこの経路では無効です。',{status:400,code:'STRATA_TOOLS_DISABLED'});
    await this.checkIdentity(signal);
    // Preserve messages, data-URL images, tool calls, and SSE bytes. The caller validates
    // request size/allowed fields and retains the lease until this Response body closes.
    return fetch(this.baseUrl+'/v1/chat/completions',{method:'POST',headers:this.headers(),body:JSON.stringify({...body,model:this.model}),signal:abortSignal(signal,this.timeoutMs),redirect:'error'});
  }
}
