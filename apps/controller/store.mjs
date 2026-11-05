import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {MODEL_PROFILES} from './workflows.mjs';
import {mediaIntent,assertModeProfile,assertActiveProfile,MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS} from './media-modes.mjs';

export const terminalPhases = new Set(['completed', 'failed', 'cancelled']);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function normalizeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '入力形式が不正です。');
  assertActiveProfile(input.modelProfile);
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw new ApiError(400, 'requestIdが必要です。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 6000) throw new ApiError(400, 'プロンプトを1〜6000文字で入力してください。');
  if (input.negativePrompt !== undefined && (typeof input.negativePrompt !== 'string' || input.negativePrompt.length > 3000)) throw new ApiError(400, '除外指定は3000文字以内です。');
  const seed = input.seed === undefined ? '20261102' : input.seed;
  if (typeof seed !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(seed) || BigInt(seed) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(400, 'seedは0〜9007199254740991の整数文字列です。');
  const width = input.width ?? 768, height = input.height ?? 1024, steps = input.steps ?? 25;
  const media=mediaIntent(input),video=media.mode==='video',upscale=media.mode==='upscale';
  if(input.modelProfile)assertModeProfile(media.mode,input.modelProfile);
  const mossOfficial=MOSS_OFFICIAL_IDS.includes(input.modelProfile),qwenOfficial=QWEN21_OFFICIAL_IDS.includes(input.modelProfile),official=mossOfficial||qwenOfficial;
  const min=video?256:upscale?64:qwenOfficial?32:mossOfficial?256:512,max=video?832:upscale||official?4096:1536,multiple=upscale?1:mossOfficial?16:32,maxPixels=video?500000:upscale||qwenOfficial?8388608:mossOfficial?4194304:1500000;
  if (![width, height].every(n => Number.isInteger(n) && n >= min && n <= max && n % multiple === 0) || width * height > maxPixels) throw new ApiError(400, '出力寸法が選択した制作モードの範囲外です。');
  if (!Number.isInteger(steps) || steps < 1 || steps > (video?30:official?10000:40)) throw new ApiError(400, 'stepsが制作モードの範囲外です。');
  if(input.modelProfile!==undefined&&!Object.hasOwn(MODEL_PROFILES,input.modelProfile))throw new ApiError(400,'指定した画像モデルは登録されていません。');
  const options={};
  if(input.mode!==undefined||input.inputAssetId!==undefined||input.inputAssetIds!==undefined||input.referenceAssetIds!==undefined)Object.assign(options,media);
  if(['i2i','edit'].includes(media.mode)&&!official){const denoise=input.denoise??0.65;if(typeof denoise!=='number'||!Number.isFinite(denoise)||denoise<=0||denoise>=1)throw new ApiError(400,'画像入力のdenoiseは0より大きく1未満です。');options.denoise=denoise;}
  else if(input.denoise!==undefined)throw new ApiError(400,'denoiseはi2iまたはeditで指定してください。');
  if(video){const frames=input.frames??33,fps=input.fps??16;if(!Number.isInteger(frames)||frames<17||frames>49||frames%4!==1||!Number.isInteger(fps)||fps<8||fps>24)throw new ApiError(400,'動画のフレーム数またはfpsが範囲外です。');Object.assign(options,{frames,fps});}
  return { requestId: input.requestId, spec: { prompt: official?input.prompt:input.prompt.trim(), negativePrompt: official?(input.negativePrompt??''):(input.negativePrompt?.trim() ?? ''), seed, width, height, steps,...(input.modelProfile!==undefined?{modelProfile:input.modelProfile}:{}),...options } };
}

export class RunStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,phase TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL);`);
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('controllerId');
    this.controllerId = row?.value ?? randomUUID();
    if (!row) this.db.prepare('INSERT INTO meta VALUES (?,?)').run('controllerId', this.controllerId);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { const row = this.db.prepare('SELECT json FROM runs WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; }
  list() { return this.db.prepare('SELECT json FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => JSON.parse(row.json)); }
  active() { const row = this.db.prepare("SELECT json FROM runs WHERE phase NOT IN ('completed','failed','cancelled') ORDER BY rowid LIMIT 1").get(); return row ? JSON.parse(row.json) : null; }
  create(request, { decorate } = {}) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT json,payload_hash FROM runs WHERE request_id=?').get(request.requestId);
      const payloadHash = digest(request.spec);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ApiError(409, '同じrequestIdの内容を変更できません。');
        return { run: JSON.parse(existing.json), created: false };
      }
      assertActiveProfile(request.spec.modelProfile);
      if (this.active()) throw new ApiError(409, '処理中または確認が必要な生成があります。履歴を確認してください。');
      const now = new Date().toISOString();
      const run = { id: randomUUID(), requestId: request.requestId, controllerId: this.controllerId, promptId: null, phase: 'queued', spec: request.spec, specHash: payloadHash, createdAt: now, updatedAt: now, cancelRequested: false, artifacts: [], error: null, progress: null };
      if (decorate) Object.assign(run, decorate(run));
      this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(run.id, request.requestId, payloadHash, run.phase, JSON.stringify(run));
      this.event(run.id, 'created', { phase: run.phase, specHash: payloadHash });
      return { run, created: true };
    });
  }
  event(id, type, data) {
    this.db.prepare('INSERT INTO events (run_id,at,type,json) VALUES (?,?,?,?)').run(id, new Date().toISOString(), type, JSON.stringify(data));
  }
  update(id, patch, type = 'state') {
    return this.transaction(() => {
      const run = this.get(id);
      if (!run) throw new ApiError(404, '生成記録がありません。');
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      this.db.prepare('UPDATE runs SET phase=?,json=? WHERE id=?').run(run.phase, JSON.stringify(run), id);
      this.event(id, type, patch);
      return run;
    });
  }
  markLaunchFailure(owner) {
    return this.transaction(() => {
      const run=this.get(owner.id);
      // specHash can change when an integrated enhancer produces effectiveSpec;
      // it is not an owner identity. The request and controller IDs are stable.
      const keys=['id','requestId','controllerId','sessionId','productionId','kind'];
      if(!run||terminalPhases.has(run.phase)||keys.some(key=>run[key]!==owner[key])) return false;
      const patch={phase:'needs_attention',error:'Owned run launch or execution failed unexpectedly. Check the run and resources; failure handling did not retry or release resources.'};
      Object.assign(run,patch,{updatedAt:new Date().toISOString()});
      this.db.prepare('UPDATE runs SET phase=?,json=? WHERE id=?').run(run.phase,JSON.stringify(run),run.id);
      this.event(run.id,'deferred_launch_failed',patch);
      return true;
    });
  }
  cancel(id) {
    const run = this.get(id);
    if (!run) throw new ApiError(404, '生成記録がありません。');
    if (terminalPhases.has(run.phase) || run.cancelRequested) return run;
    return this.update(id, { cancelRequested: true, cancelRequestedAt: new Date().toISOString() }, 'cancel_requested');
  }
  events(id, after = 0) {
    return this.db.prepare('SELECT seq,at,type,json FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500').all(id, after).map(row => ({ seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.json) }));
  }
  close() { this.db.close(); }
}

