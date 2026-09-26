import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createAdapter, createSourceEnvelope } from '../../src/adapters/contract.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';

const execFile = promisify(execFileCallback);
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'fixtures', 'config', 'valid', '.rivet');
const REQUEST = join(HERE, '..', 'fixtures', 'work-requests', 'smart-agenda.md');
const NOW = '2029-01-01T00:00:00.000Z';

function proposal(contract) {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement agenda recommendations and calendar export.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: contract.workRequest.acceptanceCriteria.map((_, index) => index + 1),
      },
    ],
  };
}

function trackerAdapter(provider, id, request) {
  const envelope = createSourceEnvelope({
    provider,
    sourceId: id,
    sourceUrl: provider === 'jira' ? `https://jira.example.test/browse/${id}` : `https://linear.app/example/issue/${id}/smart-agenda`,
    fetchedAt: NOW,
    fixtureSource: false,
    raw: { id },
    normalized: {
      id,
      summary: 'Smart agenda builder',
      description: request,
      acceptanceCriteria: [
        'Preserve sessions the attendee already accepted.',
        'Export the resulting agenda as an ICS file.',
      ],
      revision: NOW,
      ...(provider === 'jira' ? { epicId: '' } : {}),
      links: [], comments: [],
    },
    retryClassification: 'none',
    capabilities: { read: ['issue'], write: [] },
  });
  return createAdapter({
    provider, fixtureSource: false, capabilities: { read: ['issue'], write: [] },
    async read() { return envelope; },
    async write() { throw new Error('tracker writes are not part of this workflow'); },
  });
}

async function git(root, ...args) {
  return (await execFile('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-e2e-')));
  const root = join(parent, 'app');
  const remote = join(parent, 'origin.git');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'requests'), { recursive: true });
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await cp(REQUEST, join(root, 'requests', 'smart-agenda.md'));
  await writeFile(join(root, '.rivet', 'providers.yaml'), `schemaVersion: 1
providers:
  - id: jira-main
    kind: jira
    mode: read-only
    capabilities: [issues-read]
    endpoint: https://jira.example.test
    credentials:
      apiTokenEnv: JIRA_API_TOKEN
  - id: linear-main
    kind: linear
    mode: read-only
    capabilities: [issues-read]
    endpoint: https://api.linear.app
    credentials:
      apiTokenEnv: LINEAR_API_TOKEN
  - id: confluence-main
    kind: confluence
    mode: read-only
    capabilities: [pages-read]
    resourceIds: [SPACE]
    credentials:
      apiTokenEnv: ATLASSIAN_API_TOKEN
  - id: figma-main
    kind: figma
    mode: read-only
    capabilities: [files-read]
    resourceIds: [DEMO_FILE]
    credentials:
      accessTokenEnv: FIGMA_ACCESS_TOKEN
  - id: git-ci-main
    kind: git-ci
    mode: read-write-with-approval
    capabilities: [repository-read, pull-request-write, checks-read]
    resourceIds: [agilno/conference-planner]
    credentials:
      tokenEnv: GITHUB_TOKEN
`);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fresh-nextjs-target', private: true, scripts: {
      build: 'node --check app/page.js', test: 'node --test test/*.test.js',
      lint: 'node --check app/page.js', typecheck: 'node --check app/page.js', dev: 'node app/page.js',
    },
  }, null, 2) + '\n');
  await writeFile(join(root, 'app', 'page.js'), "export default function Page() { return 'Conference planner'; }\n");
  await execFile('/usr/bin/git', ['init', '--quiet', '--bare', remote]);
  await execFile('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial target');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');
  return { parent, root, remote, baseline: await git(root, 'rev-parse', 'HEAD') };
}


