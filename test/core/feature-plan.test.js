import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentContractError } from '../../src/clients/contract.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { createFeaturePlan } from '../../src/feature/plan-contract.js';
import { FeaturePlanError, createFeaturePlanner, featurePlanDigest } from '../../src/feature/planner.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const CONFIG_ROOT = new URL('../fixtures/config/valid/', import.meta.url).pathname;
const BASELINE = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2029-01-01T00:00:00.000Z';

function request() {
  return createWorkRequest({
    source: { kind: 'linear', ref: 'DEMO-123', revision: 'v1' },
    title: 'Smart agenda builder',
    description: 'Recommend a conflict-free conference agenda and export it.',
    acceptanceCriteria: ['Preserve accepted sessions', 'Export the agenda as ICS'],
    contextRefs: ['linear:DEMO-124'],
    capturedAt: NOW,
  });
}

function budget(timeMinutes, tokenLimit, costUsd, taskLimit) {
  return { timeMinutes, tokenLimit, costUsd, taskLimit };
}

function decomposition(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement deterministic agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement deterministic ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
    ...overrides,
  };
}

async function configuration() { return loadProjectConfig(CONFIG_ROOT); }

test('accepts one strict proposal and gives the planning client only an immutable read-only policy contract', async () => {
  const config = await configuration();
  const workRequest = request();
  let received;
  const planner = createFeaturePlanner({
    planningClient: Object.freeze({
      async propose(contract) {
        received = contract;
        assert.equal(Object.isFrozen(contract), true);
        assert.equal(Object.isFrozen(contract.policy.roles), true);
        assert.equal(JSON.stringify(contract).includes('ATLASSIAN_API_TOKEN'), false);
        assert.equal(contract.workRequest.digest, workRequest.digest);
        return decomposition();
      },
    }),
  });

  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });

  assert.equal(received.policy.defaultBranch, 'main');
  assert.equal(plan.nodes.filter(node => node.role === 'worker').length, 2);
  assert.equal(plan.id, 'smart-agenda-builder');
  assert.deepEqual(plan.providerRefs, ['git-ci-main']);
  assert.deepEqual(plan.nodes.map(node => node.id), [
    'activation', 'management', 'implement-deterministic-agenda-recommendations',
    'implement-deterministic-ics-export', 'final-delivery',
  ]);
  assert.deepEqual(plan.nodes[3].dependencies, ['implement-deterministic-agenda-recommendations']);
  assert.deepEqual(plan.nodes[4].dependencies, [
    'implement-deterministic-agenda-recommendations', 'implement-deterministic-ics-export',
  ]);
  assert.deepEqual(plan.nodes[2].acceptanceCriteria, ['Preserve accepted sessions']);
  assert.deepEqual(plan.nodes[3].acceptanceCriteria, ['Export the agenda as ICS']);
  assert.deepEqual(plan.nodes[2].commandIds, ['build', 'test', 'lint']);
  assert.match(featurePlanDigest(plan), /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.nodes[0]), true);
});

test('binds the exact bounded Sonnet profile into Claude proposals and rejects profile drift', async () => {
  const config = await configuration();
  const workRequest = request();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition() } });
  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'claude' });

  assert.deepEqual(JSON.parse(JSON.stringify(plan.clientProfile)), {
    schemaVersion: 1,
    id: 'claude-bounded-sonnet-v1',
    provider: 'claude',
    model: 'sonnet',
    planning: { effort: 'low', timeoutMs: 120_000, maxCostUsd: 1 },
    execution: { maxCostUsd: 2 },
    fallbackModel: null,
  });
  assert.ok(Object.isFrozen(plan.clientProfile));
  assert.ok(Object.isFrozen(plan.clientProfile.planning));

  for (const mutate of [
    value => { value.clientProfile.model = 'fable'; },
    value => { value.clientProfile.planning.timeoutMs = 30_000; },
    value => { value.clientProfile.planning.maxCostUsd = 10; },
    value => { value.clientProfile.execution.maxCostUsd = 20; },
    value => { value.clientProfile.fallbackModel = 'haiku'; },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => createFeaturePlan({
      proposal: changed, config, workRequest, baselineCommit: BASELINE, client: 'claude',
    }), FeaturePlanError);
  }

  const codexPlan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });
  const widenedCodexPlan = structuredClone(codexPlan);
  widenedCodexPlan.clientProfile = structuredClone(plan.clientProfile);
  assert.throws(() => createFeaturePlan({
    proposal: widenedCodexPlan, config, workRequest, baselineCommit: BASELINE, client: 'codex',
  }), FeaturePlanError);
});

