import assert from 'node:assert/strict';
import test from 'node:test';
import {createProtocolPresentation,protocolLookupContext,serializeProtocolLaunch} from '../../src/protocols/presentation.js';

test('protocol presentation rejects unbranded public lookups and executable overrides',()=>{
 assert.throws(()=>protocolLookupContext(Object.freeze({sourceRoot:'/tmp',refs:[]})));
 assert.throws(()=>createProtocolPresentation({sourceRoot:'/tmp',refs:[],cliPath:'/tmp/untrusted'}));
});

import {mkdtemp,mkdir,writeFile,rm,realpath,rename,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import YAML from 'yaml';
import {bodyDigest} from '../../src/protocols/project.js';
import {createLaunchContract} from '../../src/clients/contract.js';
import {serializeLaunchContract} from '../../src/prompts/launch-contract.js';
import {createClaudeClient,CLAUDE_ADAPTER_SYNTAX} from '../../src/clients/claude.js';
import {createCodexClient,CODEX_ADAPTER_SYNTAX} from '../../src/clients/codex.js';
function inputFor(contract) { const {version,...input}=contract;return input; }
function launch(refs=[],worktree={path:'/tmp/worktree',dev:'1',ino:'2',reservationId:'lease-one'}) {
 return createLaunchContract({nodeId:'worker-one',parentId:'manager-one',objective:'Implement safely.',ownedPaths:['src/code.js'],authority:{actions:['code.write'],providers:[]},commands:['test.unit'],evidence:['test-results'],budget:{maxTokens:12000,maxRuntimeMs:30000,maxCostUsd:2},worktree,contextRefs:refs,heartbeatInterval:5000,stopConditions:['objective-complete','authority-blocked']});
}
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'protocol-presentation-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source project');await mkdir(join(source,'.rivet','protocols'),{recursive:true});
 const metadata={schemaVersion:1,id:'guide',title:'Guide',status:'active',revision:1,updatedAt:'2026-09-26T00:00:00.000Z'};
 const body='# Guide\n\nExisting legacy procedure.\n';metadata.digest=bodyDigest(metadata,body);
 const file=join(source,'.rivet','protocols','guide.md');await writeFile(file,'---\n'+YAML.stringify(metadata)+'---\n'+body);
 return {root,source,file,ref:`protocol:guide:1:${metadata.digest}`};
}
test('validated source presentation supplies exact read argv without changing sealed JSON bytes',async t=>{
 const f=await fixture(t),context=createProtocolPresentation({sourceRoot:f.source,refs:[f.ref]});
 assert.ok(Object.isFrozen(context));assert.ok(Object.isFrozen(context.refs));
 const lookup=protocolLookupContext(context),argv=lookup.lookups[0].argv;
 assert.equal(argv[0],await realpath(process.execPath));assert.ok(argv[1].endsWith('/bin/cli.js'));
 assert.deepEqual(argv.slice(2),['protocols','show','guide',`--project=${f.source}`,'--expected-revision=1',`--expected-digest=${f.ref.split(':').slice(3).join(':')}`]);
 const contract=launch([f.ref]),sealed=serializeLaunchContract(contract),prompt=serializeProtocolLaunch(contract,context);
 assert.ok(prompt.endsWith(sealed));assert.equal(prompt.slice(prompt.lastIndexOf('\n')+1),sealed);assert.match(prompt,/Before implementation/);
 assert.throws(()=>serializeProtocolLaunch(contract));assert.throws(()=>serializeProtocolLaunch(launch([]),context));
 assert.throws(()=>protocolLookupContext({...context,sourceRoot:f.root}));
 assert.equal(serializeProtocolLaunch(launch()),serializeLaunchContract(launch()));
});
test('protocol content and source-root identity substitution invalidate a minted context',async t=>{
 const f=await fixture(t),context=createProtocolPresentation({sourceRoot:f.source,refs:[f.ref]});
 await writeFile(f.file,'changed');assert.throws(()=>protocolLookupContext(context));
 const other=await fixture(t),valid=createProtocolPresentation({sourceRoot:other.source,refs:[other.ref]});
 await rename(other.source,other.source+'-old');await mkdir(other.source);assert.throws(()=>protocolLookupContext(valid));
});
test('native adapters reject unbranded, mismatched or missing protocol context before executable access',async t=>{
 const f=await fixture(t),context=createProtocolPresentation({sourceRoot:f.source,refs:[f.ref]});
 for(const [create,syntax] of [[createClaudeClient,CLAUDE_ADAPTER_SYNTAX],[createCodexClient,CODEX_ADAPTER_SYNTAX]]){
  const client=create({executable:'/missing/native-harness',args:syntax.args});
  for(const [contract,options] of [[launch([f.ref]),{}],[launch([f.ref]),{protocolContext:{...context}}],[launch(),{protocolContext:context}]]){
   await assert.rejects(client.launch(inputFor(contract),options),error=>error.code==='ERR_AGENT_INVALID_CONTRACT');
  }
 }
});