import {rm} from 'node:fs/promises';
import YAML from 'yaml';
import {bodyDigest, assertSelectedProtocolRefs} from '../../src/protocols/project.js';
import {activeProtocolContextRefs} from '../../src/commands/protocols.js';
import {createHostExecution} from '../../src/feature/host-execution.js';
const saveProtocol=async(root,id,revision,status='active')=>{
 const body='# Guide\n\nExisting reviewed procedure revision '+revision+'.\n';
 const metadata={schemaVersion:1,id,title:'Guide',status,revision,updatedAt:'2026-09-26T00:00:00.000Z'};
 metadata.digest=bodyDigest(metadata,body);
 await mkdir(join(root,'.rivet/protocols'),{recursive:true});
 await writeFile(join(root,'.rivet/protocols',id+'.md'),'---\n'+YAML.stringify(metadata)+'---\n\n'+body);
};
async function boundFixture(t,mode='ignored',client='host'){
 const target=await fixture();t.after(()=>rm(target.parent,{recursive:true,force:true}));
 await writeFile(join(target.root,'.git/info/exclude'),mode==='ignored'?'.rivet/protocols/\n':'');
 await saveProtocol(target.root,'guide',1);
 if(mode!=='ignored'){await git(target.root,'add','.rivet/protocols');await git(target.root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','approved guide');}
 if(mode==='assume-unchanged')await git(target.root,'update-index','--assume-unchanged','.rivet/protocols/guide.md');
 const gitClient=await createGitClient({gitExecutable:await realpath((await execFile('which',['git'])).stdout.trim())});
 const calls={execute:0};
 const workflow=createFeatureWorkflow({gitClient,now:()=>NOW,planningClientFor:async()=>({async propose(contract){return proposal(contract);}}),async executeFeature(){calls.execute++;throw new Error('unexpected execution');}});
 const proposed=await workflow.propose({project:target.root,source:{kind:'file',value:join(target.root,'requests/smart-agenda.md')},client,...(client==='host'?{decomposition:proposal({workRequest:{acceptanceCriteria:['Preserve sessions the attendee already accepted.','Export the resulting agenda as an ICS file.']}})}:{})});
 const start=()=>workflow.start({project:target.root,runId:proposed.runId,expectedVersion:proposed.version,proposalDigest:proposed.proposalDigest});
 return {...target,workflow,gitClient,proposed,start,calls};
}
for(const mode of ['ignored','assume-unchanged'])test(mode+' protocol drift blocks activation and host actions despite clean unchanged baseline',async t=>{
 const f=await boundFixture(t,mode),initial=await f.gitClient.inspectRepository(f.root);
 await saveProtocol(f.root,'guide',2);
 assert.equal((await f.gitClient.inspectRepository(f.root)).dirty,false);
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,initial.headSha);
 await assert.rejects(f.start(),/protocols changed/);
 assert.equal((await f.workflow.status({project:f.root,runId:f.proposed.runId})).status,'proposed');
 await saveProtocol(f.root,'guide',1);const approved=await f.start();
 const host=createHostExecution({gitClient:f.gitClient,now:()=>NOW});
 const prepared=await host.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
 const next=await host.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 assert.ok(next.action);assert.equal(next.protocolContext.sourceRoot,f.root);
 const sealed=JSON.parse(next.action.payload);assert.equal(Object.hasOwn(sealed.contract,'protocolContext'),false);
 await saveProtocol(f.root,'guide',2);
 await assert.rejects(host.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion}),/protocols changed/);
 await assert.rejects(host.submitResult({project:f.root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:{version:1,status:'success',output:{summary:'Done',evidence:sealed.contract.evidence},usage:{tokens:1,costUsd:0}}}),/protocols changed/);
 const status=await host.status({project:f.root,runId:approved.runId});assert.equal(status.protocols.status,'changed');assert.match(status.nextAction,/protocols changed/);assert.equal(status.deliveryReady,false);
});
test('unrelated active protocols preserve selected references and historical source-root lookup needs no worker copy',async t=>{
 const f=await boundFixture(t);const refs=f.proposed.workRequest.contextRefs;
 await saveProtocol(f.root,'unrelated',1);
 const approved=await f.start(),host=createHostExecution({gitClient:f.gitClient,now:()=>NOW});
 const prepared=await host.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
 const next=await host.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 assert.deepEqual((await f.workflow.status({project:f.root,runId:approved.runId})).workRequest.contextRefs,refs);
 const worker=JSON.parse(next.action.payload).contract.worktree.path;
 await assert.rejects(readFile(join(worker,'.rivet/protocols/guide.md')));
 assert.equal(next.protocolContext.lookups.length,1);assert.equal(next.protocolContext.sourceRoot,f.root);
});
test('selected protocol retirement, removal and digest corruption fail closed; spawned resume never dispatches',async t=>{
 const f=await boundFixture(t,'ignored','codex'),approved=await f.start();
 await saveProtocol(f.root,'guide',2,'retired');
 await assert.rejects(f.workflow.resume({project:f.root,runId:approved.runId,expectedVersion:approved.version}),/protocols changed/);assert.equal(f.calls.execute,0);
 for(const content of [null,'corrupt']){
  const path=join(f.root,'.rivet/protocols/guide.md');if(content===null)await rm(path);else await writeFile(path,content);
  assert.throws(()=>assertSelectedProtocolRefs(f.root,approved.workRequest.contextRefs),/protocols changed/);
 }
});

