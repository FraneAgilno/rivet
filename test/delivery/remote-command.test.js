import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveStatePaths } from '../../src/state/paths.js';
import { createDeliveryStore } from '../../src/delivery/store.js';
import { createDeliveryService, createTrustedDeliveryExecutor } from '../../src/delivery/service.js';
import { createApprovalRegistry } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { runRemoteDelivery } from '../../src/commands/delivery-remote.js';

const SHA = 'a'.repeat(40),
  BASE = 'b'.repeat(40),
  DIGEST = 'd'.repeat(64);
const githubRepository = {
  provider: 'github',
  host: 'github.com',
  namespace: 'team',
  name: 'repo',
  fullName: 'team/repo',
  url: 'https://github.com/team/repo',
};
async function fixture(t, provider = 'github') {
  const repository =
    provider === 'github'
      ? githubRepository
      : { ...githubRepository, provider: 'gitlab', host: 'gitlab.com', url: 'https://gitlab.com/team/repo' };
  const reviewUrl = repository.url + (provider === 'github' ? '/pull/7' : '/-/merge_requests/7');
  const root = await mkdtemp(join(tmpdir(), 'rivet-remote-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const store = createDeliveryStore(await resolveStatePaths(root, 'delivery-one'));
  const calls = { dispatch: 0, confirm: 0, local: 0, observe: 0 };
  const executor = createTrustedDeliveryExecutor({
    provider,
    capabilities: [{ action: 'merge', conditionalHead: true, reconcile: true }],
    observe: async () => {
      calls.observe++;
      return {
        repositoryUrl: repository.url,
        sourceBranch: 'feature',
        targetBranch: 'main',
        headSha: SHA,
        baseSha: BASE,
        review: { number: 7, state: 'open', url: reviewUrl, headSha: SHA },
        checks: { headSha: SHA, policy: 'known', satisfied: true, evidenceDigest: DIGEST },
        reviews: { headSha: SHA, policy: 'known', satisfied: true, evidenceDigest: DIGEST },
        observedAt: new Date().toISOString(),
      };
    },
    dispatch: async (op) => {
      calls.dispatch++;
      return {
        status: 'succeeded',
        operationDigest: op.digest,
        headSha: SHA,
        evidenceDigest: DIGEST,
        resourceUrl: reviewUrl,
        commitSha: BASE,
      };
    },
    reconcile: async () => ({ status: 'unknown' }),
  });
  await createDeliveryService({
    store,
    executor,
    providerId: 'github-team',
    subjectId: 'delivery-cli',
    expectedApproverId: 'terminal-human',
    authority: createAuthorityEnvelope({
      actorId: 'delivery-cli',
      principal: 'agent',
      actions: [],
      ownedPaths: [],
      providers: [],
      commands: [],
    }),
    approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'terminal-human', principal: 'human' }] }),
  }).initialize({
    runId: 'run-one',
    repository,
    sourceBranch: 'feature',
    targetBranch: 'main',
    localVerification: {
      runId: 'run-one',
      status: 'passed',
      headSha: SHA,
      evidenceDigest: DIGEST,
      verifiedAt: new Date().toISOString(),
    },
  });
  const config = {
    project: { id: 'demo' },
    providers: {
      providers: [
        {
          id: 'github-team',
          kind: 'git-ci',
          mode: 'read-write-with-approval',
          transport: 'direct-api',
          capabilities: ['repository-read', 'checks-read', 'merge'],
          projectIds: ['demo'],
          resourceIds: ['team/repo'],
          endpoint: provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com/api/v4',
          credentials: { tokenEnv: 'RIVET_TEST_TOKEN' },
        },
      ],
    },
  };
  const dependencies = {
    env: { RIVET_TEST_TOKEN: 'dummy-fixture-value' },
    terminalIsInteractive: () => true,
    output: { log() {} },
    confirmDelivery: async (preview) => {
      calls.confirm++;
      assert.equal(preview.candidate.headSha, SHA);
      assert.equal(preview.proposal.payload.reviewNumber, 7);
      return true;
    },
    delivery: { executorFactory: () => executor },
  };
  const input = {
    action: 'merge',
    store,
    config,
    flags: {},
    dependencies,
    validateLocal: async () => {
      calls.local++;
    },
  };
  return { input, calls, store, root };
}
test('remote merge requires scoped provider and exact interactive approval then persists actual result', async (t) => {
  const f = await fixture(t);
  const result = await runRemoteDelivery(f.input);
  assert.equal(result.stage, 'merged');
  assert.equal(result.operations[0].receipt.commitSha, BASE);
  assert.equal(f.calls.confirm, 1);
  assert.equal(f.calls.dispatch, 1);
  assert.equal(f.calls.local, 2);
  assert.equal((await runRemoteDelivery(f.input)).stage, 'merged');
  assert.equal(f.calls.dispatch, 1);
  assert.equal(f.calls.confirm, 1);
});
test('noninteractive and JSON merges stop before any network or approval', async (t) => {
  for (const change of [
    (i) => {
      i.dependencies.terminalIsInteractive = () => false;
    },
    (i) => {
      i.flags.json = true;
    },
  ]) {
    const f = await fixture(t);
    change(f.input);
    await assert.rejects(() => runRemoteDelivery(f.input));
    assert.equal(f.calls.observe, 0);
    assert.equal(f.calls.dispatch, 0);
    assert.equal(f.calls.confirm, 0);
  }
});
test('declined approval and local drift after confirmation never dispatch', async (t) => {
  const declined = await fixture(t);
  declined.input.dependencies.confirmDelivery = async () => false;
  await assert.rejects(() => runRemoteDelivery(declined.input));
  assert.equal(declined.calls.dispatch, 0);
  const drift = await fixture(t);
  drift.input.validateLocal = async () => {
    if (++drift.calls.local === 2) throw new Error('changed');
  };
  await assert.rejects(() => runRemoteDelivery(drift.input));
  assert.equal(drift.calls.dispatch, 0);
});
test('read-only, ambiguous or wrong-scope providers cannot authorize merge', async (t) => {
  for (const change of [
    (p) => {
      p[0].mode = 'read-only';
    },
    (p) => {
      p.push({ ...p[0], id: 'second' });
    },
    (p) => {
      p[0].resourceIds = ['other/repo'];
    },
  ]) {
    const f = await fixture(t);
    change(f.input.config.providers.providers);
    await assert.rejects(() => runRemoteDelivery(f.input));
    assert.equal(f.calls.observe, 0);
    assert.equal(f.calls.dispatch, 0);
  }
});
test('refresh updates observations without prompting or dispatching', async (t) => {
  const f = await fixture(t);
  f.input.action = 'refresh';
  f.input.config.providers.providers[0].mode = 'read-only';
  const result = await runRemoteDelivery(f.input);
  assert.equal(result.stage, 'checks-passed');
  assert.equal(f.calls.confirm, 0);
  assert.equal(f.calls.dispatch, 0);
});