import {readFile,access} from 'node:fs/promises';
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
for (const [create,syntax] of [[createClaudeClient,CLAUDE_ADAPTER_SYNTAX],[createCodexClient,CODEX_ADAPTER_SYNTAX]]) {
 test(`${syntax.provider} native stdin contains trusted source lookup then byte-identical contract; compatibility-time drift blocks dispatch`,async t=>{
  const f=await fixture(t),worktree=join(f.root,'worker');await mkdir(worktree);
  const stat=await lstat(worktree,{bigint:true}),contract=launch([f.ref],{path:worktree,dev:String(stat.dev),ino:String(stat.ino),reservationId:'lease-one'});
  const interpreter=await realpath('/bin/sh'),capture=join(f.root,'captured'),executable=join(f.root,'fake-'+syntax.provider);
  const result={version:1,status:'success',output:{summary:'done',evidence:['tests']},usage:{tokens:1,costUsd:0}};
  const response=JSON.stringify(syntax.provider==='claude'?{type:'result',subtype:'success',structured_output:result}:result);
  const version=syntax.provider==='claude'?'99.0.0 (Claude Code)':'codex-cli 99.0.0';
  const script=drift=>`#!${interpreter}\nif [ "$1" = "--version" ]; then printf '%s\\n' ${quote(version)}; exit 0; fi\nif [ "$1" = "--help" ] || [ "$2" = "--help" ]; then ${drift?`printf changed > ${quote(f.file)}; `:''}printf '%s\\n' ${quote(syntax.requiredOptions.join('\n'))}; exit 0; fi\ncat > ${quote(capture)}\nprintf '%s\\n' ${quote(response)}\n`;
  await writeFile(executable,script(false),{mode:0o700});
  const context=createProtocolPresentation({sourceRoot:f.source,refs:[f.ref]}),client=create({executable,interpreter,args:syntax.args});
  assert.equal((await client.launch(inputFor(contract),{protocolContext:context})).status,'success');
  const stdin=await readFile(capture,'utf8');assert.equal(stdin,serializeProtocolLaunch(contract,context));assert.ok(stdin.endsWith(serializeLaunchContract(contract)));
  await rm(capture);await writeFile(executable,script(true),{mode:0o700});
  await assert.rejects(create({executable,interpreter,args:syntax.args}).launch(inputFor(contract),{protocolContext:context}));
  await assert.rejects(access(capture));
 });
}

import {createProcessRunner} from '../../src/clients/process-runner.js';
test('process runner applies input bounds to the protocol preface and sealed JSON together',async t=>{
 const f=await fixture(t),stat=await lstat(f.root,{bigint:true});
 const worktree={path:f.root,dev:String(stat.dev),ino:String(stat.ino),reservationId:'lease-one'},contract=launch([f.ref],worktree);
 const payload=serializeLaunchContract(contract),context=createProtocolPresentation({sourceRoot:f.source,refs:[f.ref]});
 const runner=await createProcessRunner({executable:await realpath(process.execPath),worktree:f.root,worktreeIdentity:{dev:worktree.dev,ino:worktree.ino},maxInputBytes:Buffer.byteLength(payload)+1,timeoutMs:1000});
 await assert.rejects(runner.run({args:[],cwd:'.',payload,protocolContext:context}),error=>error.code==='ERR_AGENT_INVALID_CONTRACT');
});

test('direct process runner rejects selected protocols without trusted context before dispatch',async t=>{
 const f=await fixture(t),stat=await lstat(f.root,{bigint:true}),marker=join(f.root,'dispatched');
 const worktree={path:f.root,dev:String(stat.dev),ino:String(stat.ino),reservationId:'lease-one'};
 const runner=await createProcessRunner({executable:await realpath(process.execPath),worktree:f.root,worktreeIdentity:{dev:worktree.dev,ino:worktree.ino},allowOptionArgs:true,timeoutMs:1000});
 await assert.rejects(runner.run({args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'dispatched')`],cwd:'.',payload:serializeLaunchContract(launch([f.ref],worktree))}),error=>error.code==='ERR_AGENT_INVALID_CONTRACT');
 await assert.rejects(access(marker));
});

import {cp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {protocolCompleteness} from '../../src/protocols/project.js';
test('generated lookup retrieves a complete protocol above JSON output capacity and wrong digest returns no body',async t=>{
 const f=await fixture(t);
 await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(f.source,'.rivet'),{recursive:true});
 const body='# Large approved guide\n\n## Owner\nTeam Engineering\n\n## Purpose\n'+('Explain the supported workflow.\n'.repeat(100))+'\n## Applies when\nFor project implementation.\n\n## Procedure\n'+('Read the request and verify the result.\n'.repeat(1620))+'\n## Required checks and evidence\nRecord the project checks and attach results.\n';
 assert.ok(Buffer.byteLength(body)>64*1024);assert.equal(protocolCompleteness(body).ready,true);
 const metadata={schemaVersion:1,id:'guide',title:'Large approved guide',status:'active',revision:1,updatedAt:'2026-09-26T00:00:00.000Z'};metadata.digest=bodyDigest(metadata,body);
 await writeFile(f.file,'---\n'+YAML.stringify(metadata)+'---\n'+body);
 const context=createProtocolPresentation({sourceRoot:f.source,refs:[`protocol:guide:1:${metadata.digest}`]}),argv=protocolLookupContext(context).lookups[0].argv;
 const result=spawnSync(argv[0],argv.slice(1),{cwd:f.source,encoding:'utf8',maxBuffer:512*1024});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).protocol.body,body,'full approved body is returned');
 const changed=argv.map(arg=>arg.startsWith('--expected-digest=')?'--expected-digest=sha256:'+'0'.repeat(64):arg);
 const mismatch=spawnSync(changed[0],changed.slice(1),{cwd:f.source,encoding:'utf8',maxBuffer:512*1024});
 assert.notEqual(mismatch.status,0);assert.ok(!mismatch.stdout.includes(body));assert.ok(!mismatch.stderr.includes('Read the request and verify the result.'));
});
