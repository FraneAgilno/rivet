import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {cp,mkdtemp,readFile,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {integrationsCommand} from '../../src/commands/integrations.js';
import {loadProjectConfig} from '../../src/config/load.js';
import {createIntegrationRegistry} from '../../src/integrations/registry.js';
const files=['project.yaml','providers.yaml','orchestration.yaml','quality.yaml'];
async function fixture(t,answers={}){
  const root=await mkdtemp(join(tmpdir(),'rivet-integration-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q',root]);await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});
  const providerPath=join(root,'.rivet','providers.yaml');await writeFile(providerPath,(await readFile(providerPath,'utf8')).replace('id: jira-main\n    kind: jira\n    mode: read-write-with-approval','id: jira-main\n    kind: jira\n    mode: disabled'));
  const before=Object.fromEntries(await Promise.all(files.map(async name=>[name,await readFile(join(root,'.rivet',name),'utf8')])));
  const output=[],questions=[];
  const responses={providers:['jira'], 'jira.transport':'direct-api','jira.endpoint':'https://example.atlassian.net','jira.scope':'selected','jira.resources':'DEMO-1, DEMO-2','jira.usernameEnv':'JIRA_USER','jira.apiTokenEnv':'JIRA_TOKEN',confirm:true,...answers};
  const dependencies={fs,cwd:()=>root,terminalIsInteractive:()=>true,output:{log:value=>output.push(value),error:value=>output.push(value),json:value=>output.push(JSON.stringify(value))},
    env:{JIRA_TOKEN:'secret-value-must-never-appear'},integrationSetupPrompt:async question=>{questions.push(question);return responses[question.id];}};
  const run=()=>integrationsCommand({command:'integrations',subcommand:'setup',operands:[],flags:{}},dependencies);
  return {root,before,output,questions,responses,dependencies,run};
}
test('guided direct Jira setup appends a scoped read-only descriptor and preserves existing configuration',async t=>{
  const f=await fixture(t);const original=await loadProjectConfig(f.root);assert.equal(await f.run(),0);
  const config=await loadProjectConfig(f.root),added=config.providers.providers.at(-1);
  assert.deepEqual(config.providers.providers.slice(0,-1),original.providers.providers);
  assert.deepEqual(added,{id:'jira-direct',kind:'jira',mode:'read-only',transport:'direct-api',capabilities:['issues-read'],projectIds:[config.project.id],resourceIds:['DEMO-1','DEMO-2'],endpoint:'https://example.atlassian.net',credentials:{usernameEnv:'JIRA_USER',apiTokenEnv:'JIRA_TOKEN'}});
  for(const name of files.filter(name=>name!=='providers.yaml'))assert.equal(await readFile(join(f.root,'.rivet',name),'utf8'),f.before[name]);
  assert.equal(f.questions.filter(q=>q.id==='confirm').length,1);
  assert.match(f.output.join('\n'),/No network|network.*not.*checked/i);assert.doesNotMatch(f.output.join('\n'),/secret-value-must-never-appear/);
  assert.doesNotMatch(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),/secret-value-must-never-appear/);
  assert.equal(createIntegrationRegistry({config,projectId:config.project.id}).list().find(p=>p.id===added.id).readiness,'authentication-unavailable');
});
test('guided MCP tracker and linked context descriptors load but remain host-unavailable without real inventory',async t=>{
  const kinds=['linear','figma','confluence'];const answers={providers:kinds};
  for(const kind of kinds)Object.assign(answers,{[kind+'.transport']:'harness-mcp',[kind+'.scope']:'all',[kind+'.tools']:'read_'+kind});
  answers['linear.endpoint']='https://linear.app';answers['figma.endpoint']='https://www.figma.com';answers['confluence.endpoint']='https://example.atlassian.net';
  const f=await fixture(t,answers);assert.equal(await f.run(),0);const config=await loadProjectConfig(f.root);
  const rows=createIntegrationRegistry({config,projectId:config.project.id}).list().filter(p=>kinds.includes(p.kind)&&p.transport==='harness-mcp');
  assert.equal(rows.length,3);assert.ok(rows.every(p=>p.readiness==='host-unavailable'&&p.mode==='read-only'&&p.projectIds.includes(config.project.id)&&p.resourceIds.length===0&&!p.credentials));
  assert.match(f.output.join('\n'),/no resource ID filter/i);
  assert.equal(f.questions.some(q=>/TokenEnv|usernameEnv/.test(q.id)),false);
});
test('guided setup cancellation and noninteractive requests do not change files',async t=>{
  for(const mode of ['decline','cancel','notty']){
    const f=await fixture(t);if(mode==='decline')f.responses.confirm=false;if(mode==='cancel')f.responses.providers=null;if(mode==='notty')f.dependencies.terminalIsInteractive=()=>false;
    if(mode==='notty')await assert.rejects(f.run());else assert.equal(await f.run(),0);
    for(const name of files)assert.equal(await readFile(join(f.root,'.rivet',name),'utf8'),f.before[name]);
    if(mode==='notty')assert.equal(f.questions.length,0);
  }
});
test('guided setup rejects secret values, unsupported transports and ambiguous duplicate direct trackers without writing',async t=>{
  for(const answers of [{'jira.apiTokenEnv':'secret-token-value'}, {'jira.endpoint':'https://example.atlassian.net?token=secret'}, {'jira.transport':'local-cli'}]){
    const f=await fixture(t,answers);await assert.rejects(f.run());assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),f.before['providers.yaml']);
  }
  const f=await fixture(t);await f.run();const existing=await readFile(join(f.root,'.rivet','providers.yaml'),'utf8');
  await assert.rejects(f.run());assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),existing);
});
test('real provider update transaction detects configuration drift after preview and preserves the concurrent edit',async t=>{
  const f=await fixture(t);const prompt=f.dependencies.integrationSetupPrompt;
  f.dependencies.integrationSetupPrompt=async q=>{if(q.id==='confirm')await writeFile(join(f.root,'.rivet','quality.yaml'),f.before['quality.yaml']+'\n# concurrent change\n');return prompt(q);};
  await assert.rejects(f.run());assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),f.before['providers.yaml']);
  assert.equal(await readFile(join(f.root,'.rivet','quality.yaml'),'utf8'),f.before['quality.yaml']+'\n# concurrent change\n');
});
test('guided setup fails closed on initialization locks and linked configuration targets',async t=>{
  for(const mode of ['lock','symlink']){
    const f=await fixture(t);if(mode==='lock')await mkdir(join(f.root,'.rivet-init.lock'));else{await writeFile(join(f.root,'outside.yaml'),f.before['providers.yaml']);await rm(join(f.root,'.rivet','providers.yaml'));await symlink(join(f.root,'outside.yaml'),join(f.root,'.rivet','providers.yaml'));}
    await assert.rejects(f.run());assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),f.before['providers.yaml']);
  }
});