test('GitLab CLI uses scoped endpoint, merge method default and MR URL', async (t) => {
  const f = await fixture(t, 'gitlab');
  const logs = [];
  f.input.dependencies.output.log = (line) => logs.push(line);
  const result = await runRemoteDelivery(f.input);
  assert.equal(result.stage, 'merged');
  assert.equal(result.operations[0].payload.mergeMethod, 'merge');
  assert.equal(f.calls.confirm, 1);
  assert.ok(logs.some((line) => line.includes('https://gitlab.com/team/repo/-/merge_requests/7')));
});
test('GitLab refuses unsupported methods and mismatched provider endpoint before reads', async (t) => {
  for (const method of ['squash', 'rebase']) {
    const f = await fixture(t, 'gitlab');
    f.input.flags.method = method;
    await assert.rejects(() => runRemoteDelivery(f.input));
    assert.equal(f.calls.observe, 0);
    assert.equal(f.calls.confirm, 0);
  }
  const f = await fixture(t, 'gitlab');
  f.input.config.providers.providers[0].endpoint = 'https://api.github.com';
  await assert.rejects(() => runRemoteDelivery(f.input));
  assert.equal(f.calls.observe, 0);
});

async function deploymentFixture(t) {
  const f = await fixture(t);
  await runRemoteDelivery(f.input);
  f.input.action = 'deploy';
  f.input.config.project.deployment = { providerId: 'github-team', workflow: 'rivet-deploy.yml', environment: 'staging', productionEnvironment: false };
  f.input.config.providers.providers[0].capabilities.push('deploy', 'deployments-read', 'actions-read');
  f.input.dependencies.confirmDelivery = async state => {
    f.calls.confirm++;
    assert.equal(state.proposal.action, 'deploy');
    assert.equal(state.proposal.mergeReceipt.commitSha, BASE);
    assert.deepEqual(state.proposal.payload, {workflow:'rivet-deploy.yml',environment:'staging',productionEnvironment:false});
    return true;
  };
  f.input.dependencies.delivery.deploymentExecutorFactory = config => {
    assert.equal(config.mergeReceipt.commitSha, BASE);
    return createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'deploy',conditionalHead:true,reconcile:true}],
      observe:async()=> ({...(await f.store.read()).observation,review:{number:7,state:'merged',url:githubRepository.url+'/pull/7',headSha:SHA},observedAt:new Date().toISOString()}),
      dispatch:async op=> {f.calls.dispatch++; throw new Error('deployment running');},
      reconcile:async op=>({status:'succeeded',receipt:{status:'succeeded',operationDigest:op.digest,headSha:SHA,evidenceDigest:DIGEST,resourceUrl:githubRepository.url+'/actions/runs/1',commitSha:BASE}})});
  };
  return f;
}
test('deployment uses configured target and separate approval, then reconciles without dispatching again', async t => {
  const f = await deploymentFixture(t);
  let state = await runRemoteDelivery(f.input);
  assert.equal(state.stage, 'merged');
  assert.equal(state.operations.at(-1).state, 'indeterminate');
  assert.equal(f.calls.confirm, 2);
  assert.equal(f.calls.dispatch, 2);
  assert.equal(f.calls.local, 2);
  f.input.action = 'reconcile';
  f.input.config.providers.providers[0].mode = 'read-only';
  state = await runRemoteDelivery(f.input);
  assert.equal(state.stage, 'deployed');
  assert.equal(f.calls.dispatch, 2);
});
test('deployment rejects unattended approval, missing configuration, unsupported authority and provider override', async t => {
  for (const edit of [
    i => {i.dependencies.terminalIsInteractive=()=>false;},
    i => {i.flags.json=true;},
    i => {delete i.config.project.deployment;},
    i => {i.config.providers.providers[0].capabilities=['repository-read','checks-read','merge'];},
    i => {i.config.providers.providers[0].mode='read-only';},
    i => {i.flags.provider='another-provider';},
  ]) {
    const f=await deploymentFixture(t); edit(f.input);
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.calls.dispatch,1);
    assert.equal(f.calls.confirm,1);
  }
});
test('deployment denial and configuration drift after approval never dispatch', async t => {
  for (const drift of [false,true]) {
    const f=await deploymentFixture(t);
    f.input.dependencies.confirmDelivery=async()=> {
      if(drift) f.input.config.project.deployment.environment='production';
      return drift;
    };
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.calls.dispatch,1);
  }
});