import {createFeatureExecutor} from '../../src/feature/runtime-bridge.js';
test('spawned adapter discovery and later worker launch both enforce selected source revisions',async t=>{
 const f=await boundFixture(t,'ignored','codex'),approved=await f.start();let probes=0,launches=0;
 const gate=join(f.parent,'gate');await writeFile(gate,'#!/bin/sh\nexit 0\n',{mode:0o700});
 let driftDuringProbe=false;
 const executor=createFeatureExecutor({gitClient:f.gitClient,now:()=>NOW,environment:{PATH:process.env.PATH},resolveCommandExecutable:async()=>gate,clientFor:async kind=>{probes++;if(driftDuringProbe)await saveProtocol(f.root,'guide',2);return {provider:kind,async launch(){launches++;throw new Error('must not launch');}};}});
 await saveProtocol(f.root,'guide',2);
 await assert.rejects(executor({project:f.root,run:approved}),/protocols changed/);assert.equal(probes,0);assert.equal(launches,0);
 await saveProtocol(f.root,'guide',1);driftDuringProbe=true;
 const result=await executor({project:f.root,run:approved});assert.equal(result.status,'blocked');assert.equal(probes,1);assert.equal(launches,0);
});

test('protocol drift during a spawned worker cannot commit or integrate its result',async t=>{
 const f=await boundFixture(t,'ignored','codex'),approved=await f.start();
 const gate=join(f.parent,'gate');await writeFile(gate,'#!/bin/sh\nexit 0\n',{mode:0o700});let worker;
 const executor=createFeatureExecutor({gitClient:f.gitClient,now:()=>NOW,environment:{PATH:process.env.PATH},resolveCommandExecutable:async()=>gate,clientFor:async kind=>({provider:kind,async launch(contract){
  worker=contract.worktree.path;await writeFile(join(worker,'app/agenda'),'export const done = true;\n');
  await git(worker,'add','app/agenda');await git(worker,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','worker change');
  await saveProtocol(f.root,'guide',2);
  return {version:1,status:'success',output:{summary:'Implemented',evidence:contract.evidence},usage:{tokens:1,costUsd:0}};
 }})});
 const result=await executor({project:f.root,run:approved});assert.equal(result.status,'blocked');assert.match(result.summary,/new reviewed proposal/);
 const integration=(await f.gitClient.listWorktrees(f.root)).find(tree=>tree.path.endsWith('/integration'));
 const inspected=await f.gitClient.inspectRepository(integration.path);assert.equal(inspected.headSha,approved.featurePlan.baselineCommit);assert.equal(inspected.dirty,false);
 assert.notEqual((await f.gitClient.inspectRepository(worker)).headSha,approved.featurePlan.baselineCommit);
});
