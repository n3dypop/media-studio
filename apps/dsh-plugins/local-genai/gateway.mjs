import { randomUUID } from 'node:crypto';
import { loadConfiguration } from './index.mjs';
import { loadDshLlmBindings, desktopPackagedRuntimeOption, withDesktopPackagedRuntime } from './runtime.mjs';
import {createRuntimeConfig,runtimeRootOf} from '../shared/plugin-config.mjs';
import {controllerSessionMode,controllerSessionId,withControllerSessionNamespace} from '../shared/controller-session.mjs';
import {pinSearchStopDatabase} from './search-stop-db.mjs';
import {resetScopeFeature,observeScopeFeature} from './scope-feature.mjs';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';

export const name = 'local-genai-gateway';
export const inject = ['llm','sessions','sessionPersistence'];
export const Config=withControllerSessionNamespace(withDesktopPackagedRuntime(createRuntimeConfig({allowWorkspaceRoot:true,allowUnknown:true})),{allowUnknown:true});

const desktopRouteRef = 'LOCAL_GENAI_DSH_TOKEN';
const desktopRouteMarker = 'media-studio-local-route';

function enableDesktopRoute(ctx) {
  ctx.inject(['credentials'], async host => {
    try {
      // DSH requires a populated reference to list the configured model. The
      // actual bearer stays in the gateway. Discovery can only see the marker.
      if (!await host.credentials.resolve(desktopRouteRef)) {
        await host.credentials.set(desktopRouteRef, desktopRouteMarker);
      }
    } catch {
      host.logger.warn('Media Studio could not register the local Strata model reference in Desktop.');
    }
  });
}

export class CoreScopeError extends Error {
  constructor(message, { uncertain = false, requestId = null } = {}) {
    super(message);
    this.name = 'CoreScopeError';
    this.uncertain = uncertain;
    this.requestId = requestId;
  }
}

// This lock binds one DSH iterator to the proxy's current session. It never
// owns GPU resources: only the controller's actual inference HTTP stream does.
function createAdmission() {
  let locked = false;
  let closed = null;
  const waiting = [];
  const release = () => {
    const entry = waiting.shift();
    if (!entry) { locked = false; return; }
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(release);
  };
  return {
    acquire(signal) {
      if (closed) return Promise.reject(closed);
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!locked) { locked = true; return Promise.resolve(release); }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, abort: null };
        entry.abort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          signal.removeEventListener('abort', entry.abort);
          reject(signal.reason);
        };
        waiting.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
      });
    },
    close(error) {
      closed ??= error;
      for (const entry of waiting.splice(0)) {
        entry.signal?.removeEventListener('abort', entry.abort);
        entry.reject(closed);
      }
    },
  };
}