test('deployment reloads disk configuration after approval and rejects changed target or authority', async t => {
  for (const edit of [c=>{c.project.deployment.environment='production';}, c=>{c.providers.providers[0].mode='read-only';}]) {
    const f=await deploymentFixture(t);
    const path=join(f.root,'reload-config.json');
    await writeFile(path,JSON.stringify(f.input.config));
    let reloads=0;
    f.input.reloadConfig=async()=> {reloads++;return JSON.parse(await readFile(path,'utf8'));};
    f.input.dependencies.confirmDelivery=async()=>{
      const changed=structuredClone(f.input.config);edit(changed);
      await writeFile(path,JSON.stringify(changed));return true;
    };
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(reloads,1);
    assert.equal(f.calls.dispatch,1);
  }
});

async function trackerFixture(t) {
  const f = await fixture(t);
  await runRemoteDelivery(f.input);
  f.input.action='tracker-update';
  const target={kind:'jira',issueKey:'ENG-7',issueUrl:'https://team.atlassian.net/browse/ENG-7',requestDigest:DIGEST};
  f.input.loadTrackerTarget=async()=>target;
  f.input.config.providers.providers.push({id:'jira-team',kind:'jira',mode:'read-write-with-approval',transport:'direct-api',
    capabilities:['issues-read','comments-read','tracker-update'],projectIds:['demo'],resourceIds:['ENG-7'],endpoint:'https://team.atlassian.net',
    credentials:{usernameEnv:'JIRA_USER',apiTokenEnv:'JIRA_TOKEN'}});
  Object.assign(f.input.dependencies.env,{JIRA_USER:'fixture@example.com',JIRA_TOKEN:'dummy-fixture-value'});
  f.input.dependencies.confirmDelivery=async state=>{
    f.calls.confirm++;
    assert.equal(state.proposal.action,'tracker-update');
    assert.equal(state.proposal.payload.issueKey,'ENG-7');
    assert.equal(state.proposal.payload.mergeCommit,BASE);
    return true;
  };
  f.input.dependencies.delivery.trackerFactory=async input=>{
    assert.deepEqual(input.target,target);
    assert.equal(input.providerId,'jira-team');
    assert.equal(input.mergeReceipt.commitSha,BASE);
    const payload={...target,issueInternalId:'1007',providerId:'jira-team',endpoint:'https://team.atlassian.net',mergeCommit:BASE,
      reviewUrl:githubRepository.url+'/pull/7',deploymentUrl:null};
    return {payload,preview:'Merged commit '+BASE,executor:createTrustedDeliveryExecutor({provider:'github',
      capabilities:[{action:'tracker-update',conditionalHead:true,reconcile:true}],
      observe:async()=>({... (await f.store.read()).observation,review:{number:7,state:'merged',url:githubRepository.url+'/pull/7',headSha:SHA},observedAt:new Date().toISOString()}),
      dispatch:async()=>{f.calls.dispatch++;throw new Error('response lost');},
      reconcile:async op=>({status:'succeeded',receipt:{status:'succeeded',operationDigest:op.digest,headSha:SHA,evidenceDigest:DIGEST,resourceUrl:target.issueUrl,commitSha:BASE}})})};
  };
  return f;
}
test('tracker update approves the recorded source issue and reconciles with its original provider', async t=>{
  const f=await trackerFixture(t);
  let state=await runRemoteDelivery(f.input);
  assert.equal(state.stage,'merged');
  assert.equal(state.operations.at(-1).state,'indeterminate');
  assert.equal(f.calls.dispatch,2);
  assert.equal(f.calls.confirm,2);
  f.input.action='reconcile';
  f.input.config.providers.providers[1].mode='read-only';
  f.input.config.providers.providers.push({...f.input.config.providers.providers[1],id:'another-jira'});
  state=await runRemoteDelivery(f.input);
  assert.equal(state.stage,'tracker-updated');
  assert.equal(f.calls.dispatch,2);
  assert.equal(f.calls.local,2);
});
test('tracker update rejects unattended writes, missing source and incorrect provider scope',async t=>{
  for(const edit of [
    i=>{i.flags.json=true;}, i=>{i.dependencies.terminalIsInteractive=()=>false;},
    i=>{i.dependencies.confirmDelivery=async()=>false;},
    i=>{i.loadTrackerTarget=async()=>{throw new Error('no tracker source');};},
    i=>{i.config.providers.providers[1].resourceIds=['ENG-8'];},
    i=>{i.config.providers.providers[1].mode='read-only';},
    i=>{i.config.providers.providers[1].capabilities=['issues-read'];},
  ]) {
    const f=await trackerFixture(t);edit(f.input);
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.calls.dispatch,1);
    assert.equal(f.calls.confirm,1);
  }
});
test('tracker provider revocation on disk or source drift during approval prevents dispatch',async t=>{
  for(const sourceDrift of [false,true]) {
    const f=await trackerFixture(t);
    f.input.reloadConfig=async()=>{
      const updated=structuredClone(f.input.config);updated.providers.providers[1].mode='read-only';return updated;
    };
    if(sourceDrift){
      f.input.reloadConfig=async()=>f.input.config;
      f.input.dependencies.confirmDelivery=async()=>{f.input.loadTrackerTarget=async()=>({kind:'jira',issueKey:'ENG-8',issueUrl:'https://team.atlassian.net/browse/ENG-8',requestDigest:DIGEST});return true;};
      let n=0;const original=f.input.loadTrackerTarget;
      f.input.loadTrackerTarget=async()=>++n===1 ? original() : {kind:'jira',issueKey:'ENG-8',issueUrl:'https://team.atlassian.net/browse/ENG-8',requestDigest:DIGEST};
    }
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.calls.dispatch,1);
  }
});