test('guide loads Linear direct configuration alongside Jira without a false duplicate-kind warning',async t=>{
  const f=await fixture(t,{providers:['jira','linear'],'linear.transport':'direct-api','linear.scope':'all','linear.apiTokenEnv':'LINEAR_API_KEY'});
  assert.equal(await f.run(),0);const config=await loadProjectConfig(f.root),linear=config.providers.providers.find(p=>p.id==='linear-direct');
  assert.equal(linear.endpoint,'https://api.linear.app');assert.deepEqual(linear.credentials,{apiTokenEnv:'LINEAR_API_KEY'});
  assert.deepEqual(linear.resourceIds,[]);assert.doesNotMatch(f.output.join('\n'),/would make ticket intake ambiguous/);
});
test('guided MCP descriptor resolves only against matching real project inventory and tool names',async t=>{
  const f=await fixture(t,{'jira.transport':'harness-mcp','jira.tools':'get_issue'});await f.run();const config=await loadProjectConfig(f.root);
  const registry=createIntegrationRegistry({config,projectId:config.project.id,host:{projectId:config.project.id,providers:[{id:'jira-mcp',authenticated:true,tools:['get_issue']}]}});
  assert.equal(registry.resolve({providerId:'jira-mcp',capability:'issues-read',tool:'get_issue'}).readiness,'host-observed');
  assert.throws(()=>registry.resolve({providerId:'jira-mcp',capability:'issues-read',tool:'write_issue'}));
});
test('guided CLI entry rejects JSON and missing project configuration and never inspects credential values',async t=>{
  const {main}=await import('../../src/cli/main.js');const f=await fixture(t);let read=0;
  Object.defineProperty(f.dependencies.env,'JIRA_TOKEN',{get(){read++;throw new Error('must not read secret');}});
  assert.equal(await main(['integrations','setup'],f.dependencies),0);assert.equal(read,0);
  const before=await readFile(join(f.root,'.rivet','providers.yaml'),'utf8');f.questions.length=0;
  assert.notEqual(await main(['integrations','setup','--json'],f.dependencies),0);assert.equal(f.questions.length,0);
  assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),before);
  await rm(join(f.root,'.rivet'),{recursive:true});
  assert.notEqual(await main(['integrations','setup'],f.dependencies),0);assert.match(f.output.join('\n'),/rivet setup/);
});
test('guide cancellation after collection does not create a lock or staging files',async t=>{
  const f=await fixture(t,{confirm:false});assert.equal(await f.run(),0);
  assert.equal(fs.readdirSync(f.root).some(name=>/^\.rivet-(init|stage|backup)/.test(name)),false);
});

