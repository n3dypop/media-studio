import { readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
if(process.env.MEDIA_STUDIO_HOME&&!isAbsolute(process.env.MEDIA_STUDIO_HOME))throw Error('MEDIA_STUDIO_HOME must be absolute');
const root=resolve(process.env.MEDIA_STUDIO_HOME||resolve(dirname(fileURLToPath(import.meta.url)),'../..'));
const config=JSON.parse(readFileSync(join(root,'config/controller.json'),'utf8'));
const token=readFileSync(join(root,'data/controller/auth-token'),'utf8').trim();
const [command,arg]=process.argv.slice(2);
let path='/api/status',method='GET',input;
if(command==='submit') {
  if(!arg) throw new Error('Usage: cli.mjs submit <request.json>');
  input=JSON.parse(readFileSync(resolve(arg),'utf8'));
  if(!input.requestId) throw new Error('request.json must include a stable requestId; do not retry an uncertain submission with a new ID.');
  path='/api/runs';method='POST';
} else if(command==='list') path='/api/runs';
else if(['get','cancel','reconcile','events'].includes(command)) {
  if(!/^[a-f0-9-]{36}$/.test(arg??'')) throw new Error('run ID is required');
  path=`/api/runs/${arg}${command==='get'?'':'/'+command}`;
  if(command==='cancel'||command==='reconcile') {method='POST';input={};}
} else if(command==='request-id') {console.log(randomUUID());process.exit(0);}
else if(command!=='status') throw new Error('Commands: status, list, submit <request.json>, get/cancel/reconcile/events <run-id>, request-id');
const response=await fetch(`http://127.0.0.1:${config.port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(15000)});
const result=await response.json();console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
