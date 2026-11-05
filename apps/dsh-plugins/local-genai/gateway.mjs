import { randomUUID } from 'node:crypto';
import { loadConfiguration } from './index.mjs';
import { loadDshLlmBindings, desktopPackagedRuntimeOption, withDesktopPackagedRuntime } from './runtime.mjs';
import {createRuntimeConfig,runtimeRootOf} from '../shared/plugin-config.mjs';
import {controllerSessionMode,controllerSessionId,withControllerSessionNamespace} from '../shared/controller-session.mjs';

export const name = 'local-genai-gateway';
export const inject = ['llm'];
export const Config=withControllerSessionNamespace(withDesktopPackagedRuntime(createRuntimeConfig({allowWorkspaceRoot:true,allowUnknown:true})),{allowUnknown:true});

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
  let disposal;

  function close(error) {
    closed = true;
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
        throw new CoreScopeError(`The core scope request was rejected (HTTP ${response.status}); managed inference is closed.`, { uncertain: response.status >= 500, requestId: body.requestId ?? null });
      }
      if (parseReceipt) return await readReceipt(response, signal);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      // Never echo a server body, token, URL, fetch error, or nested cause.
      if (error instanceof CoreScopeError) throw error;
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
        } catch (error) { close(error); throw error; }
        try {
          options.signal?.throwIfAborted();
          // DSH owns the (possibly frozen) options and upstream signal. Delegate
          // return/error too, so upstream cleanup finishes before scope/end.
          yield* next();
        } finally {
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
    const route=agent?.options;
    if(step===1&&route?.provider==='local-strata'&&route?.model==='strata-core'&&Array.isArray(messages)&&messages.some(message=>message?.source?.kind==='user')){
      const id=agent?.session?.id,events=agent?.session?.snapshotEvents?.();
      const recorded=Array.isArray(events)?events.findLast(event=>event.type==='turn/start')?.data?.turn:null;
      if(typeof id==='string'&&Number.isSafeInteger(turn)&&turn>0&&recorded===turn){
        const controllerId=controllerSessionId(id,sessionMode);
        // The registration must settle even when the user stops while it is in
        // flight; otherwise a late registration could reopen the stopped turn.
        const registration=post('/api/search-proposals/user-turn',{turn},controllerId,undefined,true).then(receipt=>{
          if(receipt?.sessionId!==controllerId||receipt?.turn!==turn)throw new Error('Search turn receipt differs.');
        });
        let cancellation;
        const onAbort=()=>{
          if(cancellation)return;
          // Even a lost or malformed registration receipt may have committed;
          // cancel the exact turn once after the local attempt settles.
          cancellation=registration.then(()=>{},()=>{}).then(()=>post('/api/search-proposals/cancel-turn',{turn},controllerId,undefined)).catch(()=>{});
          running.add(cancellation);void cancellation.finally(()=>running.delete(cancellation));
        };
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        try{await registration;}
        catch{/* Search itself fails closed without a matching turn. */}
        if(signal?.aborted){onAbort();await cancellation;signal.throwIfAborted();}
      }
    }
    return next();
  },{global:true,prepend:true});
  ctx.on('llm/stream', stream, { global: true, prepend: true });
  return {
    stream,
    dispose() {
      if (!disposal) {
        close(new CoreScopeError('The core gateway is closing; no new scope was sent.'));
        // Do not call iterator.return(), forge an upstream signal, or end a
        // still-running scope. Cordis waits for this disposer before unload.
        disposal = Promise.allSettled([...running]).then(() => {});
      }
      return disposal;
    },
  };
}

export async function apply(ctx, config) {
  const gateway = await createGateway(ctx, config);
  return () => gateway.dispose();
}
