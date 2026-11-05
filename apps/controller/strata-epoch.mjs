import {readFile} from 'node:fs/promises';
import {resolve,sep,win32} from 'node:path';
import {probeWindowsEpoch,validateEpochEvidence} from './epoch.mjs';

// Pin both the OS process epoch and Strata's unique ready-file instance. The API's
// second-resolution started field alone cannot distinguish two rapid restarts.
export function createStrataEpochVerifier({root,expectedExecutable,baseUrl,expectedIdentity=null,probe=probeWindowsEpoch,read=readFile}) {
  const address=new URL(baseUrl);
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.username||address.password||address.search||address.hash||address.pathname!=='/')throw new TypeError('Strata identity requires a loopback HTTP origin');
  if(typeof expectedExecutable!=='string'||!win32.isAbsolute(expectedExecutable)||/[\u0000-\u001f]/.test(expectedExecutable))throw new TypeError('Strata identity requires an absolute executable path');
  const executable=win32.normalize(expectedExecutable).toLowerCase(),port=Number(address.port||80);
  const snapshotOf=(identity,evidence,instanceId,started)=>{
    if(typeof instanceId!=='string'||!instanceId||instanceId.length>200||!Number.isSafeInteger(started)||started<1)throw new Error('Strataの実行世代が不正です。');
    const actual=validateEpochEvidence(identity,evidence);
    // The packaged Strata interpreter is the API server itself; unlike a Comfy
    // venv redirector, a different child listener is not an authorized epoch.
    if(actual.listenerPid!==actual.pid)throw new Error('Strataの待受プロセスが管理PID本人ではありません。');
    return {...actual,port,instanceId,started};
  };
  let pinned=null;
  if(expectedIdentity!==null) {
    const previous=expectedIdentity;
    if(previous.url!==baseUrl||previous.port!==port||typeof previous.executable!=='string'||win32.normalize(previous.executable).toLowerCase()!==executable)throw new Error('保存済みStrataの配置が現在の設定と一致しません。');
    pinned=snapshotOf({pid:previous.pid,startTimeUtcTicks:previous.startTimeUtcTicks,executable,url:baseUrl},
      {managed:{pid:previous.pid,startTimeUtcTicks:previous.startTimeUtcTicks,executable:previous.executable},listener:{pid:previous.listenerPid,startTimeUtcTicks:previous.listenerStartTimeUtcTicks,executable:previous.listenerExecutable}},previous.instanceId,previous.started);
  }
  const recordPath=resolve(root,'runtime/Strata.json');
  const verify=async()=>{
    const raw=await read(recordPath,'utf8'),record=JSON.parse(raw);
    if(record.service!=='Strata'||record.workspace!==root||record.url!==baseUrl||!record.ready||!Number.isSafeInteger(record.started)||record.started<1||typeof record.instanceId!=='string'||!record.instanceId)throw new Error('Strataの管理記録が一致しません。');
    if(typeof record.executable!=='string')throw new Error('Strataの実行ファイルが不正です。');
    if(win32.normalize(record.executable).toLowerCase()!==executable)throw new Error('Strataの実行ファイルが一致しません。');
    const readyPath=resolve(record.readyPath);
    if(!readyPath.startsWith(resolve(root,'data/strata/runtime')+sep))throw new Error('Strataのready記録の配置が不正です。');
    const ready=JSON.parse(await read(readyPath,'utf8'));
    if(ready.pid!==record.processId||ready.instance_id!==record.instanceId||ready.api_url!==baseUrl||ready.api_state!=='ready')throw new Error('Strataのready世代が一致しません。');
    const identity={pid:record.processId,startTimeUtcTicks:record.startTimeUtcTicks,executable,url:baseUrl,port};
    const snapshot=snapshotOf(identity,await probe({pid:identity.pid,port}),record.instanceId,record.started);
    if(raw!==await read(recordPath,'utf8'))throw new Error('照合中にStrataの管理記録が変わりました。');
    if(pinned&&JSON.stringify(snapshot)!==JSON.stringify(pinned))throw new Error('Strataの管理プロセスが交代しました。使用権を照合してください。');
    pinned=snapshot;return structuredClone(snapshot);
  };
  verify.identity=()=>pinned?structuredClone(pinned):null;
  return verify;
}
