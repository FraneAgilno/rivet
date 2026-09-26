import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectRuntimeInstall} from '../../src/install/project-runtime.js';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'rivet-project-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project with spaces'),home=join(root,'fresh home'),packageRoot=join(root,'package');
 await mkdir(project);await mkdir(home);await mkdir(join(packageRoot,'bin'),{recursive:true});await mkdir(join(packageRoot,'templates/harness'),{recursive:true});
 await writeFile(join(project,'package.json'),'{"name":"customer"}\n');await writeFile(join(project,'package-lock.json'),'customer lock\n');
 await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@agilno/rivet',version:'1.2.3',type:'module',files:['bin','templates'],bin:{rivet:'bin/cli.js'}}));
 await writeFile(join(packageRoot,'bin/cli.js'),'#!/usr/bin/env node\nconsole.log("rivet fixture " + process.argv.slice(2).join(" "));\n',{mode:0o755});
 await writeFile(join(packageRoot,'templates/harness/SKILL.md'),'---\nname: rivet\ndescription: Rivet workflow\n---\n\nRun `rivet --help`.\n');
 const output=[];const env={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,npm_config_userconfig:join(home,'npmrc'),npm_config_globalconfig:join(home,'global-npmrc'),npm_config_cache:join(home,'npm-cache'),npm_config_offline:'true',npm_config_update_notifier:'false'};
 const dependencies={fs,packageRoot,home:()=>home,cwd:()=>project,env,output:{log:v=>output.push(v),json:v=>output.push(v),error:v=>output.push(v)}};
 const parsed={command:'install',operands:[],flags:{'project-runtime':true,target:'both',json:true}};
 return {root,project,home,packageRoot,dependencies,parsed,output,env,run:()=>projectRuntimeInstall(parsed,dependencies)};
}
test('project runtime installs a private pinned executable and survives unavailable source without changing app dependencies',async t=>{
 const f=await fixture(t);assert.equal(await f.run(),0);const launcher=join(f.project,'.rivet.cjs');const original=await readFile(launcher,'utf8');
 assert.match(await readFile(join(f.project,'.agents/skills/rivet/SKILL.md'),'utf8'),/\.rivet\.cjs/);
 await rename(f.packageRoot,f.packageRoot+'-unavailable');
 assert.match(execFileSync(process.execPath,[launcher,'models','list'],{env:f.env,encoding:'utf8'}),/rivet fixture models list/);
 assert.equal(await readFile(join(f.project,'package.json'),'utf8'),'{"name":"customer"}\n');assert.equal(await readFile(join(f.project,'package-lock.json'),'utf8'),'customer lock\n');
 await rename(f.packageRoot+'-unavailable',f.packageRoot);assert.equal(await f.run(),0);assert.equal(await readFile(launcher,'utf8'),original);
 f.parsed.command='uninstall';assert.equal(await f.run(),0);assert.equal(fs.existsSync(launcher),false);assert.ok(fs.existsSync(join(f.home,'.cache/rivet/project-runtimes')));
 assert.equal(await readFile(join(f.project,'package-lock.json'),'utf8'),'customer lock\n');
});
test('project runtime preserves user edits and old pinned reference when dependency installation fails',async t=>{
 const f=await fixture(t);await f.run();const launcher=join(f.project,'.rivet.cjs'),before=await readFile(launcher,'utf8');
 await writeFile(join(f.packageRoot,'bin/cli.js'),'console.log("new version");\n');
 f.dependencies.runtimeCommand=async()=>{throw new Error('simulated interrupted npm');};
 await assert.rejects(f.run());assert.equal(await readFile(launcher,'utf8'),before);
 await writeFile(launcher,before+'\n// user edit\n');delete f.dependencies.runtimeCommand;await assert.rejects(f.run());assert.equal(await readFile(launcher,'utf8'),before+'\n// user edit\n');
});

