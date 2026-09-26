import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const installer=fileURLToPath(new URL('../../scripts/install.sh',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),"rivet bootstrap's "));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runtime manager'),temporary=join(root,'temporary'),prefix=join(root,"prefix's files");await mkdir(runtime);await mkdir(temporary);
 await symlink(process.execPath,join(runtime,'node'));
 const artifact=join(root,"release's artifact.tgz"), source=join(root,'archive source');await mkdir(join(source,'package'),{recursive:true});
 await writeFile(join(source,'package','package.json'),JSON.stringify({name:'@agilno/rivet',version:'0.1.0-alpha.0',bin:{rivet:'bin/cli.js'}}));
 execFileSync('/usr/bin/tar',['-czf',artifact,'-C',source,'package']);
 const digest=createHash('sha256').update(await readFile(artifact)).digest('hex');
 const calls=join(root,'calls.jsonl');
 const env={PATH:`${runtime}:${dirname(process.execPath)}:/usr/bin:/bin`,HOME:root,TMPDIR:temporary,BOOTSTRAP_CALLS:calls,BOOTSTRAP_PREFIX:prefix,BOOTSTRAP_SHA:digest};
 const run=(hash=digest,extra={})=>spawnSync('/bin/sh',[installer,'--artifact',artifact,'--sha256',hash,'--prefix',prefix],{env:{...env,...extra},encoding:'utf8',timeout:30000});
 return {root,runtime,temporary,prefix,artifact,digest,calls,env,run};
}
test('bootstrap verifies copied checksum before any npm dispatch and cleans its private directory',async t=>{
 const f=await fixture(t);await writeFile(join(f.runtime,'npm'),'#!/bin/sh\nprintf called > "$BOOTSTRAP_CALLS"\nexit 1\n',{mode:0o755});
 const result=f.run('0'.repeat(64));assert.notEqual(result.status,0);assert.match(result.stderr,/checksum/i);
 assert.equal(await readFile(f.calls).then(()=>true,()=>false),false);assert.deepEqual((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')),[]);
});
test('bootstrap passes exact verified temp artifact and ignore-scripts; failed npm cleans temp without deleting prefix',async t=>{
 const f=await fixture(t);await mkdir(f.prefix);await writeFile(join(f.prefix,'keep'),'user data');
 await writeFile(join(f.runtime,'npm'),`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.BOOTSTRAP_CALLS,JSON.stringify(a)+'\\n');if(a[0]==='--version')console.log('10.9.0');else if(a[0]==='prefix')console.log(process.env.BOOTSTRAP_PREFIX);else{const artifact=a.at(-1);if(require('node:crypto').createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')!==process.env.BOOTSTRAP_SHA)process.exit(88);process.exit(12);}\n`,{mode:0o755});
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/npm install failed/i);
 const calls=(await readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);const install=calls.find(a=>a[0]==='install');
 assert.ok(install.includes('--ignore-scripts'));assert.ok(install.includes('--install-links'));assert.ok(install.includes(f.prefix));assert.notEqual(install.at(-1),f.artifact);assert.ok(install.at(-1).startsWith(f.temporary));
 assert.equal(await readFile(join(f.prefix,'keep'),'utf8'),'user data');assert.deepEqual((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')),[]);
});
test('bootstrap installs a real local tarball through runtime-manager PATH and verifies the public entry without running lifecycle hooks',async t=>{
 const f=await fixture(t);const source=join(f.root,'package source');await mkdir(join(source,'bin'),{recursive:true});
 await writeFile(join(source,'package.json'),JSON.stringify({name:'@agilno/rivet',version:'0.1.0-alpha.0',bin:{rivet:'bin/cli.js'},scripts:{postinstall:'node -e "process.exit(89)"'}}));
 await writeFile(join(source,'bin/cli.js'),'#!/usr/bin/env node\nconsole.log("rivet fixture usage");\n',{mode:0o755});
 const isolated={...f.env,npm_config_userconfig:join(f.root,'npmrc'),npm_config_globalconfig:join(f.root,'global-npmrc'),npm_config_cache:join(f.root,'cache'),npm_config_offline:'true',npm_config_update_notifier:'false'};
 const [pack]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',f.root],{cwd:source,env:isolated,encoding:'utf8'}));
 const bytes=await readFile(join(f.root,pack.filename));await writeFile(f.artifact,bytes);const result=f.run(createHash('sha256').update(bytes).digest('hex'),isolated);
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/rivet setup/);assert.match(result.stdout,/PATH/);assert.deepEqual((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')),[]);
 assert.match(execFileSync(join(f.prefix,'bin','rivet'),['--help'],{env:isolated,encoding:'utf8'}),/rivet fixture/);
 const defaultPrefix=join(f.root,'configured default prefix');
 const defaultInstall=spawnSync('/bin/sh',[installer,'--artifact',f.artifact,'--sha256',createHash('sha256').update(bytes).digest('hex')],{env:{...isolated,npm_config_prefix:defaultPrefix},encoding:'utf8',timeout:30000});
 assert.equal(defaultInstall.status,0,defaultInstall.stderr);assert.match(execFileSync(join(defaultPrefix,'bin','rivet'),['--help'],{env:isolated,encoding:'utf8'}),/rivet fixture/);
});

test('bootstrap rejects unavailable temp location before npm and validates required arguments',async t=>{
 const f=await fixture(t);await writeFile(join(f.runtime,'npm'),'#!/bin/sh\nprintf called > "$BOOTSTRAP_CALLS"\n',{mode:0o755});
 const result=f.run(f.digest,{TMPDIR:join(f.root,'missing','temporary')});assert.notEqual(result.status,0);
 assert.equal(await readFile(f.calls).then(()=>true,()=>false),false);
 const invalid=spawnSync('/bin/sh',[installer,'--artifact',f.artifact,'--sha256',f.digest,'--prefix'],{env:f.env,encoding:'utf8'});assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Usage:/);
});
test('bootstrap termination cleans the owned private copy and preserves the installation prefix',async t=>{
 const {spawn}=await import('node:child_process');const f=await fixture(t);await mkdir(f.prefix);await writeFile(join(f.prefix,'keep'),'preserved');
 await writeFile(join(f.runtime,'npm'),`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]==='--version')console.log('10.9.0');else{fs.writeFileSync(process.env.BOOTSTRAP_CALLS,'ready');setInterval(()=>{},1000);}\n`,{mode:0o755});
 const child=spawn('/bin/sh',[installer,'--artifact',f.artifact,'--sha256',f.digest,'--prefix',f.prefix],{env:f.env,stdio:'ignore'});t.after(()=>child.kill('SIGKILL'));
 const exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 let ready=false;for(let attempt=0;attempt<100;attempt++){if(await readFile(f.calls).then(()=>true,()=>false)){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(ready,true);assert.equal((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')).length,1);child.kill('SIGTERM');assert.equal((await exit).code,143);
 assert.deepEqual((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')),[]);assert.equal(await readFile(join(f.prefix,'keep'),'utf8'),'preserved');
});

test('bootstrap interruption stops npm descendants before reporting exit and removing its private copy',async t=>{
 const {spawn}=await import('node:child_process');const f=await fixture(t);const heartbeat=join(f.root,'heartbeat'),pidFile=join(f.root,'descendant.pid');
 const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
 await writeFile(join(f.runtime,'npm'),`#!/usr/bin/env node\nif(process.argv[2]==='--version')console.log('10.9.0');else{const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);}\n`,{mode:0o755});
 const child=spawn('/bin/sh',[installer,'--artifact',f.artifact,'--sha256',f.digest,'--prefix',f.prefix],{env:f.env,stdio:'ignore'});let descendantPid;
 t.after(()=>{child.kill('SIGKILL');if(descendantPid)try{process.kill(descendantPid,'SIGKILL');}catch{}});
 const exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 let ready=false;for(let attempt=0;attempt<100;attempt++){if(await readFile(heartbeat).then(()=>true,()=>false)){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(ready,true);descendantPid=Number(await readFile(pidFile,'utf8'));child.kill('SIGTERM');assert.equal((await exit).code,143);
 const before=await readFile(heartbeat,'utf8');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await readFile(heartbeat,'utf8'),before,'descendant must stop before bootstrap exits');
 assert.deepEqual((await readdir(f.temporary)).filter(name=>name.startsWith('rivet-install-')),[]);
});

test('wrong-package tarball cannot be validated by a preexisting Rivet installation and never reaches npm install',async t=>{
 const f=await fixture(t);const installed=join(f.prefix,'lib/node_modules/@agilno/rivet');await mkdir(join(installed,'bin'),{recursive:true});await mkdir(join(f.prefix,'bin'),{recursive:true});
 await writeFile(join(installed,'package.json'),JSON.stringify({name:'@agilno/rivet',version:'0.1.0-alpha.0',bin:{rivet:'bin/cli.js'}}));await writeFile(join(installed,'bin/cli.js'),'#!/usr/bin/env node\nconsole.log("rivet");\n',{mode:0o755});await symlink(join(installed,'bin/cli.js'),join(f.prefix,'bin/rivet'));
 const source=join(f.root,'other source');await mkdir(join(source,'package'),{recursive:true});await writeFile(join(source,'package/package.json'),JSON.stringify({name:'other-package',version:'1.0.0',bin:{rivet:'bin/cli.js'}}));execFileSync('/usr/bin/tar',['-czf',f.artifact,'-C',source,'package']);
 await writeFile(join(f.runtime,'npm'),`#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.BOOTSTRAP_CALLS,process.argv[2]+'\\n');if(process.argv[2]==='--version')console.log('10.9.0');\n`,{mode:0o755});
 const result=f.run(createHash('sha256').update(await readFile(f.artifact)).digest('hex'));assert.notEqual(result.status,0);assert.match(result.stderr,/package identity/i);
 assert.equal(await readFile(f.calls,'utf8').then(value=>value.includes('install'),()=>false),false);
});

test('duplicate package metadata is rejected before npm; installed version must match verified metadata',async t=>{
 for(const mode of ['duplicate','version']){
  const f=await fixture(t);
  await writeFile(join(f.runtime,'npm'),`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.BOOTSTRAP_CALLS,process.argv[2]+'\\n');if(process.argv[2]==='--version')console.log('10.9.0');\n`,{mode:0o755});
  if(mode==='duplicate')execFileSync('/usr/bin/tar',['-czf',f.artifact,'-C',join(f.root,'archive source'),'package/package.json','package/package.json']);
  else{const installed=join(f.prefix,'lib/node_modules/@agilno/rivet');await mkdir(installed,{recursive:true});await writeFile(join(installed,'package.json'),JSON.stringify({name:'@agilno/rivet',version:'0.0.1',bin:{rivet:'bin/cli.js'}}));}
  const result=f.run(createHash('sha256').update(await readFile(f.artifact)).digest('hex'));assert.notEqual(result.status,0);
  assert.match(result.stderr,mode==='duplicate'?/duplicate package metadata/:/identity differs/);
  if(mode==='duplicate')assert.equal(await readFile(f.calls).then(()=>true,()=>false),false);
 }
});

test('malformed release versions are rejected before npm is invoked',async t=>{
 for(const version of ['0.1.0-alpha..1','0.1.0-01']){
  const f=await fixture(t);await writeFile(join(f.root,'archive source/package/package.json'),JSON.stringify({name:'@agilno/rivet',version,bin:{rivet:'bin/cli.js'}}));execFileSync('/usr/bin/tar',['-czf',f.artifact,'-C',join(f.root,'archive source'),'package']);
  await writeFile(join(f.runtime,'npm'),'#!/bin/sh\nprintf called > "$BOOTSTRAP_CALLS"\nexit 1\n',{mode:0o755});
  const result=f.run(createHash('sha256').update(await readFile(f.artifact)).digest('hex'));assert.notEqual(result.status,0);assert.equal(await readFile(f.calls).then(()=>true,()=>false),false);
 }
});