async function readReceipt(response, signal) {
  if (!response.body) throw new Error('Missing scope receipt.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('Scope receipt too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function createGateway(ctx, config, dependencies = {}) {
  const desktopPackagedRuntime = desktopPackagedRuntimeOption(config);
  const sessionMode = controllerSessionMode(config);
  const settings = await (dependencies.loadConfiguration ?? loadConfiguration)(config);
  const { LlmError, IMAGE_OFFLOAD_REQUIRED_CODE } = await (dependencies.loadDshLlmBindings??loadDshLlmBindings)({workspaceRoot:runtimeRootOf(config,{allowWorkspaceRoot:true}),desktopPackagedRuntime});
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const makeRequestId = dependencies.randomUUID ?? randomUUID;
  const admission = createAdmission();
  const running = new Set();
  let closed = false;
  let closedReason = null;
  let disposal;
  let headerScope = null;
  const observedSessions = new Set();
  const ownerSessions=new Set(),registeredTurns=new Map(),userTurns=new Map(),ownerHostId=randomUUID();
  let ownerContext=null,searchOpenGateway=null,setSearchOwnerStatus=()=>{},clearSearchOwnerStatus=()=>{},isManagedAgent=()=>false;
  {
    try{
      const [{observeOwnHostBirth},{pinTurnOwnerDatabase},{createTurnOwnerLifecycle},status,roleScope]=await Promise.all([import('./host-birth.mjs'),import('./turn-owner.mjs'),import('./turn-owner-lifecycle.mjs'),import('./search-owner-status.mjs'),import('./role-scope.mjs')]);
      setSearchOwnerStatus=status.setSearchOwnerStatus;clearSearchOwnerStatus=status.clearSearchOwnerStatus;
      isManagedAgent=dependencies.isManagedAgent??roleScope.isManagedAgent;
      const root=await realpath(runtimeRootOf(config,{allowWorkspaceRoot:true}));let birth,owner;
      if(dependencies.createOwnerContext){({birth,owner}=await dependencies.createOwnerContext(root));}
      else{const path=await realpath(resolve(root,'config/controller.json')),inside=relative(root,path),info=await stat(path);if(!inside||inside==='..'||inside.startsWith('../')||inside.startsWith('..\\')||isAbsolute(inside)||!info.isFile()||info.size>1024*1024)throw Error('Owner probe configuration is unavailable');const file=JSON.parse(await readFile(path,'utf8'));birth=await (dependencies.observeOwnHostBirth??observeOwnHostBirth)(root,file.nativeProbe);owner=(dependencies.pinTurnOwnerDatabase??pinTurnOwnerDatabase)(root);}
      const lifecycle=createTurnOwnerLifecycle({owner,mapSessionId:id=>controllerSessionId(id,sessionMode),hostId:ownerHostId,sessions:ctx.sessions,persistence:ctx.sessionPersistence});
      const {createSearchOpenGateway}=await import('./search-open-gateway.mjs');searchOpenGateway=await createSearchOpenGateway({token:settings.token,hostId:ownerHostId,isOpen:status.isSearchOwnerOpen});
      ctx.on('session/event',(session,event)=>{if(event?.type!=='turn/end')return;const id=controllerSessionId(session?.id??'',sessionMode),turn=event.data?.turn;if(typeof id!=='string'||!Number.isSafeInteger(turn)||turn<1)return;setSearchOwnerStatus(id,turn,'ended');void lifecycle.end(session,event).then(confirmed=>{if(confirmed)setSearchOwnerStatus(id,turn,'completed');}).catch(()=>setSearchOwnerStatus(id,turn,'blocked'));},{global:true});
      ownerContext={birth,owner,lifecycle};
    }catch{ownerContext=null;if(searchOpenGateway){await searchOpenGateway.close();searchOpenGateway=null;}/* Search stays closed; local inference and image work can continue. */}
  }

  // Header preparation runs synchronously for the exact pi-ai provider call.
  // The unguessable Controller scope is retained only while that call owns the
  // serialized gateway; never attach it to a different provider or origin.
  ctx.on('llm-pi-ai/request-headers',(request,_headers,next)=>{
    const headers=next();
    if(request?.provider!=='local-strata')return headers;
    let actual;try{actual=new URL(request.baseURL);}catch{throw new CoreScopeError('Managed inference routing could not be verified.');}
    const sessionId=controllerSessionId(request.sessionId??'__auxiliary__',sessionMode);
    if(request.model!=='strata-core'||actual.origin!==settings.controllerUrl||!/^\/v1\/?$/.test(actual.pathname)||actual.search||actual.hash||actual.username||actual.password||!headerScope||headerScope.sessionId!==sessionId)throw new CoreScopeError('Managed inference scope could not be verified.');
    if (desktopPackagedRuntime && sessionMode === 'desktop') headers.set('Authorization', `Bearer ${settings.token}`);
    headers.set('X-DSH-Session',headerScope.sessionId);
    headers.set('X-DSH-Scope',headerScope.id);
    observeScopeFeature(headerScope.sessionId,headerScope.id);
    observedSessions.add(headerScope.sessionId);
    return headers;
  },{global:true,prepend:true});

  function close(error) {
    closed = true;
    closedReason ??= error;
    admission.close(error);
  }
  async function post(path, body, sessionId, callerSignal, parseReceipt = false) {
    const deadline = AbortSignal.timeout(15000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    try {
      const response = await fetchImpl(settings.controllerUrl + path, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${settings.token}`, 'X-DSH-Session': sessionId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const uncertain = response.status >= 500;
        const detail = uncertain ? ' Reconcile the Controller state before retrying.' : '';
        throw new CoreScopeError(`The core scope request was rejected (HTTP ${response.status}).${detail}`, { uncertain, requestId: body.requestId ?? null });
      }
      if (parseReceipt) return await readReceipt(response, signal);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      // Never echo a server body, token, URL, fetch error, or nested cause.
      if (error instanceof CoreScopeError) throw error;
      if (error?.cause?.code === 'ECONNREFUSED' && path === '/api/core-scope/start') {
        throw new CoreScopeError('Media Studio Controller is stopped. Start it in Media Studio service settings, then retry this request.');
      }
      throw new CoreScopeError('The core scope response is unknown; managed inference is closed. Reconcile the controller state before reopening it.', { uncertain: true, requestId: body.requestId ?? null });
    }
  }
  function stream(options, next) {
    if (options.provider !== 'local-strata' || options.model !== 'strata-core') return next();
    const requestId = makeRequestId();
    return (async function* managedStream() {
      if (closed) throw new CoreScopeError('Managed inference is closed; no new scope was sent.');
      const sessionId = controllerSessionId(options.sessionId ?? '__auxiliary__',sessionMode);
      if (typeof sessionId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw new CoreScopeError('A valid DSH session identity is required.');
      options.signal?.throwIfAborted();
      // The controller admits eight image occurrences across the full request,
      // while DSH's byte budget alone can retain more small images. Ask DSH's
      // durable offload projection to omit the oldest excess occurrences. Keep
      // all attachment objects and the newest eight images; never trim history
      // privately or send the over-limit request to the inference endpoint.
      const imageCount = (options.messages ?? []).reduce((count, message) => count + (
        ['user', 'tool'].includes(message.role) && Array.isArray(message.content)
          ? message.content.filter(block => block.type === 'image' && block.offloaded !== true).length : 0
      ), 0);
      if (imageCount > 8) {
        const error = new LlmError('The managed image route retains at most eight images per request; offload the oldest excess occurrences.', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: imageCount - 8 });
        // A middleware throw bypasses agent/request-error in this pinned DSH.
        // Its recovery seam consumes a terminal failure chunk instead.
        yield { type: 'finish', reason: { kind: 'error', failure: error.failure } };
        return;
      }
      let complete;
      const completion = new Promise(resolve => { complete = resolve; });
      running.add(completion);
      let release;
      try {
        release = await admission.acquire(options.signal);
        if (closed) throw new CoreScopeError('Managed inference is closed; no new scope was sent.');
        options.signal?.throwIfAborted();
        let scope;
        try {
          const receipt = await post('/api/core-scope/start', { requestId }, sessionId, options.signal, true);
          scope = receipt?.scope;
          if (!scope || typeof scope.id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(scope.id) || scope.sessionId !== sessionId) {
            throw new CoreScopeError('The core scope receipt is incomplete; managed inference is closed. Do not repeat the start request.', { uncertain: true, requestId });
          }
        } catch (error) { if (error.uncertain) close(error); throw error; }
        let ownsHeaderScope=false;
        try {
          if(headerScope){const error=new CoreScopeError('A managed inference scope is already active.');close(error);throw error;}
          headerScope={id:scope.id,sessionId};
          ownsHeaderScope=true;
          resetScopeFeature(sessionId);
          options.signal?.throwIfAborted();
          // DSH owns the (possibly frozen) options and upstream signal. Delegate
          // return/error too, so upstream cleanup finishes before scope/end.
          yield* next();
        } finally {
          if(ownsHeaderScope)headerScope=null;
          try {
            // A caller abort or plugin disposal cannot abort scope cleanup.
            await post('/api/core-scope/end', { id: scope.id }, sessionId);
          } catch (error) { close(error); throw error; }
        }
      } finally {
        release?.();
        running.delete(completion);
        complete();
      }
    })();
  }
  // This is a durable agent turn boundary, not an llm/stream boundary: one
  // user turn may contain multiple model calls and retries. Only an actual
  // user message may reopen conversation-scoped search after a stop.
  ctx.on('agent/pre-step', async ({agent,turn,step,messages,signal},next)=>{
    let cancellation,stopFailure;
    if(!isManagedAgent(agent))return next();
    const route=agent?.options;
    if(closed&&route?.provider==='local-strata'&&route?.model==='strata-core')throw closedReason??new CoreScopeError('Managed inference is closed; no operation was sent.',{uncertain:true});
    const id=agent?.session?.id,events=agent?.session?.snapshotEvents?.(),recorded=Array.isArray(events)?events.findLast(event=>event.type==='turn/start')?.data?.turn:null;
    const controllerId=typeof id==='string'?controllerSessionId(id,sessionMode):null;
    if(typeof controllerId==='string'&&Number.isSafeInteger(turn)&&turn>0&&recorded===turn&&step===1&&Array.isArray(messages)&&messages.some(message=>message?.source?.kind==='user')&&(userTurns.get(controllerId)??0)<turn)userTurns.set(controllerId,turn);
    // The pinned Desktop Host can expose an initial default model here even
    // though it switches to the managed model during the same first step.
    // The owner records the user turn before that step so a
    // search tool cannot run before ownership is registered.
    if((step===1||(route?.provider==='local-strata'&&route?.model==='strata-core'))&&typeof controllerId==='string'&&Number.isSafeInteger(turn)&&turn>0&&recorded===turn&&userTurns.get(controllerId)===turn){
        if((registeredTurns.get(controllerId)??0)<turn){registeredTurns.set(controllerId,turn);
        let ownerReady=false;
        ownerSessions.add(controllerId);setSearchOwnerStatus(controllerId,turn,'pending');try{if(!ownerContext)throw Error('Search owner unavailable');ownerContext.owner.activate({sessionId:controllerId,hostId:ownerHostId,identity:ownerContext.birth});if(ownerContext.owner.needsLegacyAttestation({sessionId:controllerId,hostId:ownerHostId,turn})){await ownerContext.owner.attestLegacy({session:agent.session,sessions:ctx.sessions,persistence:ctx.sessionPersistence,mapSessionId:value=>controllerSessionId(value,sessionMode),turn:turn-1,hostId:ownerHostId});throw Error('Legacy search needs maintenance approval');}await ownerContext.lifecycle.begin(agent.session,turn);if(!searchOpenGateway)throw Error('Search gateway unavailable');const receipt=await post('/api/search-proposals/gateway-register',{hostId:ownerHostId,port:searchOpenGateway.port},controllerId,undefined,true);if(receipt?.sessionId!==controllerId||receipt?.hostId!==ownerHostId||receipt?.registered!==true)throw Error('Search gateway registration differs');ownerReady=true;}catch{setSearchOwnerStatus(controllerId,turn,'blocked');}
        if(ownerReady){
        let stopGuard;
        {
          try{stopGuard=(dependencies.pinSearchStopDatabase??pinSearchStopDatabase)(runtimeRootOf(config,{allowWorkspaceRoot:true}));}
          catch{const error=new CoreScopeError('Search stop state cannot be verified; managed inference is closed. Previously claimed external requests may still have been sent.',{uncertain:true});close(error);throw error;}
        }
        // The registration must settle even when the user stops while it is in
        // flight; otherwise a late registration could reopen the stopped turn.
        const registration=post('/api/search-proposals/user-turn',{turn,hostId:ownerHostId},controllerId,undefined,true).then(receipt=>{
          if(receipt?.sessionId!==controllerId||receipt?.turn!==turn)throw new Error('Search turn receipt differs.');
          setSearchOwnerStatus(controllerId,turn,signal?.aborted?'blocked':'active');
        });
        const onAbort=()=>{
          if(cancellation)return;
          setSearchOwnerStatus(controllerId,turn,'blocked');
          if(stopGuard)try{stopGuard.stop(controllerId,turn);}catch{
            stopFailure=new CoreScopeError('The search stop could not be durably recorded. Keep search closed; an external request may already have been sent.',{uncertain:true});close(stopFailure);
            // The DSH session-controller relays agent/error as a live
            // api-session/error event even after pre-step returned. This is
            // a notification only: it is not durable delivery evidence.
            try{ctx.emit?.('agent/error',{agent,turn,step,error:stopFailure});}catch{/* The persistent recovery boundary remains unresolved. */}
          }
          // Even a lost or malformed registration receipt may have committed;
          // cancel the exact turn once after the local attempt settles.
          cancellation=registration.then(()=>{},()=>{}).then(()=>post('/api/search-proposals/cancel-turn',{turn},controllerId,undefined)).catch(()=>{});
          running.add(cancellation);void cancellation.finally(()=>running.delete(cancellation));
        };
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        try{await registration;}
        catch{setSearchOwnerStatus(controllerId,turn,'blocked');/* Search itself fails closed without a matching turn. */}
        if(signal?.aborted){onAbort();await cancellation;if(stopFailure)throw stopFailure;signal.throwIfAborted();}
        }
        }
    }
    try{const result=await next();if(signal?.aborted&&cancellation)await cancellation;if(stopFailure)throw stopFailure;return result;}
    catch(error){if(signal?.aborted&&cancellation)await cancellation;if(stopFailure)throw stopFailure;throw error;}
  },{global:true,prepend:true});
  ctx.on('llm/stream', stream, { global: true, prepend: true });
  return {
    stream,
    dispose() {
      if (!disposal) {
        close(new CoreScopeError('The core gateway is closing; no new scope was sent.'));
        for(const sessionId of observedSessions)resetScopeFeature(sessionId);
        observedSessions.clear();
        for(const sessionId of ownerSessions)clearSearchOwnerStatus(sessionId);
        ownerSessions.clear();
        registeredTurns.clear();
        userTurns.clear();
        // Do not call iterator.return(), forge an upstream signal, or end a
        // still-running scope. Cordis waits for this disposer before unload.
        disposal = Promise.allSettled([...running,...(searchOpenGateway?[searchOpenGateway.close()]:[])]).then(() => {});
      }
      return disposal;
    },
  };
}

export async function apply(ctx, config) {
  const gateway = await createGateway(ctx, config);
  if (desktopPackagedRuntimeOption(config) && controllerSessionMode(config) === 'desktop') enableDesktopRoute(ctx);
  return () => gateway.dispose();
}