test('runtime updates pin changed source bytes while retaining old caches and selected uninstall preserves another harness',async t=>{
 const f=await fixture(t);await f.run();const first=f.output.at(-1).result.runtimeId;
 await writeFile(join(f.packageRoot,'bin/cli.js'),'console.log("rivet updated");\n');await f.run();const second=f.output.at(-1).result.runtimeId;assert.notEqual(second,first);
 assert.ok(fs.existsSync(join(f.home,'.cache/rivet/project-runtimes',first)));assert.match(execFileSync(process.execPath,[join(f.project,'.rivet.cjs'),'--help'],{env:f.env,encoding:'utf8'}),/updated/);
 f.parsed.command='uninstall';f.parsed.flags.target='claude';await f.run();assert.ok(fs.existsSync(join(f.project,'.rivet.cjs')));assert.ok(fs.existsSync(join(f.project,'.agents/skills/rivet/SKILL.md')));
 f.parsed.flags.target='codex';await f.run();assert.equal(fs.existsSync(join(f.project,'.rivet.cjs')),false);
});
test('launcher fails closed for mutated cache files; edited skills block updates before npm',async t=>{
 const f=await fixture(t);await f.run();const runtime=join(f.home,'.cache/rivet/project-runtimes',f.output.at(-1).result.runtimeId),entry=join(runtime,'node_modules/@agilno/rivet/bin/cli.js');
 await writeFile(entry,'console.log("MUST NOT RUN");\n');assert.throws(()=>execFileSync(process.execPath,[join(f.project,'.rivet.cjs')],{env:f.env,encoding:'utf8',stdio:'pipe'}),error=>!error.stdout.includes('MUST NOT RUN'));
 await assert.rejects(f.run());
 const other=await fixture(t);await other.run();const skill=join(other.project,'.agents/skills/rivet/SKILL.md');await writeFile(skill,'user owned edit');let called=false;other.dependencies.runtimeCommand=async()=>{called=true;};await assert.rejects(other.run());assert.equal(called,false);assert.equal(await readFile(skill,'utf8'),'user owned edit');
});
test('interrupted private preparation cleans stages and locks while preserving the accepted reference and app files',async t=>{
 const f=await fixture(t);await f.run();const before=await readFile(join(f.project,'.rivet.cjs'),'utf8');await writeFile(join(f.packageRoot,'bin/cli.js'),'console.log("next version");\n');
 f.dependencies.runtimeCommand=async(_command,_args,options)=>{process.emit('SIGTERM');assert.equal(options.signal.aborted,true);throw new Error('interrupted');};await assert.rejects(f.run());
 assert.equal(await readFile(join(f.project,'.rivet.cjs'),'utf8'),before);assert.equal(fs.existsSync(join(f.project,'.rivet-project-runtime.lock')),false);
 assert.equal((await readdir(join(f.home,'.cache/rivet/project-runtimes'))).some(name=>name.startsWith('.stage-')||name==='.install.lock'),false);
});
test('unowned reference and symlinked cache or source are preserved without npm dispatch',async t=>{
 for(const mode of ['reference','cache','source']){
  const f=await fixture(t);let calls=0;f.dependencies.runtimeCommand=async()=>{calls++;throw new Error('must not run');};
  if(mode==='reference')await writeFile(join(f.project,'.rivet.cjs'),'user code');
  if(mode==='cache'){await mkdir(join(f.home,'.cache/rivet'),{recursive:true});await symlink(f.project,join(f.home,'.cache/rivet/project-runtimes'));}
  if(mode==='source'){await rm(join(f.packageRoot,'bin'),{recursive:true});await symlink(f.project,join(f.packageRoot,'bin'));}
  await assert.rejects(f.run());assert.equal(calls,0);assert.equal(await readFile(join(f.project,'package-lock.json'),'utf8'),'customer lock\n');
 }
});

test('ordinary managed setup preserves pinned project instructions and parsed CLI selects the project-runtime mode',async t=>{
 const f=await fixture(t);const {main}=await import('../../src/cli/main.js');const {parseArgs}=await import('../../src/cli/parse-args.js');
 assert.equal(parseArgs(['install','--project-runtime']).flags['project-runtime'],true);
 assert.equal(await main(['install','--project-runtime','--target=both','--json'],f.dependencies),0,JSON.stringify(f.output));
 const skill=join(f.project,'.agents/skills/rivet/SKILL.md'),before=await readFile(skill,'utf8');
 const {managedInstall}=await import('../../src/install/managed.js');await managedInstall({command:'install',operands:[],flags:{minimal:true,target:'both'}},f.dependencies);
 assert.equal(await readFile(skill,'utf8'),before);assert.match(before,/EVERY command/);
 assert.equal(await main(['uninstall','--project-runtime','--json'],f.dependencies),0);assert.equal(fs.existsSync(join(f.project,'.rivet.cjs')),false);
});