test('allows cross-cutting acceptance criteria to support multiple work items', async () => {
  const config = await configuration();
  const workRequest = request();
  const sharedAcceptance = decomposition({
    workItems: [
      {
        objective: 'Implement deterministic agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Add focused agenda recommendation tests.',
        ownedPaths: ['test/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement deterministic ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  });
  const planner = createFeaturePlanner({ planningClient: { propose: async () => sharedAcceptance } });

  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });

  assert.deepEqual(
    plan.nodes.filter(node => node.role === 'worker').map(node => node.acceptanceCriteria),
    [
      ['Preserve accepted sessions'],
      ['Preserve accepted sessions'],
      ['Export the agenda as ICS'],
    ],
  );
});

test('rejects malformed decomposition, policy-field injection, unsafe paths, and invalid acceptance allocation', async t => {
  const config = await configuration();
  const workRequest = request();
  const cases = [
    ['full governed plan', value => Object.assign(value, { id: 'model-owned-plan', nodes: [] })],
    ['authority expansion', value => { value.workItems[0].authorityScopes = ['merge']; }],
    ['budget expansion', value => { value.workItems[0].budget = budget(999, 999, 999, 999); }],
    ['repository mutation', value => { value.workItems[0].ownedPaths = ['.git/config']; }],
    ['sensitive path', value => { value.workItems[0].ownedPaths = ['config/private/key.txt']; }],
    ['empty acceptance trace', value => { value.workItems[1].acceptanceCriterionIndexes = []; }],
    ['missing acceptance coverage', value => { value.workItems[1].acceptanceCriterionIndexes = [1]; }],
    ['out-of-range acceptance trace', value => { value.workItems[1].acceptanceCriterionIndexes = [3]; }],
    ['invalid result kind', value => { value.kind = 'agilno.feature-plan'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = structuredClone(decomposition());
      const returned = mutate(value) ?? value;
      const planner = createFeaturePlanner({ planningClient: { propose: async () => returned } });
      await assert.rejects(
        () => planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' }),
        error => error instanceof FeaturePlanError && !JSON.stringify(error).includes('config/private'),
      );
    });
  }
});

test('preserves safe provider-output failures instead of masking them as invalid feature plans', async () => {
  const config = await configuration();
  const workRequest = request();
  const providerError = new AgentContractError('output-invalid');
  const planner = createFeaturePlanner({ planningClient: { propose: async () => { throw providerError; } } });

  await assert.rejects(
    () => planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' }),
    error => error === providerError && error.code === 'ERR_AGENT_OUTPUT_INVALID',
  );
});

test('rejects unvalidated requests and malformed planning clients before invoking a model', async () => {
  const config = await configuration();
  assert.throws(() => createFeaturePlanner({ planningClient: {} }), FeaturePlanError);
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition() } });
  await assert.rejects(
    () => planner.propose({ config, workRequest: { digest: 'f'.repeat(64) }, baselineCommit: BASELINE, client: 'codex' }),
    FeaturePlanError,
  );
});


test('repairs a rejected owned path once using safe feedback and validates the replacement', async () => {
  const config = await configuration();
  const workRequest = request();
  const contracts = [];
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    contracts.push(contract);
    const value = decomposition();
    if (contracts.length === 1) value.workItems[0].ownedPaths = ['config/private/key.txt'];
    return value;
  } } });
  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'claude' });
  assert.equal(contracts.length, 2);
  assert.equal(contracts[1].repair.reason, 'owned-path-protected');
  assert.equal(contracts[1].repair.attempt, 2);
  assert.ok(Object.isFrozen(contracts[1].repair));
  assert.deepEqual(contracts[1].policy, contracts[0].policy);
  assert.deepEqual(contracts[1].workRequest, contracts[0].workRequest);
  assert.deepEqual(plan.nodes[2].ownedPaths, ['app/agenda']);
});

test('stops after one repair and reports a safe concrete path failure', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async () => {
    calls += 1;
    const value = decomposition();
    value.workItems[0].ownedPaths = ['config/private/key.txt'];
    return value;
  } } });
  await assert.rejects(() => planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' }), error => {
    assert.equal(error.details.reason, 'compiled-plan-invalid');
    assert.equal(error.details.violation, 'owned-path-protected');
    assert.match(error.safeMessage, /protected/);
    assert.ok(!JSON.stringify(error).includes('key.txt'));
    return true;
  });
  assert.equal(calls, 2);
});

test('repairs case-insensitive path collisions without silently dropping owned files', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    calls += 1;
    const value = decomposition();
    if (calls === 1) value.workItems[0].ownedPaths = ['app/Page.tsx', 'app/page.tsx'];
    else assert.equal(contract.repair.reason, 'owned-path-duplicate');
    return value;
  } } });
  await planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'codex' });
  assert.equal(calls, 2);
});


test('never retries a provider failure or accepts a malformed repair', async () => {
  const config = await configuration();
  for (const scenario of ['provider', 'repair']) {
    let calls = 0;
    const planner = createFeaturePlanner({ planningClient: { propose: async () => {
      calls += 1;
      if (scenario === 'provider') throw new AgentContractError('output-invalid');
      const value = decomposition();
      if (calls === 1) value.workItems[0].ownedPaths = ['.git/config'];
      else value.workItems[0].authorityScopes = ['merge'];
      return value;
    } } });
    await assert.rejects(() => planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' }),
      error => scenario === 'provider' ? error instanceof AgentContractError : error.details.reason === 'decomposition-invalid');
    assert.equal(calls, scenario === 'provider' ? 1 : 2);
  }
});

test('repairs reserved path components', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    calls += 1;
    const value = decomposition();
    if (calls === 1) value.workItems[0].ownedPaths = ['app/con.ts'];
    else assert.equal(contract.repair.reason, 'owned-path-invalid');
    return value;
  } } });
  await planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' });
  assert.equal(calls, 2);
});