test('provider append preserves an existing published project protocol and its discovery',async t=>{
  const f=await fixture(t);const {protocolsCommand}=await import('../../src/commands/protocols.js');let value;
  const protocol=async(subcommand,operands,flags={})=>protocolsCommand({command:'protocols',subcommand,operands,flags:{project:f.root,json:true,...flags}},{cwd:()=>f.root,output:{json:result=>{value=result;},log(){},error(){}}});
  assert.equal(await protocol('add',['team-guide']),0);await writeFile(join(f.root,'guide.md'),'# Team guide\n\n## Owner\nTest team\n\n## Purpose\nKeep team work reviewable.\n\n## Applies when\nThe team prepares a change.\n\n## Procedure\nUse recorded evidence.\n\n## Required checks and evidence\nRecord the completed verification results.\n');
  assert.equal(await protocol('update',['team-guide'],{from:'guide.md','expected-revision':'1',publish:true}),0);
  const path=join(f.root,'.rivet','protocols','team-guide.md'),before=await readFile(path,'utf8');
  assert.equal(await f.run(),0);assert.equal(await readFile(path,'utf8'),before);
  assert.equal(await protocol('find',['team']),0);assert.match(JSON.stringify(value),/team-guide/);assert.match(JSON.stringify(value),/active/);
});

test('provider publication rechecks after staging and cleans its owned temporary file without replacing concurrent edits',async t=>{
  const f=await fixture(t);const original=fs.writeFileSync;let changed=false;
  f.dependencies.fs={...fs,writeFileSync(path,...args){const result=original(path,...args);if(typeof path==='string'&&path.startsWith('.rivet-providers-')){changed=true;original('quality.yaml',f.before['quality.yaml']+'\n# concurrent staged change\n');}return result;}};
  await assert.rejects(f.run());assert.equal(changed,true);assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),f.before['providers.yaml']);
  assert.equal(await readFile(join(f.root,'.rivet','quality.yaml'),'utf8'),f.before['quality.yaml']+'\n# concurrent staged change\n');
  assert.equal(fs.readdirSync(join(f.root,'.rivet')).some(name=>name.startsWith('.rivet-providers-')),false);
});
test('guide rejects configuration topology changes made during approval',async t=>{
  const f=await fixture(t);const original=f.dependencies.integrationSetupPrompt;
  f.dependencies.integrationSetupPrompt=async q=>{if(q.id==='confirm')await writeFile(join(f.root,'.rivet','unexpected.yaml'),'changed\n');return original(q);};
  await assert.rejects(f.run());assert.equal(await readFile(join(f.root,'.rivet','providers.yaml'),'utf8'),f.before['providers.yaml']);
});
