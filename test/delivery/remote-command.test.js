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
