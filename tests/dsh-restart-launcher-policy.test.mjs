import test from 'node:test';
import assert from 'node:assert/strict';
import {assertManagedDshLauncher} from '../apps/dsh-plugins/studio-services/media-host-policy.mjs';

const root='C:\\fixture\\runtime',scriptPath='C:\\fixture\\media-studio\\scripts\\Start-Environment.ps1';
const valid=()=>({executable:'pwsh.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,'-Service','DSH'],cwd:root,env:{MEDIA_STUDIO_HOME:root}});
test('Media Studio permits only its configured DSH launcher and runtime',()=>{
 assert.doesNotThrow(()=>assertManagedDshLauncher(valid(),root,{scriptPath}));
 for(const change of [x=>x.executable='C:\\other\\pwsh.exe',x=>x.args[4]='C:\\other\\Start-Environment.ps1',x=>x.args.push('-ValidateOnly'),x=>x.args[6]='All',x=>x.cwd='C:\\other',x=>x.env.MEDIA_STUDIO_HOME='C:\\other',x=>x.env.PATH='C:\\other']){const value=valid();change(value);assert.throws(()=>assertManagedDshLauncher(value,root,{scriptPath}),/保留/);}
});
