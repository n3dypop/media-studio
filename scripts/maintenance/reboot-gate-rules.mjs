// The special case handled here is an idle Controller that failed startup after
// Windows restarted, because its persisted Strata epoch belonged to the old boot.
export function validateRebootGate({gate,bootTicks,retired,currentStrata,comfy,queue,active,serviceProcesses}) {
  const fail = message => { throw new Error(message); };
  if (!gate || gate.owner !== 'unknown' || gate.blocked !== true || gate.initialized !== false || gate.activeCore !== 0 || gate.generationRunId !== null || gate.error !== 'Strataの管理プロセスと待受ポートの一致を確認できません。') fail('Gate is not the known post-reboot identity-failure state.');
  const old = gate.strataIdentity;
  if (!old || old.pid !== old.listenerPid || old.startTimeUtcTicks !== old.listenerStartTimeUtcTicks || gate.strataStarted !== old.started || !/^[1-9]\d{16,18}$/.test(old.startTimeUtcTicks ?? '') || !/^[1-9]\d{16,18}$/.test(bootTicks ?? '') || BigInt(old.startTimeUtcTicks) >= BigInt(bootTicks)) fail('Old Strata epoch does not predate this Windows boot.');
  if (!retired || retired.length !== 2 || retired.some(x => !x || !Array.isArray(x.processes) || x.processes.length !== 1 || x.processes[0].pid !== old.pid || (x.processes[0].exists && (!/^[1-9]\d{16,18}$/.test(x.processes[0].startTimeUtcTicks ?? '') || BigInt(x.processes[0].startTimeUtcTicks) < BigInt(bootTicks))))) fail('Old Strata process retirement not proven twice.');
  if (!currentStrata || currentStrata.pid === old.pid && currentStrata.startTimeUtcTicks === old.startTimeUtcTicks || currentStrata.started === old.started || BigInt(currentStrata.startTimeUtcTicks) < BigInt(bootTicks) || currentStrata.loaded !== false || currentStrata.inFlight !== 0) fail('Current Strata is not a different idle unloaded epoch.');
  if (old.url !== currentStrata.url || old.port !== currentStrata.port || old.executable !== currentStrata.executable || old.listenerExecutable !== old.executable || !old.instanceId || old.instanceId === currentStrata.instanceId) fail('Old and current Strata installation or instance evidence differs.');
  if (!comfy || BigInt(comfy.startTimeUtcTicks) < BigInt(bootTicks) || !Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending) || queue.queue_running.length || queue.queue_pending.length) fail('Current managed ComfyUI is not idle.');
  if (active !== 0 || serviceProcesses !== 0) fail('A run, DSH, or Controller process is still active.');
  const {loaded,inFlight,...identity}=currentStrata;
  return {owner:'none',activeCore:0,blocked:false,generationRunId:null,error:null,initialized:true,strataStarted:identity.started,resources:null,strataIdentity:identity};
}

// Caller owns BEGIN IMMEDIATE and must roll back on any exception.
export function writeRecoveryInTransaction(db,initial,next,audit) {
  db.exec('CREATE TABLE IF NOT EXISTS maintenance_recoveries (id TEXT PRIMARY KEY, at TEXT NOT NULL, json TEXT NOT NULL)');
  db.prepare('INSERT INTO maintenance_recoveries(id,at,json) VALUES (?,?,?)').run(audit.id,audit.at,JSON.stringify(audit));
  const result=db.prepare("UPDATE meta SET value=? WHERE key='resourceGate' AND value=?").run(JSON.stringify(next),initial);
  if(result.changes!==1)throw Error('Gate changed while reconciling.');
}