async function transitionFixture(t) {
  const f = await trackerFixture(t);
  f.input.action = 'tracker-transition';
  f.input.config.providers.providers[1].capabilities.push('transitions-read', 'tracker-transition');
  f.lines = []; f.input.dependencies.output.log = line => f.lines.push(line);
  f.destinations = [
    {id:'31', name:'Complete work', state:{id:'3',name:'Done',type:'done'}, eligible:true},
    {id:'32', name:'Approve work', state:{id:'3',name:'Done',type:'done'}, eligible:true},
    {id:'33', name:'Complete with resolution', state:{id:'3',name:'Done',type:'done'}, eligible:false,reason:'requires-fields-or-screen'},
  ];
  f.input.dependencies.selectTrackerDestination = async choices => { assert.equal(choices.length,2); return 1; };
  f.input.dependencies.confirmDelivery = async state => {
    f.calls.confirm++; assert.equal(state.proposal.action,'tracker-transition');
    assert.equal(state.proposal.payload.destination.id,'32'); return true;
  };
  f.input.dependencies.delivery.transitionFactory = async input => {
    f.calls.intake = (f.calls.intake ?? 0)+1;
    const target = await f.input.loadTrackerTarget();
    const status={target,current:{id:'1',name:'In progress',type:'indeterminate'},destinations:f.destinations};
    const prepared = id => {
      f.selected=id;
      const payload=input.persistedPayload ?? {...target,providerId:input.providerId,endpoint:input.baseUrl,mergeCommit:BASE,destination:f.destinations.find(d=>d.id===id)};
      return {payload,alreadyDesired:f.alreadyDesired??false,preview:'ENG-7: In progress -> Done (Approve work)',executor:createTrustedDeliveryExecutor({provider:'github',
        capabilities:[{action:'tracker-transition',conditionalHead:false,verifiesDesiredState:true,reconcile:true}],
        observe:async()=>({... (await f.store.read()).observation,review:{number:7,state:'merged',url:githubRepository.url+'/pull/7',headSha:SHA},observedAt:new Date().toISOString()}),
        dispatch:async op=>{f.calls.dispatch++;if(f.lost)throw new Error('lost response');return {status:'succeeded',operationDigest:op.digest,headSha:SHA,evidenceDigest:DIGEST,resourceUrl:target.issueUrl,commitSha:BASE};},
        reconcile:async op=>({status:'succeeded',receipt:{status:'succeeded',operationDigest:op.digest,headSha:SHA,evidenceDigest:DIGEST,resourceUrl:target.issueUrl,commitSha:BASE}})})};
    };
    return input.persistedPayload ? prepared(input.persistedPayload.destination.id) : {status,select:async id=>prepared(id)};
  };
  return f;
}
test('tracker-status reads destinations without changing the journal or requesting write approval',async t=>{
  const f=await transitionFixture(t), before=await f.store.read();
  f.input.action='tracker-status';f.input.flags.json=true;
  f.input.dependencies.terminalIsInteractive=()=>false;
  f.input.config.providers.providers[1].mode='read-only';
  f.input.config.providers.providers[1].capabilities=['issues-read','transitions-read'];
  const result=await runRemoteDelivery(f.input);
  assert.equal(result.trackerStatus.current.name,'In progress');
  assert.deepEqual(await f.store.read(),before);assert.equal(f.calls.confirm,1);assert.equal(f.calls.dispatch,1);
});
test('numbered tracker choice keeps equal destination names distinct and records confirmed state',async t=>{
  const f=await transitionFixture(t),result=await runRemoteDelivery(f.input);
  assert.equal(f.selected,'32');assert.equal(result.stage,'tracker-status-confirmed');
  assert.equal(result.operations.at(-1).action,'tracker-transition');
  assert.equal(f.calls.dispatch,2);assert.equal(f.calls.confirm,2);
  assert.ok(f.lines.some(line=>line.includes('1. Done')&&line.includes('Complete work')));
  assert.ok(f.lines.some(line=>line.includes('2. Done')&&line.includes('Approve work')));
  assert.ok(f.lines.some(line=>line.includes('precheck')&&line.includes('atomic')));
});
test('tracker transition rejects unattended, invalid selection, declined approval and post-approval drift',async t=>{
  for(const edit of [
    f=>{f.input.flags.json=true;}, f=>{f.input.dependencies.terminalIsInteractive=()=>false;},
    f=>{f.input.dependencies.selectTrackerDestination=async()=>null;},
    f=>{f.input.dependencies.selectTrackerDestination=async()=>99;},
    f=>{f.input.dependencies.confirmDelivery=async()=>false;},
    f=>{f.input.reloadConfig=async()=>{const c=structuredClone(f.input.config);c.providers.providers[1].mode='read-only';return c;};},
    f=>{let approved=false;const original=f.input.loadTrackerTarget;f.input.dependencies.confirmDelivery=async()=>{approved=true;return true;};f.input.loadTrackerTarget=async()=>approved?{kind:'jira',issueKey:'ENG-8',issueUrl:'https://team.atlassian.net/browse/ENG-8',requestDigest:DIGEST}:original();},
  ]) {const f=await transitionFixture(t);edit(f);await assert.rejects(runRemoteDelivery(f.input));assert.equal(f.calls.dispatch,1);}
});
test('already desired tracker state is a no-op without proposal, approval or fabricated receipt',async t=>{
  const f=await transitionFixture(t),before=await f.store.read();f.alreadyDesired=true;
  const result=await runRemoteDelivery(f.input);
  assert.equal(result.trackerTransitionNoop,true);assert.deepEqual(await f.store.read(),before);
  assert.equal(f.calls.dispatch,1);assert.equal(f.calls.confirm,1);
});
test('pending tracker transition reopens for read-only reconciliation and is never resent',async t=>{
  const f=await transitionFixture(t);f.lost=true;
  let state=await runRemoteDelivery(f.input);assert.equal(state.operations.at(-1).state,'indeterminate');
  await assert.rejects(runRemoteDelivery(f.input));assert.equal(f.calls.dispatch,2);
  f.input.action='reconcile';f.input.config.providers.providers[1].mode='read-only';
  state=await runRemoteDelivery(f.input);assert.equal(state.stage,'tracker-status-confirmed');assert.equal(f.calls.dispatch,2);
});
test('tracker comments and transitions preserve both receipts in either order',async t=>{
  for(const transitionFirst of [true,false]) {
    const f=await transitionFixture(t),transitionConfirm=f.input.dependencies.confirmDelivery;
    const comment=async()=>{
      f.input.action='tracker-update';f.input.dependencies.confirmDelivery=async()=>true;
      await runRemoteDelivery(f.input);f.input.action='reconcile';await runRemoteDelivery(f.input);
    };
    const transition=async()=>{f.input.action='tracker-transition';f.input.dependencies.confirmDelivery=transitionConfirm;await runRemoteDelivery(f.input);};
    if(transitionFirst){await transition();await comment();}else{await comment();await transition();}
    const state=await f.store.read();assert.equal(state.stage,'tracker-status-confirmed');
    assert.deepEqual(state.operations.filter(op=>op.state==='succeeded').map(op=>op.action).sort(),['merge','tracker-transition','tracker-update']);
  }
});

test('indistinguishable tracker destinations fail closed without exposing an opaque-ID selector',async t=>{
  const f=await transitionFixture(t);f.destinations[1]={...f.destinations[0],id:'32'};
  let selected=false;f.input.dependencies.selectTrackerDestination=async()=>{selected=true;return 0;};
  await assert.rejects(runRemoteDelivery(f.input));
  assert.equal(selected,false);assert.equal(f.calls.dispatch,1);
});