test('interrupted cache-index publication leaves no blocking stage and can safely reuse the published cache on retry',async t=>{
 const f=await fixture(t);const original=f.dependencies.fs;let failed=false;
 f.dependencies.fs={...original,renameSync(from,to){if(String(from).endsWith('/index.json')&&!failed){failed=true;throw new Error('interrupted index publication');}return original.renameSync(from,to);}};
 await assert.rejects(f.run());assert.equal(fs.existsSync(join(f.project,'.rivet.cjs')),false);
 assert.equal((await readdir(join(f.home,'.cache/rivet/project-runtimes'))).some(name=>name.startsWith('.stage-')||name.endsWith('.tmp')),false);
 f.dependencies.fs=original;assert.equal(await f.run(),0);assert.match(execFileSync(process.execPath,[join(f.project,'.rivet.cjs'),'--help'],{env:f.env,encoding:'utf8'}),/rivet fixture/);
});

test('identical Rivet source has identical committed reference and skills across distinct private dependency resolutions',async t=>{
 const first=await fixture(t),second=await fixture(t);
 for(const [index,f] of [first,second].entries()){
  f.dependencies.runtimeCommand=async(command,args,options)=>{
   const output=execFileSync(command,args,{cwd:options.cwd,env:options.env,encoding:'utf8'});
   if(args[0]==='install')fs.writeFileSync(join('runtime','node_modules','private-platform-resolution.txt'),`private resolution ${index}\n`);
   return output;
  };
  await f.run();
 }
 assert.notEqual(first.output.at(-1).result.runtimeId,second.output.at(-1).result.runtimeId);
 assert.equal(first.output.at(-1).result.sourceDigest,second.output.at(-1).result.sourceDigest);
 assert.equal(await readFile(join(first.project,'.rivet.cjs'),'utf8'),await readFile(join(second.project,'.rivet.cjs'),'utf8'));
 assert.equal(await readFile(join(first.project,'.agents/skills/rivet/SKILL.md'),'utf8'),await readFile(join(second.project,'.agents/skills/rivet/SKILL.md'),'utf8'));
 for(const f of[first,second])assert.match(execFileSync(process.execPath,[join(f.project,'.rivet.cjs'),'--help'],{env:f.env,encoding:'utf8'}),/rivet fixture/);
});
test('cache inventory cannot authorize substituted Rivet source under the original portable source digest',async t=>{
 const f=await fixture(t);await f.run();const {default:integrity}=await import('../../src/install/runtime-integrity.cjs');
 const runtime=join(f.home,'.cache/rivet/project-runtimes',f.output.at(-1).result.runtimeId);
 await writeFile(join(runtime,'node_modules/@agilno/rivet/bin/cli.js'),'console.log("substituted source");\n');
 assert.throws(()=>integrity.runtimeIntegrity(runtime),/missing or changed/);
});

test('unsupported Node runtime rejects before npm dispatch or installation changes', async t => {
 const f=await fixture(t), descriptor=Object.getOwnPropertyDescriptor(process.versions,'node');
 const projectBefore=await readdir(f.project), homeBefore=await readdir(f.home);
 const manifestBefore=await readFile(join(f.project,'package.json')), lockBefore=await readFile(join(f.project,'package-lock.json'));
 let dispatched=0;
 f.dependencies.runtimeCommand=async()=>{dispatched++;throw new Error('npm must not run');};
 try {
  Object.defineProperty(process.versions,'node',{...descriptor,value:'20.17.0'});
  await assert.rejects(f.run(),error=>error.code==='INVALID_INPUT'&&/Node\.js 22 or newer/.test(error.message));
 } finally {Object.defineProperty(process.versions,'node',descriptor);}
 assert.equal(dispatched,0);
 assert.deepEqual(await readdir(f.project),projectBefore);
 assert.deepEqual(await readdir(f.home),homeBefore);
 assert.deepEqual(await readFile(join(f.project,'package.json')),manifestBefore);
 assert.deepEqual(await readFile(join(f.project,'package-lock.json')),lockBefore);
 assert.deepEqual(f.output,[]);
});
