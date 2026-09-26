import assert from 'node:assert/strict';
import test from 'node:test';
import {selectConfiguredRepositoryRemote} from '../../src/repositories/identity.js';
const remotes=[{name:'origin',url:'git@github.com:team/fork.git'},{name:'upstream',url:'https://github.com/team/main.git'}];
test('saved remote binds canonical identity; explicit overrides stay operation scoped',()=>{
 const preference={name:'upstream',url:'https://github.com/team/main'};
 assert.equal(selectConfiguredRepositoryRemote(remotes,preference).fullName,'team/main');
 assert.equal(selectConfiguredRepositoryRemote(remotes,preference,'origin').fullName,'team/fork');
 assert.throws(()=>selectConfiguredRepositoryRemote([{name:'upstream',url:'https://github.com/team/replaced'}],preference));
 assert.throws(()=>selectConfiguredRepositoryRemote(remotes));
});

import * as fs from 'node:fs';
import {mkdtemp,writeFile,mkdir,cp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setupCommand} from '../../src/commands/setup.js';
import {prepareSetupRemote} from '../../src/commands/setup-remote.js';
import {prepareRepositoryRemoteUpdate} from '../../src/commands/init.js';
import {loadProjectConfig} from '../../src/config/load.js';
async function fixture(t,existing=false){
 const root=await mkdtemp(join(tmpdir(),'rivet-remote-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'package.json'),JSON.stringify({name:'remote-fixture',scripts:{build:'echo ok',test:'echo ok'}}));
 if(existing)await cp(new URL('../fixtures/config/valid/.rivet',import.meta.url),join(root,'.rivet'),{recursive:true});
 const output=[];let installs=0;let current=structuredClone(remotes);
 const deps={fs,cwd:()=>root,packageRoot:new URL('../../',import.meta.url).pathname,output:{json:value=>output.push(value),log:value=>output.push(value),error:value=>output.push(value)},gitDiscovery:async()=>({repository:true,defaultBranch:'main'}),toolDiscovery:async()=>({node:{present:true,version:'22.0.0'},git:{present:true},npm:{present:true}}),repositories:{discoverRemotes:async()=>current},setup:{inspectInstall:async()=>({targets:[]}),install:async(_p,d)=>{installs++;d.output.json({ok:true});return 0;}}};
 return {root,deps,output,installs:()=>installs,setRemotes:value=>{current=value;},run:flags=>setupCommand({command:'setup',subcommand:null,operands:[],flags:{project:root,json:true,...flags}},deps)};
}
test('ambiguous preview is safe; noninteractive write requires choice and explicit selection persists',async t=>{
 const f=await fixture(t);assert.equal(await f.run({}),0);assert.equal(f.output.at(-1).repository.status,'selection-required');assert.equal(fs.existsSync(join(f.root,'.rivet')),false);
 await assert.rejects(f.run({write:true}),/--remote/);assert.equal(f.installs(),0);
 assert.equal(await f.run({write:true,remote:'upstream'}),0);
 assert.deepEqual((await loadProjectConfig(f.root)).project.repository.remote,{name:'upstream',url:'https://github.com/team/main'});
});
test('one supported remote is selected without origin preference; unsupported credential URLs are never displayed',async t=>{
 const f=await fixture(t);f.setRemotes([{name:'origin',url:'https://secret:password@github.com/private/repo'},remotes[1]]);
 assert.equal(await f.run({write:true}),0);assert.equal((await loadProjectConfig(f.root)).project.repository.remote.name,'upstream');assert.doesNotMatch(JSON.stringify(f.output),/secret|password/);
});
test('local-only and unsupported remote projects remain usable',async t=>{
 for(const remotes of [[],[{name:'local',url:'/private/company/repo'}]]){
  const f=await fixture(t);f.setRemotes(remotes);assert.equal(await f.run({write:true}),0);assert.equal((await loadProjectConfig(f.root)).project.repository.remote,undefined);
 }
});
test('interactive selection cancels without files and detects remote drift after prompt',async t=>{
 const f=await fixture(t);f.deps.terminalIsInteractive=()=>true;f.deps.setupRemotePrompt=async()=>null;
 await assert.rejects(f.run({write:true,json:false}),/cancelled/);assert.equal(fs.existsSync(join(f.root,'.rivet')),false);assert.equal(f.installs(),0);
 f.deps.setupRemotePrompt=async()=>{f.setRemotes([{name:'upstream',url:'https://github.com/team/substituted'}]);return 'upstream';};
 await assert.rejects(f.run({write:true,json:false}),/changed/);assert.equal(fs.existsSync(join(f.root,'.rivet')),false);
});
test('saved selection preserves project comments, protocol files and other configs; drift requires explicit reselection',async t=>{
 const f=await fixture(t,true),directory=join(f.root,'.rivet');
 const project=await readFile(join(directory,'project.yaml'),'utf8');await writeFile(join(directory,'project.yaml'),'# keep this comment\n'+project);await mkdir(join(directory,'protocols'));await writeFile(join(directory,'protocols','note.md'),'user protocol');
 const others=await Promise.all(['providers','quality','orchestration'].map(name=>readFile(join(directory,name+'.yaml'),'utf8')));
 assert.equal(await f.run({write:true,remote:'upstream'}),0);assert.match(await readFile(join(directory,'project.yaml'),'utf8'),/^# keep this comment/);assert.equal(await readFile(join(directory,'protocols','note.md'),'utf8'),'user protocol');
 assert.deepEqual(await Promise.all(['providers','quality','orchestration'].map(name=>readFile(join(directory,name+'.yaml'),'utf8'))),others);
 f.setRemotes([{name:'upstream',url:'https://github.com/team/replaced'}]);await assert.rejects(f.run({write:true}),/changed/);
 assert.equal(await f.run({write:true,remote:'upstream'}),0);assert.equal((await loadProjectConfig(f.root)).project.repository.remote.url,'https://github.com/team/replaced');
});
test('single-file transaction refuses concurrent config edits and preserves user bytes',async t=>{
 const f=await fixture(t,true);const transaction=await prepareRepositoryRemoteUpdate(f.root,{fs});const proposal=transaction.propose({name:'upstream',url:'https://github.com/team/main'});
 const path=join(f.root,'.rivet','project.yaml'),bytes=await readFile(path,'utf8');await writeFile(path,bytes+'\n# concurrent edit\n');await assert.rejects(proposal.commit(),/changed/);assert.equal(await readFile(path,'utf8'),bytes+'\n# concurrent edit\n');
 assert.equal((await readdir(f.root)).some(name=>name.includes('lock')||name.includes('stage')),false);
});
test('alias names still require explicit selection and direct init detects last-minute remote drift',async t=>{
 const f=await fixture(t);f.setRemotes([{name:'one',url:'https://github.com/team/main'},{name:'two',url:'git@github.com:team/main.git'}]);
 assert.equal((await prepareSetupRemote(f.root,{},f.deps)).status,'selection-required');
 f.deps.beforePublish=()=>f.setRemotes([{name:'one',url:'https://github.com/team/substituted'}]);
 const {init}=await import('../../src/commands/init.js');
 assert.notEqual(await init({flags:{project:f.root,write:true,remote:'one',json:true}},f.deps),0);
 assert.equal(fs.existsSync(join(f.root,'.rivet')),false);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.rivet-')),false);
});
test('failed project preference publication preserves original bytes and removes only its temporary file',async t=>{
 const f=await fixture(t,true),path=join(f.root,'.rivet/project.yaml'),before=await readFile(path,'utf8');
 const io={...fs,renameSync(from,to){if(to==='project.yaml')throw new Error('simulated rename failure');return fs.renameSync(from,to);}};
 const transaction=await prepareRepositoryRemoteUpdate(f.root,{fs:io});
 await assert.rejects(transaction.propose({name:'upstream',url:'https://github.com/team/main'}).commit(),/rename failure/);
 assert.equal(await readFile(path,'utf8'),before);assert.equal((await readdir(join(f.root,'.rivet'))).some(name=>name.endsWith('.tmp')),false);assert.equal(fs.existsSync(join(f.root,'.rivet-init.lock')),false);
});
test('human preview labels the exact selected remote without writing',async t=>{
 const f=await fixture(t);assert.equal(await f.run({remote:'upstream',json:false}),0);
 assert.ok(f.output.some(value=>typeof value==='string'&&value.includes('Selected repository remote: upstream -> https://github.com/team/main')));assert.equal(fs.existsSync(join(f.root,'.rivet')),false);
});
test('saved setup and direct init human previews identify selection and unresolved ambiguity',async t=>{
 const f=await fixture(t);await f.run({write:true,remote:'upstream'});f.output.length=0;await f.run({json:false});assert.ok(f.output.some(value=>typeof value==='string'&&value.includes('Selected repository remote: upstream')));
 const fresh=await fixture(t),{init}=await import('../../src/commands/init.js');
 await init({flags:{project:fresh.root,remote:'origin'}},fresh.deps);assert.ok(fresh.output.some(value=>typeof value==='string'&&value.includes('Selected repository remote: origin -> https://github.com/team/fork')));
 fresh.output.length=0;await init({flags:{project:fresh.root}},fresh.deps);assert.ok(fresh.output.some(value=>typeof value==='string'&&value.includes('Choose a repository remote with --remote=<name>')));
});
