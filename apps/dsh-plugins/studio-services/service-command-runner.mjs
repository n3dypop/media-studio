import {spawn} from 'node:child_process';

// Launch scripts write product logs themselves. Piped stdio can be inherited
// by their long-lived service children and delay execFile's close callback
// after PowerShell has exited. No pipes are needed for a lifecycle result.
export function runServiceCommand(executable,args,{cwd,timeoutMs=210000,spawnProcess=spawn}={}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw TypeError('A positive command deadline is required');
  return new Promise((resolve,reject)=>{
    let child,timer,settled=false,spawned=false,timedOut=false;
    const failure=(uncertain=false)=>Object.assign(new Error('Managed lifecycle script did not complete successfully'),{uncertain});
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    try{child=spawnProcess(executable,args,{cwd,windowsHide:true,stdio:'ignore',shell:false});}
    catch{finish(failure());return;}
    child.once('spawn',()=>{spawned=true;});
    child.once('error',()=>finish(failure(timedOut||spawned)));
    child.once('exit',(code,signal)=>finish(timedOut?failure(true):code===0?null:failure(Boolean(signal))));
    timer=setTimeout(()=>{
      if(settled)return;
      timedOut=true;
      // This is only the PowerShell process launched above, never a service
      // PID, process group, or descendant tree. Keep service records intact.
      try{child.kill();}catch{}
      finish(failure(true));
    },timeoutMs);
  });
}
