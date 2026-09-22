import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createFakeClient } from '../../src/clients/fake.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { validateEvent } from '../../src/config/validate.js';
import { graphFixture } from '../../src/graph/fixtures.js';
import { createOrchestrator, RuntimeError, runtimeTransaction } from '../../src/runtime/orchestrator.js';
import { createHeartbeat, heartbeatStatus } from '../../src/runtime/heartbeat.js';
import { createRetryPolicy, retryDecision, retryPolicySchedule } from '../../src/runtime/retry.js';
import { SupervisorError, watchOrchestration } from '../../src/runtime/supervisor.js';

const NOW = Date.parse('2029-01-01T00:00:00.000Z');

function node(id, dependencies = [], overrides = {}) {
  return {
    id, parentId: 'manager-plan', objective: `Complete ${id}`, owner: { role: 'worker', id: `${id}-worker` },
    dependencies, authorityScopes: ['implement', 'verify'],
    budget: { timeMinutes: 10, tokenLimit: 1000, costUsd: 1, taskLimit: 1 },
    completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'],
    evidenceRefs: [`${id}-commit`, `${id}-test`], status: 'ready', ...overrides,
  };
}

function graph(nodes = [node('design'), node('api'), node('integration', ['design', 'api'], {
  requiredEvidenceTypes: ['commit', 'test', 'journey'], evidenceRefs: ['integration-commit', 'integration-test', 'integration-journey'],
})]) {
  const parentBudget = { timeMinutes: 100, tokenLimit: 10_000, costUsd: 10, taskLimit: 10 };
  const boss = node('boss-plan', [], { owner: { role: 'boss', id: 'portfolio-boss' }, budget: parentBudget, status: 'completed' });
  delete boss.parentId;
  return {
    schemaVersion: 1, id: 'demo-graph', goal: 'Deliver demo', providerRefs: ['git-ci-main'], maxDelegationDepth: 3,
    status: 'running', nodes: [
      boss,
      { ...node('manager-plan', ['boss-plan'], { parentId: 'boss-plan', owner: { role: 'manager', id: 'engineering-manager' }, budget: parentBudget, status: 'completed' }) },
      ...nodes,
      { ...node('human-final', ['integration'], { parentId: 'boss-plan', owner: { role: 'boss', id: 'portfolio-boss' }, authorityScopes: ['verify'], completionProfile: 'delivery', requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], approvalGate: 'final-delivery', status: 'completed' }) },
    ],
  };
}

function lifecycleGraph() {
  const parentBudget = { timeMinutes: 100, tokenLimit: 10_000, costUsd: 10, taskLimit: 10 };
  const bossBudget = { timeMinutes: 200, tokenLimit: 20_000, costUsd: 20, taskLimit: 20 };
  const boss = node('boss-plan', [], { owner: { role: 'boss', id: 'portfolio-boss' }, budget: bossBudget, authorityScopes: ['implement', 'verify'], completionProfile: 'delivery', requiredEvidenceTypes: ['commit', 'test', 'review'], evidenceRefs: ['boss-commit', 'boss-test', 'boss-review'], status: 'ready' });
  delete boss.parentId;
  return {
    schemaVersion: 1, id: 'lifecycle-graph', goal: 'Deliver the complete demo', providerRefs: ['git-ci-main'], maxDelegationDepth: 3, status: 'approved',
    nodes: [
      boss,
      { ...node('manager-plan', ['boss-plan'], { parentId: 'boss-plan', owner: { role: 'manager', id: 'engineering-manager' }, budget: parentBudget, status: 'ready' }) },
      node('api', ['manager-plan']), node('design', ['manager-plan']),
      node('integration', ['api', 'design'], { requiredEvidenceTypes: ['commit', 'test', 'journey'], evidenceRefs: ['integration-commit', 'integration-test', 'integration-journey'] }),
      node('human-final', ['integration'], { parentId: 'boss-plan', owner: { role: 'boss', id: 'portfolio-boss' }, authorityScopes: ['verify'], completionProfile: 'delivery', requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], approvalGate: 'final-delivery' }),
    ],
  };
}

function memoryInstance(initial = {}) {
  let locked = false;
  let state = structuredClone({
    schemaVersion: 1, version: 0, activated: false, terminal: null, graph: graph(), events: [],
    attempts: {}, launchIntents: {}, results: {}, heartbeats: {}, evidence: [],
    usage: { tokens: 0, costUsd: 0, retries: 0, timeMinutes: 0, taskLimit: 0 },
    limits: { tokens: 10000, costUsd: 10, retries: 2 }, ...initial,
  });
  const observations = { startsWhileLocked: 0, releases: 0, commits: 0 };
  return {
    id: 'demo-instance', observations,
    async acquire() {
      assert.equal(locked, false); locked = true;
      let released = false;
      return { release: async () => { if (!released) { released = true; locked = false; observations.releases += 1; } } };
    },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expectedVersion, next) {
      assert.equal(locked, true);
      if (state.version !== expectedVersion) { const error = new Error('conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error; }
      state = structuredClone(next); observations.commits += 1; return structuredClone(state);
    },
    inspect() { return structuredClone(state); },
    locked() { return locked; },
  };
}

function coordinatedMemoryInstance(initial = {}, { loserObserves = 'prepared' } = {}) {
  let locked = false; let coordinationStage = null; const queue = [];
  let state = structuredClone({
    schemaVersion: 1, version: 0, activated: false, terminal: null, graph: graph(), events: [],
    attempts: {}, launchIntents: {}, results: {}, heartbeats: {}, evidence: [],
    usage: { tokens: 0, costUsd: 0, retries: 0, timeMinutes: 0, taskLimit: 0 }, limits: { tokens: 10000, costUsd: 10, retries: 2 }, ...initial,
  });
  const observations = { releases: 0, commits: 0 };
  function drain() {
    if (locked || queue.length === 0) return;
    if (['prepared', 'winner-commit'].includes(coordinationStage) && queue.length < 2) return;
    let index = 0;
    if (coordinationStage === 'prepared' || coordinationStage === 'winner-commit') { index = 1; coordinationStage = null; }
    else if (coordinationStage === 'winner-read') coordinationStage = 'winner-commit';
    queue.splice(index, 1)[0]();
  }
  return {
    id: 'demo-instance', observations,
    acquire() {
      return new Promise(resolve => {
        queue.push(() => {
          locked = true; let released = false;
          resolve({ release: async () => { if (!released) { released = true; locked = false; observations.releases += 1; drain(); } } });
        });
        drain();
      });
    },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expectedVersion, next) {
      assert.equal(locked, true);
      if (state.version !== expectedVersion) {
        if (Object.values(state.launchIntents).some(intent => intent.status === 'prepared')) coordinationStage = loserObserves === 'started' ? 'winner-read' : 'prepared';
        const error = new Error('conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error;
      }
      state = structuredClone(next); observations.commits += 1; return structuredClone(state);
    },
    inspect() { return structuredClone(state); },
    locked() { return locked; },
  };
}

function heldAcquireMemoryInstance(initial = {}, holdCall = 4) {
  let locked = false; let acquireCalls = 0; let releaseHeld; let reportHeld; const queue = [];
  let state = structuredClone({
    schemaVersion: 1, version: 0, activated: false, terminal: null, graph: graph(), events: [],
    attempts: {}, launchIntents: {}, results: {}, heartbeats: {}, evidence: [],
    usage: { tokens: 0, costUsd: 0, retries: 0, timeMinutes: 0, taskLimit: 0 }, limits: { tokens: 10000, costUsd: 10, retries: 2 }, ...initial,
  });
  const held = new Promise(resolve => { reportHeld = resolve; });
  function drain() {
    if (locked || queue.length === 0) return;
    queue.shift()();
  }
  function enqueue(resolve) {
    queue.push(() => {
      locked = true; let released = false;
      resolve({ release: async () => { if (!released) { released = true; locked = false; drain(); } } });
    });
    drain();
  }
  return {
    id: 'demo-instance',
    acquire() {
      acquireCalls += 1;
      return new Promise(resolve => {
        if (acquireCalls === holdCall) {
          releaseHeld = () => enqueue(resolve); reportHeld(); return;
        }
        enqueue(resolve);
      });
    },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expectedVersion, next) {
      assert.equal(locked, true);
      if (state.version !== expectedVersion) { const error = new Error('conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error; }
      state = structuredClone(next); return structuredClone(state);
    },
    inspect() { return structuredClone(state); },
    waitUntilHeld() { return held; },
    releaseHeld() { releaseHeld(); },
    locked() { return locked; },
  };
}

function approval(instanceId = 'demo-instance') {
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const receipt = createApprovalReceipt({
    id: 'approval-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'portfolio-boss',
    action: 'activation', resource: instanceId, policyId: 'authority.human-gate.activation', decision: 'approved',
    expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
  const authority = createAuthorityEnvelope({ actorId: 'portfolio-boss', principal: 'agent', role: 'boss', actions: ['activation'], ownedPaths: [], providers: [], commands: [] });
  return { receipt, registry, authority, expectedApproverId: 'human-owner' };
}

function boundApproval({ id, subjectId, action, resource, policyId }) {
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const receipt = createApprovalReceipt({ id, approverId: 'human-owner', approverPrincipal: 'human', subjectId, action, resource, policyId, decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true });
  const authority = createAuthorityEnvelope({ actorId: subjectId, principal: 'agent', actions: [action], ownedPaths: [], providers: [], commands: [] });
  return { receipt, registry, authority, expectedApproverId: 'human-owner' };
}

function launchFor(nodeValue, intent) {
  return {
    nodeId: nodeValue.id, parentId: nodeValue.parentId ?? null, objective: nodeValue.objective,
    ownedPaths: [`src/${nodeValue.id}.js`], authority: { actions: ['file.write'], providers: [] }, commands: ['test.unit'],
    evidence: nodeValue.evidenceRefs, budget: { maxTokens: nodeValue.budget.tokenLimit, maxRuntimeMs: 10_000, maxCostUsd: nodeValue.budget.costUsd },
    worktree: { path: `/tmp/${nodeValue.id}`, dev: '1', ino: '2', reservationId: intent.reservationId },
    contextRefs: ['demo-context'], heartbeatInterval: 1000, stopConditions: ['objective-complete'],
  };
}

function durableApiIntent(status = 'started', overrides = {}) {
  return {
    id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1,
    idempotencyKey: 'demo-instance:api:1',
    allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 },
    status, eventSequence: 0,
    ...(status === 'started' ? { startedAtMs: NOW } : {}),
    ...overrides,
  };
}

async function scripted(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/runs/${name}.json`, import.meta.url), 'utf8')).scripts;
}

test('activation requires a bound single-use human approval and expected version', async () => {
  const instance = memoryInstance();
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'ok', evidence: ['design-commit', 'design-test'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor });
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: 0 }), error => error instanceof RuntimeError && error.details.reason === 'approval-required');
  const accepted = await runtime.activate(instance, { expectedVersion: 0, ...approval() });
  assert.equal(accepted.activated, true);
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: 0, ...approval() }), error => error.code === 'ERR_RUNTIME_VERSION_CONFLICT');
  assert.equal(instance.observations.releases, 3);
});

test('runtime accepts the canonical Boss root human profile with a separate final gate', async () => {
  const instance = memoryInstance({ graph: graphFixture('parallel-fan-in') });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const state = await runtime.activate(instance, { expectedVersion: 0, ...approval() });
  assert.equal(state.activated, true);
  assert.equal(state.graph.nodes.find(value => value.id === 'boss-plan').status, 'completed');
  assert.equal(state.graph.nodes.find(value => value.id === 'human-final').approvalGate, 'final-delivery');
});

test('activation releases its approval claim when the durable CAS fails', async () => {
  const instance = memoryInstance(); const originalCommit = instance.commit.bind(instance); let failOnce = true;
  instance.commit = async (...args) => { if (failOnce) { failOnce = false; const error = new Error('conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error; } return originalCommit(...args); };
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'ok', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor });
  const bound = boundApproval({ id: 'activation-retry', subjectId: 'portfolio-boss', action: 'activation', resource: 'demo-instance', policyId: 'authority.human-gate.activation' });
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: 0, ...bound }), error => error.code === 'ERR_RUNTIME_VERSION_CONFLICT');
  assert.equal((await runtime.activate(instance, { expectedVersion: 0, ...bound })).activated, true);
});

test('ambiguous durable approval success fails closed without making the finalized receipt reusable', async () => {
  const instance = memoryInstance(); const originalCommit = instance.commit.bind(instance); let ambiguous = true;
  instance.commit = async (...args) => { const persisted = await originalCommit(...args); if (ambiguous) { ambiguous = false; throw new Error('ambiguous publication'); } return persisted; };
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const bound = boundApproval({ id: 'activation-ambiguous', subjectId: 'portfolio-boss', action: 'activation', resource: 'demo-instance', policyId: 'authority.human-gate.activation' });
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: 0, ...bound }));
  assert.equal(instance.inspect().activated, true);
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: instance.inspect().version, ...bound }), error => error instanceof RuntimeError && error.details.reason === 'approval-required');
});

test('readable concurrent state without the exact approval marker rolls back the finalized receipt', async () => {
  const instance = memoryInstance(); const originalCommit = instance.commit.bind(instance); const before = instance.inspect(); let concurrent = true;
  instance.commit = async (expectedVersion, _next) => { if (concurrent) { concurrent = false; await originalCommit(expectedVersion, { ...before, version: expectedVersion + 1 }); const error = new Error('concurrent state'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error; } return originalCommit(expectedVersion, _next); };
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const bound = boundApproval({ id: 'activation-concurrent', subjectId: 'portfolio-boss', action: 'activation', resource: 'demo-instance', policyId: 'authority.human-gate.activation' });
  await assert.rejects(() => runtime.activate(instance, { expectedVersion: 0, ...bound }), error => error instanceof RuntimeError);
  const activated = await runtime.activate(instance, { expectedVersion: 1, ...bound });
  assert.equal(activated.activated, true);
});

test('one tick launches two independent Workers outside the lock and fan-in waits', async () => {
  const instance = memoryInstance({ activated: true });
  const launches = [];
  const fake = createFakeClient({ scripts: await scripted('parallel-success') });
  const client = { provider: 'fake', launch: async (contract, options) => {
    if (instance.locked()) instance.observations.startsWhileLocked += 1;
    launches.push({ nodeId: contract.nodeId, parentId: contract.parentId });
    return fake.launch(contract, options);
  } };
  const runtime = createOrchestrator({ client, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.deepEqual(first.launched, ['api', 'design']);
  assert.deepEqual(launches, [{ nodeId: 'api', parentId: 'manager-plan' }, { nodeId: 'design', parentId: 'manager-plan' }]);
  assert.equal(instance.observations.startsWhileLocked, 0);
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'integration').status, 'ready');
  const second = await runtime.tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 2 });
  assert.deepEqual(second.launched, ['integration']);
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'integration').status, 'completed');
  assert.deepEqual(instance.inspect().evidence.filter(item => item.nodeId === 'integration').map(item => item.id), ['integration-commit', 'integration-journey', 'integration-test']);
});

test('budget blocks before launch and cancellation aborts an active child idempotently', async () => {
  const budgeted = memoryInstance({ activated: true, limits: { tokens: 1, costUsd: 0, retries: 0 } });
  let launched = 0;
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { launched += 1; throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const result = await runtime.tick(budgeted, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.equal(result.terminal, 'budget-exhausted'); assert.equal(launched, 0);

  const active = memoryInstance({ activated: true });
  let observedAbort = false;
  const hanging = createOrchestrator({ client: { provider: 'fake', launch: (_contract, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { observedAbort = true; resolve({ version: 1, status: 'blocked', output: { summary: 'cancelled', evidence: [] }, usage: { tokens: 0, costUsd: 0 } }); })) }, now: () => NOW, launchFor });
  const pending = hanging.tick(active, { expectedVersion: 0, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const cancellation = createAuthorityEnvelope({ actorId: 'human-owner', principal: 'human', actions: ['orchestration.cancel'], ownedPaths: [], providers: [], commands: [] });
  const cancelled = await hanging.cancelGoal(active, { expectedVersion: active.inspect().version, authority: cancellation });
  assert.equal(cancelled.terminal, 'cancelled'); assert.equal(observedAbort, true);
  await pending;
  assert.equal((await hanging.cancelGoal(active, { expectedVersion: active.inspect().version, authority: cancellation })).terminal, 'cancelled');
});

test('node cancellation aborts only its active controller outside the state lock', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); let aborted = false;
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: (_contract, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ version: 1, status: 'blocked', output: { summary: 'cancelled', evidence: [] }, usage: { tokens: 0, costUsd: 0 } }); })) }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const pending = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.cancel'], ownedPaths: [], providers: [], commands: [] });
  const cancelled = await runtime.cancelNode(instance, { expectedVersion: instance.inspect().version, nodeId: 'api', authority });
  assert.equal(cancelled.graph.nodes.find(value => value.id === 'api').status, 'cancelled');
  assert.equal(aborted, true);
  await pending;
});

test('runtime stalled recovery aborts the old controller outside the lock before replacement', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  let nowMs = NOW; let aborted = false;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: (_contract, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
      aborted = true;
      assert.equal(instance.locked(), false);
      resolve({ version: 1, status: 'blocked', output: { summary: 'stale attempt stopped', evidence: [] }, usage: { tokens: 0, costUsd: 0 } });
    })) },
    now: () => nowMs, launchFor, reservationId: id => `${id}-lease`,
  });
  const pending = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const heartbeat = await runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: 'api-lease', sequence: 1, timestampMs: NOW, intervalMs: 100,
  } });
  nowMs += 301;
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.recover'], ownedPaths: [], providers: [], commands: [] });
  const recovered = await runtime.recoverStalledNode(instance, { expectedVersion: heartbeat.version, nodeId: 'api', authority, nowMs, reason: 'heartbeat stalled' });
  assert.equal(recovered.graph.nodes.find(value => value.id === 'api').status, 'ready');
  assert.equal(aborted, true);
  await pending;
});

test('derives bounded deterministic launch intent identifiers for maximum-length node identifiers', async () => {
  const nodeId = 'a'.repeat(64);
  const execute = async () => {
    const initial = memoryInstance({ activated: true }).inspect();
    const worker = initial.graph.nodes.find(value => value.id === 'api');
    worker.id = nodeId;
    worker.evidenceRefs = ['maximum-node-commit', 'maximum-node-test'];
    initial.graph.nodes.find(value => value.id === 'integration').dependencies = ['design', nodeId];
    initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
    initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
    const instance = memoryInstance({ ...initial, version: 0 });
    const runtime = createOrchestrator({
      client: {
        provider: 'fake',
        launch: async () => ({
          version: 1,
          status: 'success',
          output: { summary: 'complete', evidence: [...worker.evidenceRefs] },
          usage: { tokens: 1, costUsd: 0 },
        }),
      },
      now: () => NOW,
      launchFor,
      reservationId: () => 'maximum-node-lease',
    });

    await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    return instance.inspect().launchIntents[nodeId].id;
  };

  const first = await execute();
  const second = await execute();
  assert.equal(first, second);
  assert.ok(first.length <= 64);
  assert.match(first, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
});

test('late ordinary success cannot settle an authorized replacement launch attempt', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  const instance = memoryInstance({ ...initial, version: 0 });
  let nowMs = NOW; let launches = 0; let resolveFirst; let resolveSecond;
  const success = summary => ({ version: 1, status: 'success', output: { summary, evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } });
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => new Promise(resolve => {
      launches += 1;
      if (launches === 1) resolveFirst = resolve; else resolveSecond = resolve;
    }) },
    now: () => nowMs, launchFor, reservationId: (_id, sequence) => `api-lease-${sequence}`,
  });

  const firstTick = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const firstIntent = instance.inspect().launchIntents.api;
  const heartbeat = await runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: firstIntent.reservationId,
    sequence: 1, timestampMs: NOW, intervalMs: 100,
  } });
  nowMs += 301;
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.recover'], ownedPaths: [], providers: [], commands: [] });
  const recovered = await runtime.recoverStalledNode(instance, { expectedVersion: heartbeat.version, nodeId: 'api', authority, nowMs, reason: 'heartbeat stalled' });
  const secondTick = runtime.tick(instance, { expectedVersion: recovered.version, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const secondIntent = instance.inspect().launchIntents.api;
  assert.equal(secondIntent.id, 'launch-api-2');
  assert.equal(secondIntent.status, 'started');
  await assert.rejects(() => runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: firstIntent.reservationId,
    sequence: 2, timestampMs: nowMs, intervalMs: 100,
  } }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  const replacementHeartbeat = await runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: secondIntent.reservationId,
    sequence: 1, timestampMs: nowMs, intervalMs: 100,
  } });
  assert.equal(replacementHeartbeat.heartbeats.api.leaseId, secondIntent.reservationId);
  assert.equal(replacementHeartbeat.heartbeats.api.sequence, 1);

  resolveFirst(success('stale first attempt'));
  await firstTick;
  const afterLate = instance.inspect();
  assert.equal(afterLate.launchIntents.api.id, 'launch-api-2');
  assert.equal(afterLate.launchIntents.api.status, 'started');
  assert.equal(afterLate.graph.nodes.find(value => value.id === 'api').status, 'running');
  assert.deepEqual(afterLate.evidence.filter(value => value.nodeId === 'api'), []);

  resolveSecond(success('authorized replacement'));
  await secondTick;
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'api').status, 'completed');
});

test('runtime activation is an exact durable boolean before any launch effect', async () => {
  const initial = memoryInstance({ activated: 'forged' }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); let launches = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { launches += 1; return { version: 1, status: 'success', output: { summary: 'forged', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }; } },
    now: () => NOW, launchFor, reservationId: id => `${id}-lease`,
  });
  await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  assert.equal(launches, 0);
  assert.equal(instance.inspect().version, 0);
});

test('one tick reserves cumulative launch budgets and bounded retry succeeds on a later tick', async () => {
  const constrained = memoryInstance({ activated: true, limits: { tokens: 1500, costUsd: 10, retries: 2 } });
  const one = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'api complete', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const result = await one.tick(constrained, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.deepEqual(result.launched, ['api']);
  assert.equal(constrained.inspect().graph.nodes.find(value => value.id === 'design').status, 'ready');

  const retryState = memoryInstance({ activated: true }).inspect();
  retryState.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  const retrying = memoryInstance({ ...retryState, version: 0 });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: await scripted('retry-then-success') }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const first = await runtime.tick(retrying, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(retrying.inspect().graph.nodes.find(value => value.id === 'api').status, 'ready');
  assert.equal(retrying.inspect().attempts.api, 2);
  await runtime.tick(retrying, { expectedVersion: first.version, maxActiveNodes: 1 });
  assert.equal(retrying.inspect().graph.nodes.find(value => value.id === 'api').status, 'completed');
});

test('automatic retry retires the prior heartbeat lease before the replacement attempt starts', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  const instance = memoryInstance({ ...initial, version: 0 });
  const pendingLaunches = [];
  const launchWaiters = [];
  const client = {
    provider: 'fake',
    launch: async () => new Promise(resolve => {
      const launched = { resolve };
      const waiter = launchWaiters.shift();
      if (waiter) waiter(launched); else pendingLaunches.push(launched);
    }),
  };
  const nextLaunch = () => new Promise(resolve => {
    const launched = pendingLaunches.shift();
    if (launched) resolve(launched); else launchWaiters.push(resolve);
  });
  const runtime = createOrchestrator({
    client, now: () => NOW, launchFor, reservationId: (_id, sequence) => `api-lease-${sequence}`,
    retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [0], retryable: ['provider-transient'] }),
  });

  const firstStarted = nextLaunch();
  const firstTick = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const firstLaunch = await firstStarted;
  const firstIntent = instance.inspect().launchIntents.api;
  await runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: firstIntent.reservationId,
    sequence: 7, timestampMs: NOW, intervalMs: 100,
  } });
  firstLaunch.resolve({ version: 1, status: 'retry', output: { summary: 'retry', evidence: [] }, usage: { tokens: 1, costUsd: 0 } });
  await firstTick;
  assert.equal(Object.hasOwn(instance.inspect().heartbeats, 'api'), false);
  assert.equal(Object.hasOwn(instance.inspect().lastHeartbeatAt, 'api'), false);

  const secondStarted = nextLaunch();
  const secondTick = runtime.tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  const secondLaunch = await secondStarted;
  const secondIntent = instance.inspect().launchIntents.api;
  assert.equal(secondIntent.attempt, 2);
  await assert.rejects(() => runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: firstIntent.reservationId,
    sequence: 8, timestampMs: NOW, intervalMs: 100,
  } }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  const replacement = await runtime.recordHeartbeat(instance, { expectedVersion: instance.inspect().version, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: secondIntent.reservationId,
    sequence: 1, timestampMs: NOW, intervalMs: 100,
  } });
  assert.equal(replacement.heartbeats.api.sequence, 1);
  secondLaunch.resolve({ version: 1, status: 'success', output: { summary: 'complete', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } });
  await secondTick;
});

test('preparation retry clears a heartbeat recorded against the committed attempt', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'api').status = 'reserved';
  initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  initial.attempts.api = 1;
  initial.launchIntents.api = durableApiIntent('committed', { allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 2 } });
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } },
    now: () => NOW, launchFor,
    retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [0], retryable: ['provider-transient'] }),
    prepareWorktree: async () => { const error = new Error('private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; throw error; },
  });
  const recorded = await runtime.recordHeartbeat(instance, { expectedVersion: 0, heartbeat: {
    version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: 'api-lease',
    sequence: 1, timestampMs: NOW, intervalMs: 100,
  } });
  await runtime.tick(instance, { expectedVersion: recorded.version, maxActiveNodes: 1 });
  assert.equal(Object.hasOwn(instance.inspect().heartbeats, 'api'), false);
  assert.equal(Object.hasOwn(instance.inspect().lastHeartbeatAt, 'api'), false);
});

test('positive retry delays prevent relaunch until the deterministic retry deadline', async () => {
  let nowMs = NOW;
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({
    client: createFakeClient({ scripts: await scripted('retry-then-success') }), now: () => nowMs, launchFor,
    reservationId: id => `${id}-lease`, retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [100], retryable: ['provider-transient'] }),
  });
  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'api').status, 'corrective');
  nowMs += 99;
  const waiting = await runtime.tick(instance, { expectedVersion: first.version, maxActiveNodes: 1 });
  assert.deepEqual(waiting.launched, []);
  nowMs += 1;
  await runtime.tick(instance, { expectedVersion: waiting.version, maxActiveNodes: 1 });
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'api').status, 'completed');
});

test('automatic retries bind their event deadline and transitions to one monotonic clock sample', async t => {
  for (const [label, delayMs, preparationFailure] of [
    ['client positive delay', 100, false],
    ['client zero delay', 0, false],
    ['preparation positive delay', 100, true],
    ['preparation zero delay', 0, true],
  ]) {
    await t.test(label, async () => {
      let nowMs = NOW;
      const initial = memoryInstance({ activated: true }).inspect();
      initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
      initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
      initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
      const instance = memoryInstance({ ...initial, version: 0 });
      const retryResult = { version: 1, kind: 'retry', output: { summary: 'retry', evidence: [] }, usage: { tokens: 1, costUsd: 0 } };
      const runtime = createOrchestrator({
        client: preparationFailure
          ? { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }
          : createFakeClient({ scripts: [retryResult] }),
        now: () => nowMs++, launchFor, reservationId: id => `${id}-lease`,
        retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [delayMs], retryable: ['provider-transient'] }),
        ...(preparationFailure ? { prepareWorktree: async () => {
          const error = new Error('private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; throw error;
        } } : {}),
      });

      await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
      const state = instance.inspect();
      const retryEvent = state.events.findLast(event => event.type === 'retry' && event.nodeId === 'api');
      assert.equal(state.launchIntents.api.retryAtMs, Date.parse(retryEvent.timestamp) + delayMs);
      assert.equal(state.graph.nodes.find(value => value.id === 'api').status, preparationFailure || delayMs === 0 ? 'ready' : 'corrective');
    });
  }
});

test('retry and heartbeat policies are finite, monotonic and bound to a launch lease', () => {
  const policy = createRetryPolicy({ maxAttempts: 3, delaysMs: [100, 200], retryable: ['provider-transient', 'stalled'] });
  assert.deepEqual(retryPolicySchedule(policy), [100, 200]);
  assert.ok(Object.isFrozen(retryPolicySchedule(policy)));
  assert.throws(() => retryPolicySchedule({ delaysMs: [100, 200] }));
  assert.deepEqual(retryDecision(policy, { attempt: 1, classification: 'provider-transient' }), { retry: true, nextAttempt: 2, delayMs: 100 });
  assert.deepEqual(retryDecision(policy, { attempt: 3, classification: 'provider-transient' }), { retry: false, reason: 'attempts-exhausted' });
  assert.deepEqual(retryDecision(policy, { attempt: 1, classification: 'semantic-conflict' }), { retry: false, reason: 'not-retryable' });
  const beat = createHeartbeat({ version: 1, instanceId: 'demo-instance', nodeId: 'design', actorId: 'design-worker', leaseId: 'design-lease', sequence: 2, timestampMs: NOW, intervalMs: 1000 });
  assert.equal(heartbeatStatus(beat, { nowMs: NOW + 1999, expected: { instanceId: 'demo-instance', nodeId: 'design', actorId: 'design-worker', leaseId: 'design-lease' } }).status, 'alive');
  assert.equal(heartbeatStatus(beat, { nowMs: NOW + 3000, expected: { instanceId: 'demo-instance', nodeId: 'design', actorId: 'design-worker', leaseId: 'design-lease' } }).status, 'stalled');
});

test('runtime heartbeats are versioned and a stale bound Worker is blocked before relaunch', async () => {
  const beat = createHeartbeat({ version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: 'api-lease', sequence: 1, timestampMs: NOW, intervalMs: 100 });
  const instance = memoryInstance({ activated: true, graph: graph(), launchIntents: {}, heartbeats: {} });
  const api = instance.inspect().graph.nodes.find(node => node.id === 'api');
  const primed = instance.inspect(); api.status = 'reserved';
  primed.graph.nodes.find(node => node.id === 'api').status = 'reserved';
  primed.graph.nodes.find(node => node.id === 'design').status = 'completed';
  primed.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  primed.attempts.api = 1;
  primed.launchIntents.api = durableApiIntent('committed', { eventSequence: 1 });
  const seeded = memoryInstance({ ...primed, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('stale worker must not relaunch'); } }, now: () => NOW + 1000, launchFor });
  const recorded = await runtime.recordHeartbeat(seeded, { expectedVersion: 0, heartbeat: beat });
  assert.equal(recorded.heartbeats.api.sequence, 1);
  const result = await runtime.tick(seeded, { expectedVersion: recorded.version, maxActiveNodes: 1 });
  assert.equal(result.launched.length, 0);
  assert.equal(seeded.inspect().graph.nodes.find(node => node.id === 'api').status, 'blocked');
});

test('future heartbeat timestamps are rejected without poisoning the valid recovery path', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'api').status = 'running'; initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.attempts.api = 1;
  initial.launchIntents.api = durableApiIntent();
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const heartbeat = timestampMs => ({ version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: 'api-lease', sequence: 1, timestampMs, intervalMs: 100 });
  await assert.rejects(() => runtime.recordHeartbeat(instance, { expectedVersion: 0, heartbeat: heartbeat(NOW + 1) }), error => error instanceof RuntimeError);
  assert.deepEqual(instance.inspect().heartbeats, {});
  const recovered = await runtime.recordHeartbeat(instance, { expectedVersion: 0, heartbeat: heartbeat(NOW) });
  assert.equal(recovered.heartbeats.api.timestampMs, NOW);
});

test('worktree preparation and reconciliation run outside the state lock around the client', async () => {
  const instance = memoryInstance({ activated: true }); const calls = [];
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async contract => { assert.equal(instance.locked(), false); calls.push(`client:${contract.nodeId}`); return { version: 1, status: 'success', output: { summary: 'done', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }; } },
    now: () => NOW, reservationId: id => `${id}-lease`,
    prepareWorktree: async (_node, intent) => { assert.equal(instance.locked(), false); calls.push(`prepare:${intent.nodeId}`); return { path: '/tmp/api', dev: '1', ino: '2', reservationId: intent.reservationId }; },
    reconcile: async (_node, _intent, result) => { assert.equal(instance.locked(), false); calls.push('reconcile:api'); assert.equal(result.status, 'success'); return { status: 'integrated' }; },
    launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
  });
  const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.deepEqual(result.launched, ['api']);
  assert.deepEqual(calls, ['prepare:api', 'client:api', 'reconcile:api']);
});

test('a concurrent prepare CAS loser joins the exact durable winner without settling or retrying it', async () => {
  for (const loserObserves of ['prepared', 'started']) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    const instance = coordinatedMemoryInstance({ ...initial, version: 0 }, { loserObserves });
    let preparations = 0; let clientStarts = 0; let releasePreparation; let firstPreparation;
    const firstPreparing = new Promise(resolve => { firstPreparation = resolve; });
    const preparationBarrier = new Promise(resolve => { releasePreparation = resolve; });
    const makeRuntime = () => createOrchestrator({
      client: { provider: 'fake', launch: async () => { clientStarts += 1; return { version: 1, status: 'success', output: { summary: 'winner', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }; } },
      now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }), reservationId: id => `${id}-lease`,
      prepareWorktree: async (_node, intent) => {
        preparations += 1;
        if (preparations === 1) { firstPreparation(); await preparationBarrier; }
        return { path: `/tmp/${intent.nodeId}-${preparations}`, dev: '1', ino: String(preparations), reservationId: intent.reservationId };
      },
    });
    const first = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    await firstPreparing;
    const second = makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
    await second;
    releasePreparation();
    const settled = await Promise.allSettled([first, second]);
    assert.deepEqual(settled.map(item => item.status), ['fulfilled', 'fulfilled'], loserObserves);
    const state = instance.inspect();
    assert.equal(preparations, 1, loserObserves);
    assert.equal(clientStarts, 1, loserObserves);
    assert.equal(state.attempts.api, 1, loserObserves);
    assert.equal(state.usage.retries, 0, loserObserves);
    assert.equal(state.launchIntents.api.status, 'complete', loserObserves);
    assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed', loserObserves);
  }
});

test('a duplicate preparation failure after the winner starts cannot settle the winning intent', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = coordinatedMemoryInstance({ ...initial, version: 0 });
  let preparations = 0; let clientStarts = 0;
  let releaseWinnerPreparation; let reportWinnerPreparing; let reportDuplicatePreparing; let reportClientStarted; let releaseClient;
  const winnerPreparation = new Promise(resolve => { releaseWinnerPreparation = resolve; });
  const winnerPreparing = new Promise(resolve => { reportWinnerPreparing = resolve; });
  const duplicatePreparing = new Promise(resolve => { reportDuplicatePreparing = resolve; });
  const clientStarted = new Promise(resolve => { reportClientStarted = resolve; });
  const clientBarrier = new Promise(resolve => { releaseClient = resolve; });
  const makeRuntime = () => createOrchestrator({
    client: { provider: 'fake', launch: async () => {
      clientStarts += 1; reportClientStarted(); await clientBarrier;
      return { version: 1, status: 'success', output: { summary: 'winner', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } };
    } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }), reservationId: id => `${id}-lease`,
    prepareWorktree: async (_node, intent) => {
      preparations += 1;
      if (preparations === 1) { reportWinnerPreparing(); await winnerPreparation; return { path: '/tmp/api-winner', dev: '1', ino: '1', reservationId: intent.reservationId }; }
      reportDuplicatePreparing(); await clientStarted;
      const error = new Error('duplicate private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; throw error;
    },
  });

  const winner = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await winnerPreparing;
  const duplicate = makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  await Promise.race([duplicatePreparing, duplicate]);
  releaseWinnerPreparation();
  await clientStarted;
  await duplicate;
  releaseClient();
  await winner;

  const state = instance.inspect();
  assert.equal(preparations, 1);
  assert.equal(clientStarts, 1);
  assert.equal(state.attempts.api, 1);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.status, 'complete');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('a duplicate preparation failure before winner success cannot consume the winning attempt', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = coordinatedMemoryInstance({ ...initial, version: 0 });
  let preparations = 0; let clientStarts = 0;
  let releaseWinnerPreparation; let reportWinnerPreparing;
  const winnerPreparation = new Promise(resolve => { releaseWinnerPreparation = resolve; });
  const winnerPreparing = new Promise(resolve => { reportWinnerPreparing = resolve; });
  const makeRuntime = () => createOrchestrator({
    client: { provider: 'fake', launch: async () => {
      clientStarts += 1;
      return { version: 1, status: 'success', output: { summary: 'winner', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } };
    } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }), reservationId: id => `${id}-lease`,
    prepareWorktree: async (_node, intent) => {
      preparations += 1;
      if (preparations === 1) { reportWinnerPreparing(); await winnerPreparation; return { path: '/tmp/api-winner', dev: '1', ino: '1', reservationId: intent.reservationId }; }
      const error = new Error('duplicate private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; throw error;
    },
  });

  const winner = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await winnerPreparing;
  await makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  releaseWinnerPreparation();
  await winner;

  const state = instance.inspect();
  assert.equal(preparations, 1);
  assert.equal(clientStarts, 1);
  assert.equal(state.attempts.api, 1);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.status, 'complete');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('a fresh durable preparation claim is joined while an expired claim is recoverable', async () => {
  for (const expired of [false, true]) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
    initial.attempts.api = 1;
    initial.launchIntents.api = {
      id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1, idempotencyKey: 'demo-instance:api:1',
      allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 }, status: 'committed', eventSequence: 0,
      preparationClaim: { id: 'prepare-crashed-runtime', claimedAtMs: NOW - (expired ? 101 : 99) },
    };
    const instance = memoryInstance({ ...initial, version: 0 });
    let preparations = 0; let clientStarts = 0;
    const runtime = createOrchestrator({
      client: { provider: 'fake', launch: async () => {
        clientStarts += 1;
        return { version: 1, status: 'success', output: { summary: 'recovered', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } };
      } },
      now: () => NOW, launchGraceMs: 100, reservationId: id => `${id}-lease`,
      launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
      prepareWorktree: async (_node, intent) => {
        preparations += 1;
        return { path: '/tmp/api-recovered', dev: '1', ino: '1', reservationId: intent.reservationId };
      },
    });

    await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    const state = instance.inspect();
    assert.equal(preparations, expired ? 1 : 0, expired ? 'expired claim must recover' : 'fresh claim must join');
    assert.equal(clientStarts, expired ? 1 : 0);
    assert.equal(state.graph.nodes.find(node => node.id === 'api').status, expired ? 'completed' : 'reserved');
    assert.equal(state.launchIntents.api.status, expired ? 'complete' : 'committed');
  }
});

test('cancellation clears a preparation claim before a late owner success or failure', async () => {
  for (const lateOutcome of ['success', 'failure']) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    const instance = memoryInstance({ ...initial, version: 0 });
    let reportPreparing; let settlePreparation; let clientStarts = 0;
    const preparing = new Promise(resolve => { reportPreparing = resolve; });
    const preparation = new Promise((resolve, reject) => { settlePreparation = lateOutcome === 'success' ? resolve : reject; });
    const runtime = createOrchestrator({
      client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('cancelled preparation must not launch'); } },
      now: () => NOW, launchFor, reservationId: id => `${id}-lease`,
      prepareWorktree: async (_node, intent) => {
        reportPreparing(); await preparation;
        return { path: '/tmp/api-cancelled', dev: '1', ino: '1', reservationId: intent.reservationId };
      },
    });
    const pending = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    await preparing;
    const authority = createAuthorityEnvelope({ actorId: 'human-owner', principal: 'human', actions: ['orchestration.cancel'], ownedPaths: [], providers: [], commands: [] });
    const cancelled = await runtime.cancelGoal(instance, { expectedVersion: instance.inspect().version, authority });
    assert.equal(cancelled.launchIntents.api.status, 'complete', lateOutcome);
    assert.equal(Object.hasOwn(cancelled.launchIntents.api, 'preparationClaim'), false, lateOutcome);
    if (lateOutcome === 'success') settlePreparation();
    else { const error = new Error('late private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; settlePreparation(error); }
    await pending;
    assert.equal(clientStarts, 0, lateOutcome);
    assert.equal(instance.inspect().launchIntents.api.status, 'complete', lateOutcome);
    assert.equal(Object.hasOwn(instance.inspect().launchIntents.api, 'preparationClaim'), false, lateOutcome);
  }
});

test('stalled claim liveness and explicit recovery clear the durable preparation claim', async () => {
  const claimedState = () => {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
    initial.attempts.api = 1;
    initial.launchIntents.api = {
      id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1, idempotencyKey: 'demo-instance:api:1',
      allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 }, status: 'committed', eventSequence: 0,
      preparationClaim: { id: 'prepare-stalled-runtime', claimedAtMs: NOW },
    };
    initial.heartbeats.api = { version: 1, instanceId: 'demo-instance', nodeId: 'api', actorId: 'api-worker', leaseId: 'api-lease', sequence: 1, timestampMs: NOW, intervalMs: 100 };
    return initial;
  };
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW + 301, launchFor });
  const detected = memoryInstance({ ...claimedState(), version: 0 });
  const terminal = await runtime.tick(detected, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(terminal.terminal, 'blocked');
  assert.equal(detected.inspect().launchIntents.api.status, 'complete');
  assert.equal(Object.hasOwn(detected.inspect().launchIntents.api, 'preparationClaim'), false);

  const recovered = memoryInstance({ ...claimedState(), version: 0 });
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.recover'], ownedPaths: [], providers: [], commands: [] });
  const state = await runtime.recoverStalledNode(recovered, { expectedVersion: 0, nodeId: 'api', authority, nowMs: NOW + 301, reason: 'preparation heartbeat stalled' });
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'ready');
  assert.equal(state.launchIntents.api.status, 'recovered');
  assert.equal(Object.hasOwn(state.launchIntents.api, 'preparationClaim'), false);
});

test('an expired preparation owner cannot publish late success or failure after exact-token takeover', async () => {
  for (const lateOutcome of ['success', 'failure']) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    const instance = coordinatedMemoryInstance({ ...initial, version: 0 });
    let nowMs = NOW; let preparations = 0; let reportOldPreparing; let settleOldPreparation;
    const oldPreparing = new Promise(resolve => { reportOldPreparing = resolve; });
    const oldPreparation = new Promise((resolve, reject) => { settleOldPreparation = lateOutcome === 'success' ? resolve : reject; });
    const makeRuntime = () => createOrchestrator({
      client: { provider: 'fake', launch: async () => ({ version: 1, status: 'success', output: { summary: 'takeover', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }) },
      now: () => nowMs, launchGraceMs: 100, reservationId: id => `${id}-lease`, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
      prepareWorktree: async (_node, intent) => {
        preparations += 1;
        if (preparations === 1) { reportOldPreparing(); await oldPreparation; }
        return { path: `/tmp/api-${preparations}`, dev: '1', ino: String(preparations), reservationId: intent.reservationId };
      },
    });
    const oldOwner = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    await oldPreparing;
    nowMs += 101;
    await makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
    if (lateOutcome === 'success') settleOldPreparation();
    else { const error = new Error('expired private preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; settleOldPreparation(error); }
    await oldOwner;
    const state = instance.inspect();
    assert.equal(preparations, 2, lateOutcome);
    assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed', lateOutcome);
    assert.equal(state.launchIntents.api.status, 'complete', lateOutcome);
    assert.equal(state.attempts.api, 1, lateOutcome);
    assert.equal(state.usage.retries, 0, lateOutcome);
  }
});

function preparedRaceState() {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
  initial.attempts.api = 1;
  initial.launchIntents.api = {
    id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1, idempotencyKey: 'demo-instance:api:1',
    allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 }, status: 'prepared', eventSequence: 0,
    worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' },
  };
  return initial;
}

test('a prepared-intent start CAS loser joins a winner that is already started', async () => {
  const instance = heldAcquireMemoryInstance({ ...preparedRaceState(), version: 0 });
  let clientStarts = 0; let reportClientStarted; let releaseClient;
  const clientStarted = new Promise(resolve => { reportClientStarted = resolve; });
  const clientBarrier = new Promise(resolve => { releaseClient = resolve; });
  const makeRuntime = () => createOrchestrator({
    client: { provider: 'fake', launch: async () => {
      clientStarts += 1; reportClientStarted(); await clientBarrier;
      return { version: 1, status: 'success', output: { summary: 'winner', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } };
    } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
  });
  const loser = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await instance.waitUntilHeld();
  const winner = makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  await clientStarted;
  instance.releaseHeld();
  await new Promise(resolve => setImmediate(resolve));
  releaseClient();
  const settled = await Promise.allSettled([loser, winner]);
  assert.deepEqual(settled.map(item => item.status), ['fulfilled', 'fulfilled']);
  const state = instance.inspect();
  assert.equal(clientStarts, 1);
  assert.equal(state.attempts.api, 1);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.status, 'complete');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('a prepared-intent start CAS loser joins a winner that already completed', async () => {
  const instance = heldAcquireMemoryInstance({ ...preparedRaceState(), version: 0 });
  let clientStarts = 0;
  const makeRuntime = () => createOrchestrator({
    client: { provider: 'fake', launch: async () => {
      clientStarts += 1;
      return { version: 1, status: 'success', output: { summary: 'winner', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } };
    } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
  });
  const loser = makeRuntime().tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await instance.waitUntilHeld();
  await makeRuntime().tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  instance.releaseHeld();
  const settled = await Promise.allSettled([loser]);
  assert.deepEqual(settled.map(item => item.status), ['fulfilled']);
  const state = instance.inspect();
  assert.equal(clientStarts, 1);
  assert.equal(state.attempts.api, 1);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.status, 'complete');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('prepared-intent start coordination is bounded after repeated CAS conflicts', async () => {
  const base = memoryInstance({ ...preparedRaceState(), version: 0 });
  let startConflicts = 0; let clientStarts = 0;
  const instance = {
    ...base,
    async commit(expectedVersion, next) {
      if (next.launchIntents.api?.status === 'started') {
        startConflicts += 1; const error = new Error('start conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error;
      }
      return base.commit(expectedVersion, next);
    },
  };
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('must not launch'); } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
  });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const state = instance.inspect();
  assert.equal(startConflicts, 4);
  assert.equal(clientStarts, 0);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.status, 'prepared');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'reserved');
});

test('prepared-intent start coordination never settles a replacement intent identity', async () => {
  const base = memoryInstance({ ...preparedRaceState(), version: 0 });
  let replacements = 0; let clientStarts = 0;
  const instance = {
    ...base,
    async commit(expectedVersion, next) {
      if (next.launchIntents.api?.status === 'started' && replacements === 0) {
        replacements += 1;
        const replacement = structuredClone(next);
        replacement.graph.nodes.find(node => node.id === 'api').status = 'reserved';
        replacement.events.pop(); replacement.appliedSequence = replacement.events.length;
        replacement.launchIntents.api = {
          ...replacement.launchIntents.api, id: 'launch-api-2', reservationId: 'api-lease-two', attempt: 2,
          idempotencyKey: 'demo-instance:api:2', status: 'prepared', startedAtMs: undefined,
          worktree: { path: '/tmp/api-replacement', dev: '1', ino: '2', reservationId: 'api-lease-two' },
        };
        replacement.attempts.api = 2;
        delete replacement.launchIntents.api.startedAtMs;
        await base.commit(expectedVersion, replacement);
        const error = new Error('start replacement conflict'); error.code = 'ERR_STATE_VERSION_CONFLICT'; throw error;
      }
      return base.commit(expectedVersion, next);
    },
  };
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('must not launch'); } },
    now: () => NOW, launchFor: (nodeValue, intent) => ({ ...launchFor(nodeValue, intent), worktree: intent.worktree }),
  });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const state = instance.inspect();
  assert.equal(replacements, 1);
  assert.equal(clientStarts, 0);
  assert.equal(state.usage.retries, 0);
  assert.equal(state.launchIntents.api.id, 'launch-api-2');
  assert.equal(state.launchIntents.api.status, 'prepared');
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'reserved');
});

test('worktree preparation failures consume finite retry policy and become terminal', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  let preparations = 0; let clientStarts = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('client must not start'); } },
    now: () => NOW,
    launchFor,
    reservationId: id => `${id}-lease`,
    retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [0], retryable: ['provider-transient'] }),
    prepareWorktree: async () => {
      preparations += 1;
      const error = new Error('private worktree preparation detail');
      error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE';
      throw error;
    },
  });

  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const second = await runtime.tick(instance, { expectedVersion: first.version, maxActiveNodes: 1 });
  const settled = instance.inspect();
  assert.equal(preparations, 2);
  assert.equal(clientStarts, 0);
  assert.equal(settled.attempts.api, 2);
  assert.equal(settled.usage.retries, 1);
  assert.equal(settled.launchIntents.api.status, 'complete');
  assert.equal(settled.graph.nodes.find(node => node.id === 'api').status, 'blocked');
  assert.equal(settled.terminal, 'blocked');

  await runtime.tick(instance, { expectedVersion: second.version, maxActiveNodes: 1 });
  assert.equal(preparations, 2);
});

test('delayed worktree preparation retry creates a new attempt only after retryAt', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  let nowMs = NOW; let preparations = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => ({ version: 1, status: 'success', output: { summary: 'prepared', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }) },
    now: () => nowMs,
    launchFor,
    reservationId: id => `${id}-lease`,
    retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [100], retryable: ['provider-transient'] }),
    prepareWorktree: async (_node, intent) => {
      preparations += 1;
      if (preparations === 1) {
        const error = new Error('bounded preparation failure'); error.code = 'ERR_AGENT_PROVIDER_UNAVAILABLE'; throw error;
      }
      return { path: '/tmp/api', dev: '1', ino: '2', reservationId: intent.reservationId };
    },
  });

  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(instance.inspect().launchIntents.api.retryAtMs, NOW + 100);
  nowMs += 99;
  const waiting = await runtime.tick(instance, { expectedVersion: first.version, maxActiveNodes: 1 });
  assert.deepEqual(waiting.launched, []);
  assert.equal(preparations, 1);
  nowMs += 1;
  const completed = await runtime.tick(instance, { expectedVersion: waiting.version, maxActiveNodes: 1 });
  assert.deepEqual(completed.launched, ['api']);
  assert.equal(preparations, 2);
  assert.equal(instance.inspect().launchIntents.api.id, 'launch-api-2');
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('reconciliation never receives malformed or secret-bearing client output', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  let reconciliations = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => ({
      version: 1,
      status: 'success',
      output: { summary: 'token=private-reconcile-canary', evidence: ['api-commit', 'api-test'] },
      usage: { tokens: 1, costUsd: 0 },
    }) },
    now: () => NOW,
    launchFor,
    reservationId: id => `${id}-lease`,
    reconcile: async () => { reconciliations += 1; return { status: 'integrated' }; },
  });

  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(reconciliations, 0);
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'api').status, 'blocked');
});

test('reconciliation receives a recursively immutable captured result and cannot alter committed evidence', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => ({ version: 1, status: 'success', output: { summary: 'captured', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }) },
    now: () => NOW,
    launchFor,
    reservationId: id => `${id}-lease`,
    reconcile: async (_node, _intent, result) => {
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.output), true);
      assert.equal(Object.isFrozen(result.output.evidence), true);
      assert.equal(Object.isFrozen(result.usage), true);
      assert.throws(() => { result.output.summary = 'changed'; }, TypeError);
      assert.throws(() => result.output.evidence.push('forged-evidence'), TypeError);
      return { status: 'integrated' };
    },
  });

  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const state = instance.inspect();
  assert.equal(state.graph.nodes.find(node => node.id === 'api').status, 'completed');
  assert.deepEqual(state.evidence.filter(item => item.nodeId === 'api').map(item => item.id).sort(), ['api-commit', 'api-test']);
});

test('a durably started launch is not duplicated by another tick', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); let starts = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: (_contract, { signal }) => { starts += 1; return new Promise(resolve => signal.addEventListener('abort', () => resolve({ version: 1, status: 'blocked', output: { summary: 'cancelled', evidence: [] }, usage: { tokens: 0, costUsd: 0 } }))); } },
    now: () => NOW, reservationId: id => `${id}-lease`, launchFor,
  });
  const first = runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.inspect().launchIntents.api.status, 'started');
  const second = await runtime.tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 1 });
  assert.deepEqual(second.launched, []); assert.equal(starts, 1);
  await runtime.cancelGoal(instance, { expectedVersion: instance.inspect().version, authority: createAuthorityEnvelope({ actorId: 'human-owner', principal: 'human', actions: ['orchestration.cancel'], ownedPaths: [], providers: [], commands: [] }) });
  await first;
});

test('failed client results follow the canonical running-to-failed transition path', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'failed', output: { summary: 'failed safely', evidence: ['failure-log'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, reservationId: id => `${id}-lease`, launchFor });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const transitions = instance.inspect().events.filter(event => event.nodeId === 'api' && event.type === 'state-transition').map(event => `${event.priorState}->${event.newState}`);
  assert.deepEqual(transitions, ['ready->reserved', 'reserved->running', 'running->failed']);
});

test('malformed client results durably block the node and complete its launch intent', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => ({ malformed: true }) }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(result.terminal, 'blocked');
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'api').status, 'blocked');
  assert.equal(instance.inspect().launchIntents.api.status, 'complete');
});

test('runs Boss then Manager then parallel Workers and leaves the final Boss gate for explicit human approval', async () => {
  const instance = memoryInstance({ graph: lifecycleGraph(), activated: false, limits: { tokenLimit: 50_000, costUsd: 50, timeMinutes: 500, taskLimit: 50, retries: 2 } });
  const scripts = [
    ['boss-commit', 'boss-test', 'boss-review'], ['manager-plan-commit', 'manager-plan-test'],
    ['api-commit', 'api-test'], ['design-commit', 'design-test'],
    ['integration-commit', 'integration-test', 'integration-journey'],
  ].map(evidence => ({ version: 1, kind: 'success', output: { summary: 'complete', evidence }, usage: { tokens: 1, costUsd: 0 } }));
  const launched = [];
  const fake = createFakeClient({ scripts });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async (contract, options) => { launched.push(contract.nodeId); return fake.launch(contract, options); } }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const activation = boundApproval({ id: 'activation-approval', subjectId: 'portfolio-boss', action: 'activation', resource: 'demo-instance', policyId: 'authority.human-gate.activation' });
  let state = await runtime.activate(instance, { expectedVersion: 0, ...activation });
  for (let tick = 0; tick < 4; tick += 1) await runtime.tick(instance, { expectedVersion: instance.inspect().version, maxActiveNodes: 2 });
  const beforeGate = instance.inspect();
  assert.deepEqual(launched, ['boss-plan', 'manager-plan', 'api', 'design', 'integration']);
  assert.equal(beforeGate.graph.nodes.find(value => value.id === 'human-final').status, 'ready');
  assert.equal(beforeGate.terminal, null);
  const finalApproval = boundApproval({ id: 'final-approval', subjectId: 'portfolio-boss', action: 'final-delivery', resource: 'demo-instance:human-final', policyId: 'authority.human-gate.final-delivery' });
  state = await runtime.approveNode(instance, { expectedVersion: beforeGate.version, nodeId: 'human-final', evidence: [
    { id: 'final-commit', type: 'commit' }, { id: 'final-test', type: 'test' }, { id: 'final-review', type: 'review' }, { id: 'final-approval', type: 'human-approval' },
  ], ...finalApproval });
  assert.equal(state.terminal, 'completed');
  assert.equal(state.graph.status, 'completed');
  assert.ok(state.events.every(event => validateEvent(event) === true));
});

test('derives and persists failed, blocked, and budget terminal outcomes', async () => {
  for (const [kind, terminal] of [['failed', 'failed'], ['blocked', 'blocked'], ['budget-exhausted', 'budget-exhausted']]) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
    initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
    const instance = memoryInstance({ ...initial, version: 0 });
    const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind, output: { summary: kind, evidence: kind === 'failed' ? ['failure-log'] : [] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease`, retryPolicy: createRetryPolicy({ maxAttempts: 1, delaysMs: [], retryable: ['provider-transient'] }) });
    const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
    assert.equal(result.terminal, terminal, kind);
    assert.equal(instance.inspect().graph.status, terminal === 'budget-exhausted' ? 'blocked' : terminal, kind);
  }
});

test('started intents use bounded first-heartbeat grace and process registry reconciliation after restart', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'api').status = 'running';
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.attempts.api = 1;
  initial.launchIntents.api = durableApiIntent();
  const live = memoryInstance({ ...initial, version: 0 });
  const liveRuntime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not relaunch'); } }, now: () => NOW + 6_000, launchFor, processStatus: async () => 'running', launchGraceMs: 5_000 });
  assert.equal((await liveRuntime.tick(live, { expectedVersion: 0, maxActiveNodes: 1 })).terminal, 'blocked');
  assert.equal(live.inspect().graph.nodes.find(value => value.id === 'api').status, 'blocked');
  const absent = memoryInstance({ ...initial, version: 0 });
  const absentRuntime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not relaunch'); } }, now: () => NOW + 6_000, launchFor, processStatus: async () => 'absent', launchGraceMs: 5_000 });
  assert.equal((await absentRuntime.tick(absent, { expectedVersion: 0, maxActiveNodes: 1 })).terminal, 'blocked');
});

test('started intent liveness rejects missing unsafe future and mismatched durable bindings', async () => {
  const cases = [
    ['missing startedAtMs', intent => { delete intent.startedAtMs; }],
    ['negative startedAtMs', intent => { intent.startedAtMs = -1; }],
    ['fractional startedAtMs', intent => { intent.startedAtMs = 1.5; }],
    ['unsafe startedAtMs', intent => { intent.startedAtMs = Number.MAX_SAFE_INTEGER + 1; }],
    ['future startedAtMs', intent => { intent.startedAtMs = NOW + 1; }],
    ['intent node mismatch', intent => { intent.nodeId = 'design'; }],
    ['node status mismatch', (_intent, initial) => { initial.graph.nodes.find(node => node.id === 'api').status = 'reserved'; }],
    ['running node missing intent', (_intent, initial) => { delete initial.launchIntents.api; }],
    ['running node non-started intent', intent => { intent.status = 'prepared'; delete intent.startedAtMs; }],
  ];
  for (const [label, mutate] of cases) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'api').status = 'running';
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.attempts.api = 1;
    initial.launchIntents.api = durableApiIntent();
    mutate(initial.launchIntents.api, initial);
    const instance = memoryInstance({ ...initial, version: 0 });
    let processChecks = 0;
    const runtime = createOrchestrator({
      client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } },
      now: () => NOW, launchFor, launchGraceMs: 100,
      processStatus: async () => { processChecks += 1; return 'running'; },
    });
    await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input', label);
    assert.equal(instance.inspect().version, 0, label);
    assert.equal(processChecks, 0, label);
  }
});

test('started intent binding validation runs after a pending reserved-to-running transition replays', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  initial.attempts.api = 1;
  initial.launchIntents.api = durableApiIntent();
  initial.events = [{
    schemaVersion: 1, eventId: 'runtime-1', graphId: initial.graph.id, sequence: 1, timestamp: new Date(NOW).toISOString(),
    actor: { role: 'system', id: 'runtime' }, type: 'state-transition', nodeId: 'api', priorState: 'reserved', newState: 'running',
  }];
  initial.appliedSequence = 0;
  const instance = memoryInstance({ ...initial, version: 0 });
  let processChecks = 0;
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } },
    now: () => NOW, launchFor, launchGraceMs: 100,
    processStatus: async () => { processChecks += 1; return 'running'; },
  });
  const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(result.terminal, null);
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'api').status, 'running');
  assert.equal(instance.inspect().launchIntents.api.status, 'started');
  assert.equal(processChecks, 0);
});

test('durable launch intents reject unsafe structure identity status and node bindings before effects', async () => {
  const cases = [
    ['prepared nodeId mismatch', context => { context.intent.nodeId = 'design'; }],
    ['intent stored under wrong key', context => { context.initial.launchIntents.design = context.intent; delete context.initial.launchIntents.api; }],
    ['intent references missing node', context => { context.intent.nodeId = 'missing-node'; context.initial.launchIntents['missing-node'] = context.intent; delete context.initial.launchIntents.api; }],
    ['unsafe intent id', context => { context.intent.id = '../launch-api'; }],
    ['unsafe reservation id', context => { context.intent.reservationId = '../api-lease'; }],
    ['zero attempt', context => { context.intent.attempt = 0; }],
    ['unsafe attempt', context => { context.intent.attempt = Number.MAX_SAFE_INTEGER + 1; }],
    ['missing event sequence', context => { delete context.intent.eventSequence; }],
    ['negative event sequence', context => { context.intent.eventSequence = -1; }],
    ['bogus status', context => { context.intent.status = 'unknown'; }],
    ['missing idempotency key', context => { delete context.intent.idempotencyKey; }],
    ['forged idempotency key', context => { context.intent.idempotencyKey = 'demo-instance:api:2'; }],
    ['missing allocation', context => { delete context.intent.allocation; }],
    ['negative token allocation', context => { context.intent.allocation.tokenLimit = -1; }],
    ['zero time allocation', context => { context.intent.allocation.timeMinutes = 0; }],
    ['negative cost allocation', context => { context.intent.allocation.costUsd = '-0.01'; }],
    ['over-budget task allocation', context => { context.intent.allocation.taskLimit = 2; }],
    ['unknown allocation field', context => { context.intent.allocation.privateBudget = 1; }],
    ['prepared missing worktree', context => { delete context.intent.worktree; }],
    ['prepared empty worktree', context => { context.intent.worktree = {}; }],
    ['prepared worktree reservation mismatch', context => { context.intent.worktree.reservationId = 'other-lease'; }],
    ['prepared worktree unknown field', context => { context.intent.worktree.owner = 'attacker'; }],
    ['prepared worktree secret path', context => { context.intent.worktree.path = '/tmp/password=private-canary'; }],
    ['prepared oversized worktree', context => { context.intent.worktree = { details: 'x'.repeat(16_385) }; }],
    ['unknown secret-bearing intent field', context => { context.intent.privateNote = 'password=private-canary'; }],
    ['complete negative retry timestamp', context => {
      context.intent.status = 'complete'; context.intent.retryAtMs = -1;
      context.initial.graph.nodes.find(node => node.id === 'api').status = 'completed';
    }],
    ['complete unsafe retained start timestamp', context => {
      context.intent.status = 'complete'; context.intent.startedAtMs = Number.MAX_SAFE_INTEGER + 1;
      context.initial.graph.nodes.find(node => node.id === 'api').status = 'completed';
    }],
    ['recovered fractional retained start timestamp', context => {
      context.intent.status = 'recovered'; context.intent.startedAtMs = 1.5;
      context.initial.graph.nodes.find(node => node.id === 'api').status = 'ready';
    }],
    ['committed node mismatch', context => { context.intent.status = 'committed'; context.initial.graph.nodes.find(node => node.id === 'api').status = 'ready'; }],
    ['prepared node mismatch', context => { context.initial.graph.nodes.find(node => node.id === 'api').status = 'ready'; }],
    ['complete node mismatch', context => { context.intent.status = 'complete'; }],
    ['recovered node mismatch', context => { context.intent.status = 'recovered'; context.initial.graph.nodes.find(node => node.id === 'api').status = 'blocked'; }],
  ];
  for (const [label, mutate] of cases) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.attempts.api = 1;
    const intent = {
      id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1, idempotencyKey: 'demo-instance:api:1',
      allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 }, status: 'prepared', eventSequence: 0,
      worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' },
    };
    initial.launchIntents.api = intent;
    mutate({ initial, intent });
    const instance = memoryInstance({ ...initial, version: 0 });
    let clientStarts = 0; let preparations = 0; let processChecks = 0;
    const runtime = createOrchestrator({
      client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('must not launch'); } },
      now: () => NOW, launchFor, launchGraceMs: 100,
      prepareWorktree: async () => { preparations += 1; throw new Error('must not prepare'); },
      processStatus: async () => { processChecks += 1; return 'running'; },
    });
    await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }), error => (
      error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input'
      && !JSON.stringify(error).includes('private-canary') && !error.message.includes('private-canary')
    ), label);
    assert.equal(instance.inspect().version, 0, label);
    assert.deepEqual([clientStarts, preparations, processChecks], [0, 0, 0], label);
  }
});

test('a valid prepared intent restarts once with a canonical allocation inside its node budget', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  initial.attempts.api = 1;
  initial.launchIntents.api = {
    id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1,
    idempotencyKey: 'demo-instance:api:1',
    allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 },
    status: 'prepared', eventSequence: 0,
    worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' },
  };
  const instance = memoryInstance({ ...initial, version: 0 }); let starts = 0;
  const fake = createFakeClient({ scripts: [{
    version: 1, kind: 'success', output: { summary: 'done', evidence: ['api-commit', 'api-test'] },
    usage: { tokens: 1, costUsd: 0 },
  }] });
  const runtime = createOrchestrator({
    client: { provider: 'fake', launch: async (...args) => { starts += 1; return fake.launch(...args); } },
    now: () => NOW, launchFor,
  });

  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(starts, 1);
  assert.equal(instance.inspect().launchIntents.api.status, 'complete');
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'api').status, 'completed');
});

test('durable launch intents reject cross-record identity budget reservation and retry deadline drift', async t => {
  const retryEvent = nodeId => ({
    schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId, sequence: 1,
    timestamp: new Date(NOW).toISOString(), actor: { role: 'worker', id: `${nodeId}-worker` },
    type: 'retry', retryReason: 'provider-transient',
  });
  const secondIntent = (reservationId = 'design-lease') => ({
    id: 'launch-design-1', nodeId: 'design', reservationId, attempt: 1,
    idempotencyKey: 'demo-instance:design:1',
    allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 },
    status: 'committed', eventSequence: 0,
  });
  const activateDesign = (initial, reservationId) => {
    initial.graph.nodes.find(node => node.id === 'design').status = 'reserved';
    initial.attempts.design = 1; initial.launchIntents.design = secondIntent(reservationId);
  };
  const cases = [
    ['allocation is not exact remaining node budget', initial => { initial.nodeUsage = { api: { tokens: 1, costUsd: '0', timeMinutes: 0, tasks: 0 } }; }],
    ['arbitrary launch intent id', initial => { initial.launchIntents.api.id = 'other-intent'; }],
    ['intent attempt differs from state attempt', initial => { initial.attempts.api = 2; }],
    ['active intent exceeds the trusted retry attempt limit', initial => {
      initial.attempts.api = 4; initial.launchIntents.api.attempt = 4;
      initial.launchIntents.api.id = 'launch-api-4'; initial.launchIntents.api.idempotencyKey = 'demo-instance:api:4';
    }],
    ['active reservation is duplicated', initial => { activateDesign(initial, 'api-lease'); }],
    ['active worktree path is duplicated across distinct leases', initial => {
      activateDesign(initial);
      initial.launchIntents.design.status = 'prepared';
      initial.launchIntents.design.worktree = { path: '/tmp/api-prepared', dev: '2', ino: '2', reservationId: 'design-lease' };
    }],
    ['active worktree device and inode are duplicated across distinct paths and leases', initial => {
      activateDesign(initial);
      initial.launchIntents.design.status = 'prepared';
      initial.launchIntents.design.worktree = { path: '/tmp/design-prepared', dev: '1', ino: '1', reservationId: 'design-lease' };
    }],
    ['active reservations exceed global remaining budget', initial => {
      activateDesign(initial); initial.limits = { tokenLimit: 1500, costUsd: '10', timeMinutes: 100, taskLimit: 10, retries: 2 };
    }],
    ['active reservations exceed ancestor remaining budget', initial => {
      activateDesign(initial); initial.graph.nodes.find(node => node.id === 'manager-plan').budget.tokenLimit = 1500;
    }],
    ['intent retry deadline has no durable retry fact', initial => {
      const nodeValue = initial.graph.nodes.find(node => node.id === 'api'); nodeValue.status = 'corrective';
      initial.launchIntents.api.status = 'complete'; initial.launchIntents.api.retryAtMs = NOW + 100;
      initial.attempts.api = 2;
    }],
    ['intent retry deadline exceeds the trusted maximum delay', initial => {
      const nodeValue = initial.graph.nodes.find(node => node.id === 'api'); nodeValue.status = 'corrective';
      initial.launchIntents.api.status = 'complete'; initial.launchIntents.api.retryAtMs = NOW + 3_600_001;
      initial.attempts.api = 2; initial.events = [retryEvent('api')]; initial.appliedSequence = 1;
    }],
    ['intent retry deadline departs from the trusted runtime policy', initial => {
      const nodeValue = initial.graph.nodes.find(node => node.id === 'api'); nodeValue.status = 'corrective';
      initial.launchIntents.api.status = 'complete'; initial.launchIntents.api.retryAtMs = NOW + 200;
      initial.attempts.api = 2; initial.events = [retryEvent('api')]; initial.appliedSequence = 1;
    }],
    ['state retry map targets an unknown node', initial => { initial.retryAtMs = { missing: NOW + 100 }; }],
    ['state retry deadline has the wrong node status', initial => {
      initial.graph.nodes.find(node => node.id === 'api').status = 'ready'; delete initial.launchIntents.api;
      initial.retryAtMs = { api: NOW + 100 }; initial.attempts.api = 2;
      initial.events = [retryEvent('api')]; initial.appliedSequence = 1;
    }],
    ['state retry deadline is negative', initial => { initial.retryAtMs = { api: -1 }; }],
    ['state retry deadline reaches the unsafe integer boundary', initial => { initial.retryAtMs = { api: Number.MAX_SAFE_INTEGER }; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const initial = memoryInstance({ activated: true }).inspect();
      initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
      initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
      initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
      initial.attempts.api = 1;
      initial.launchIntents.api = {
        ...durableApiIntent('prepared'),
        worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' },
      };
      mutate(initial);
      const instance = memoryInstance({ ...initial, version: 0 }); let processChecks = 0; let clientStarts = 0;
      const runtime = createOrchestrator({
        client: { provider: 'fake', launch: async () => { clientStarts += 1; throw new Error('must not launch'); } },
        now: () => NOW, launchFor, launchGraceMs: 100,
        processStatus: async () => { processChecks += 1; return 'running'; },
        retryPolicy: createRetryPolicy({ maxAttempts: 3, delaysMs: [100, 200], retryable: ['provider-transient'] }),
      });
      await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 2 }), error => (
        error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input'
      ));
      assert.equal(instance.inspect().version, 0);
      assert.deepEqual([clientStarts, processChecks], [0, 0]);
    });
  }
});

test('valid concurrent reservations and complete historical intents preserve canonical restart state', async () => {
  const active = memoryInstance({ activated: true }).inspect();
  for (const id of ['api', 'design']) active.graph.nodes.find(node => node.id === id).status = 'reserved';
  active.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  active.attempts = { api: 2, design: 3 };
  active.launchIntents.api = durableApiIntent('prepared', {
    id: 'launch-api-2', attempt: 2, idempotencyKey: 'demo-instance:api:2',
    worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' },
  });
  active.launchIntents.design = {
    id: 'launch-design-3', nodeId: 'design', reservationId: 'design-lease', attempt: 3,
    idempotencyKey: 'demo-instance:design:3',
    allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 },
    status: 'prepared', eventSequence: 0,
    worktree: { path: '/tmp/design-prepared', dev: '2', ino: '2', reservationId: 'design-lease' },
  };
  active.limits = { tokenLimit: 2000, costUsd: '2', timeMinutes: 20, taskLimit: 2, retries: 2 };
  const activeState = await runtimeTransaction(memoryInstance({ ...active, version: 0 }), 0, () => null, [100, 200]);
  assert.deepEqual(Object.keys(activeState.launchIntents).sort(), ['api', 'design']);

  const historical = structuredClone(active);
  for (const id of ['api', 'design']) historical.graph.nodes.find(node => node.id === id).status = 'completed';
  historical.attempts = { api: 4, design: 5 };
  historical.launchIntents.api.status = 'complete'; historical.launchIntents.design.status = 'complete';
  historical.launchIntents.design.reservationId = 'api-lease';
  historical.launchIntents.design.worktree = { ...historical.launchIntents.api.worktree };
  const historicalState = await runtimeTransaction(memoryInstance({ ...historical, version: 0 }), 0, () => null, [100, 200]);
  assert.equal(historicalState.launchIntents.api.reservationId, historicalState.launchIntents.design.reservationId);
  assert.equal(historicalState.launchIntents.api.worktree.path, historicalState.launchIntents.design.worktree.path);
  assert.deepEqual(
    [historicalState.launchIntents.api.worktree.dev, historicalState.launchIntents.api.worktree.ino],
    [historicalState.launchIntents.design.worktree.dev, historicalState.launchIntents.design.worktree.ino],
  );
});

test('durable usage ledgers reject negative unknown and cross-ledger fail-open state while preserving exact decimals', async t => {
  const usage = (tokens = 0, costUsd = '0', timeMinutes = 0, tasks = 0) => ({ tokens, costUsd, timeMinutes, tasks });
  const globalUsage = (tokens = 0, costUsd = '0', timeMinutes = 0, taskLimit = 0) => ({ tokens, costUsd, retries: 0, timeMinutes, taskLimit });
  const cases = [
    ['negative counters', initial => {
      initial.nodeUsage = { api: usage(-1) }; initial.usage = globalUsage(-1);
      initial.delegatedUsage = { 'manager-plan': usage(-1), 'boss-plan': usage(-1) };
    }],
    ['global usage omits actual node usage', initial => { initial.nodeUsage = { api: usage(100) }; initial.usage = globalUsage(); }],
    ['delegated usage omits descendant usage', initial => { initial.nodeUsage = { api: usage(100) }; initial.usage = globalUsage(100); }],
    ['usage references an unknown node', initial => { initial.nodeUsage = { missing: usage() }; }],
    ['node usage contains an unknown counter', initial => { initial.nodeUsage = { api: { ...usage(), credits: 1 } }; }],
    ['global usage contains an unknown counter', initial => { initial.usage = { ...globalUsage(), credits: 1 }; }],
    ['global usage omits a required counter', initial => { initial.usage = { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0 }; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const initial = memoryInstance({ activated: true }).inspect(); mutate(initial);
    await assert.rejects(() => runtimeTransaction(memoryInstance({ ...initial, version: 0 }), 0, () => null), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  });

  await t.test('valid exact aggregate and descendant ledgers', async () => {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.nodeUsage = { api: usage(100, '0.10', 1, 1) };
    initial.usage = globalUsage(100, '0.1', 1, 1);
    initial.delegatedUsage = { 'manager-plan': usage(100, '0.100', 1, 1), 'boss-plan': usage(100, '0.10', 1, 1) };
    const state = await runtimeTransaction(memoryInstance({ ...initial, version: 0 }), 0, () => null);
    assert.equal(state.nodeUsage.api.costUsd, '0.10');
  });
});

test('retry deadlines bind to the exact next attempt schedule including zero delay and maxAttempts one', async () => {
  const retryEvent = (sequence, timestamp = NOW) => ({
    schemaVersion: 1, eventId: `runtime-${sequence}`, graphId: 'demo-graph', nodeId: 'api', sequence,
    timestamp: new Date(timestamp).toISOString(), actor: { role: 'worker', id: 'api-worker' },
    type: 'retry', retryReason: 'provider-transient',
  });
  for (const [attempt, delaysMs, retryAtMs, events] of [
    [2, [100, 200], NOW + 100, [retryEvent(1)]],
    [3, [100, 200], NOW + 200, [retryEvent(1), retryEvent(2)]],
    [3, [0, 0], NOW, [retryEvent(1), retryEvent(2)]],
  ]) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'api').status = 'corrective';
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.attempts.api = attempt; initial.events = events; initial.appliedSequence = events.length; initial.usage.retries = events.length;
    initial.launchIntents.api = durableApiIntent('complete', { retryAtMs });
    const state = await runtimeTransaction(memoryInstance({ ...initial, version: 0 }), 0, () => null, delaysMs);
    assert.equal(state.attempts.api, attempt);
    assert.equal(state.launchIntents.api.retryAtMs, retryAtMs);
  }

  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'api').status = 'reserved';
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  initial.attempts.api = 1; initial.launchIntents.api = durableApiIntent('committed');
  const state = await runtimeTransaction(memoryInstance({ ...initial, version: 0 }), 0, () => null, []);
  assert.equal(state.launchIntents.api.attempt, 1);
});

test('canonical durable launch intent bindings accept every valid lifecycle status', async () => {
  for (const [status, nodeStatus] of [['committed', 'reserved'], ['prepared', 'reserved'], ['started', 'running'], ['complete', 'completed'], ['recovered', 'ready']]) {
    const initial = memoryInstance({ activated: true }).inspect();
    initial.graph.nodes.find(node => node.id === 'api').status = nodeStatus;
    initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
    initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
    initial.attempts.api = 1;
    initial.launchIntents.api = {
      id: 'launch-api-1', nodeId: 'api', reservationId: 'api-lease', attempt: 1, idempotencyKey: 'demo-instance:api:1',
      allocation: { timeMinutes: 10, tokenLimit: 1000, costUsd: '1', taskLimit: 1 }, status, eventSequence: 0,
      ...(status === 'prepared' ? { worktree: { path: '/tmp/api-prepared', dev: '1', ino: '1', reservationId: 'api-lease' } } : {}),
      ...(status === 'started' ? { startedAtMs: NOW } : {}),
    };
    const instance = memoryInstance({ ...initial, version: 0 });
    const state = await runtimeTransaction(instance, 0, () => null);
    assert.equal(state.launchIntents.api.status, status);
    assert.equal(state.graph.nodes.find(node => node.id === 'api').status, nodeStatus);
    assert.equal(instance.inspect().version, 0);
  }
});

test('retries allocate only the cumulative per-node budget remaining across attempts', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'api').budget.taskLimit = 2;
  const instance = memoryInstance({ ...initial, version: 0 }); const allocations = [];
  const fake = createFakeClient({ scripts: [
    { version: 1, kind: 'retry', output: { summary: 'retry', evidence: [] }, usage: { tokens: 600, costUsd: 0 } },
    { version: 1, kind: 'success', output: { summary: 'done', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 400, costUsd: 0 } },
  ] });
  const runtime = createOrchestrator({ client: fake, now: () => NOW, reservationId: id => `${id}-lease`, launchFor: (nodeValue, intent) => { allocations.push(intent.allocation.tokenLimit); return { ...launchFor(nodeValue, intent), budget: { ...launchFor(nodeValue, intent).budget, maxTokens: intent.allocation.tokenLimit } }; } });
  let result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  result = await runtime.tick(instance, { expectedVersion: result.version, maxActiveNodes: 1 });
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'api').status, 'completed');
  assert.deepEqual(allocations, [1000, 400]);
  assert.equal(instance.inspect().nodeUsage.api.tokens, 1000);
});

test('runtime measures elapsed attempt time when the client omits time usage', async () => {
  let nowMs = NOW; const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { nowMs += 60_000; return { version: 1, status: 'success', output: { summary: 'done', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }; } }, now: () => nowMs, launchFor, reservationId: id => `${id}-lease` });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(instance.inspect().nodeUsage.api.timeMinutes, 1);
});

test('manual retry uses the runtime retry policy instead of caller-forged state limits', async () => {
  const initial = memoryInstance({ activated: true }).inspect(); initial.graph.nodes.find(value => value.id === 'api').status = 'blocked';
  const instance = memoryInstance({ ...initial, version: 0, limits: { tokens: 10000, costUsd: 10, retries: 99 } });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor, retryPolicy: createRetryPolicy({ maxAttempts: 1, delaysMs: [], retryable: ['provider-transient'] }) });
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.retry'], ownedPaths: [], providers: [], commands: [] });
  await assert.rejects(() => runtime.retryNode(instance, { expectedVersion: 0, nodeId: 'api', authority, reason: 'manual retry' }), error => error instanceof RuntimeError);
});

test('approval actions and policies derive from the explicit human gate kind', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  for (const id of ['api', 'design', 'integration']) initial.graph.nodes.find(value => value.id === id).status = 'completed';
  const finalGate = initial.graph.nodes.find(value => value.id === 'human-final'); finalGate.status = 'ready'; finalGate.dependencies = ['human-publication'];
  initial.graph.nodes.splice(-1, 0, node('human-publication', ['integration'], {
    parentId: 'boss-plan', owner: { role: 'boss', id: 'portfolio-boss' }, authorityScopes: ['verify'], completionProfile: 'delivery',
    requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], evidenceRefs: ['publication-commit', 'publication-test', 'publication-review', 'publication-approval'], approvalGate: 'publication', status: 'ready',
  }));
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const approvalValue = boundApproval({ id: 'publication-approval', subjectId: 'portfolio-boss', action: 'publication', resource: 'demo-instance:human-publication', policyId: 'authority.human-gate.publication' });
  const state = await runtime.approveNode(instance, { expectedVersion: 0, nodeId: 'human-publication', evidence: [
    { id: 'publication-approval', type: 'human-approval' }, { id: 'publication-review', type: 'review' }, { id: 'publication-test', type: 'test' }, { id: 'publication-commit', type: 'commit' },
  ], ...approvalValue });
  assert.equal(state.graph.nodes.find(value => value.id === 'human-publication').status, 'completed');
  assert.ok(state.evidence.some(item => item.id === 'publication-approval' && item.type === 'human-approval'));
  assert.equal(state.terminal, null);
});

test('approval ingress preserves the submitted receipt evidence pair', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  for (const id of ['api', 'design', 'integration']) initial.graph.nodes.find(value => value.id === id).status = 'completed';
  const finalGate = initial.graph.nodes.find(value => value.id === 'human-final'); finalGate.status = 'ready';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW, launchFor });
  const approvalValue = boundApproval({ id: 'final-approval', subjectId: 'portfolio-boss', action: 'final-delivery', resource: 'demo-instance:human-final', policyId: 'authority.human-gate.final-delivery' });
  await assert.rejects(() => runtime.approveNode(instance, { expectedVersion: 0, nodeId: 'human-final', evidence: [
    { id: 'final-approval', type: 'commit' }, { id: 'final-commit', type: 'human-approval' },
    { id: 'final-test', type: 'test' }, { id: 'final-review', type: 'review' },
  ], ...approvalValue }), error => error instanceof RuntimeError && error.details.reason === 'approval-required');
  assert.equal(instance.inspect().graph.nodes.find(value => value.id === 'human-final').status, 'ready');
  assert.deepEqual(instance.inspect().evidence, []);
});

test('a never-settling process registry check is bounded and fails with a sanitized runtime error', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'api').status = 'running';
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed';
  initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  initial.attempts.api = 1;
  initial.launchIntents.api = durableApiIntent();
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw new Error('must not launch'); } }, now: () => NOW + 1_000, launchFor, processStatus: async () => new Promise(() => {}), launchGraceMs: 100 });
  const outcome = await Promise.race([
    runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }).then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
  ]);
  assert.notEqual(outcome, 'hung');
  assert.equal(outcome instanceof RuntimeError, true);
});

test('global task and exact decimal cost reservations bound parallel candidates', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(nodeValue => nodeValue.id === 'api').budget.costUsd = 0.1;
  initial.graph.nodes.find(nodeValue => nodeValue.id === 'design').budget.costUsd = 0.2;
  const instance = memoryInstance({ ...initial, version: 0, limits: { tokenLimit: 10_000, costUsd: '0.3', timeMinutes: 100, taskLimit: 1, retries: 2 } });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'api', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0.1 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.deepEqual(result.launched, ['api']);
});

test('parent remaining task reservations bound parallel child candidates', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(nodeValue => nodeValue.id === 'manager-plan').budget.taskLimit = 1;
  const instance = memoryInstance({ ...initial, version: 0, limits: { tokenLimit: 10_000, costUsd: '10', timeMinutes: 100, taskLimit: 10, retries: 2 } });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'api', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  const result = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.deepEqual(result.launched, ['api']);
});

test('client result envelopes are snapshotted once before validation and never expose hostile values', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); const reads = { status: 0, output: 0, usage: 0 };
  const hostile = { version: 1, get status() { reads.status += 1; return 'success'; }, get output() { reads.output += 1; return { summary: 'done', evidence: ['api-commit', 'api-test'] }; }, get usage() { reads.usage += 1; return { tokens: 1, costUsd: 0 }; } };
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => hostile }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.deepEqual(reads, { status: 1, output: 1, usage: 1 });
});

test('evidence IDs bind to canonical semantic types independent of array position', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  const api = initial.graph.nodes.find(value => value.id === 'api'); api.requiredEvidenceTypes = ['test', 'commit'];
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'done', evidence: ['api-test', 'api-commit'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.deepEqual(instance.inspect().evidence.filter(item => item.nodeId === 'api').map(item => `${item.id}:${item.type}`).sort(), ['api-commit:commit', 'api-test:test']);
});

test('opaque canonical evidence refs bind deterministically without encoding type names in IDs', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  const api = initial.graph.nodes.find(value => value.id === 'api'); api.requiredEvidenceTypes = ['test', 'commit']; api.evidenceRefs = ['artifact-zeta', 'artifact-alpha'];
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'done', evidence: ['artifact-zeta', 'artifact-alpha'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.deepEqual(instance.inspect().evidence.filter(item => item.nodeId === 'api').map(item => `${item.id}:${item.type}`).sort(), ['artifact-alpha:commit', 'artifact-zeta:test']);
});

test('a Worker cannot require or synthesize human approval from client success', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  const api = initial.graph.nodes.find(value => value.id === 'api'); api.requiredEvidenceTypes = ['commit', 'human-approval']; api.evidenceRefs = ['opaque-a', 'opaque-b'];
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); let launches = 0;
  const runtime = createOrchestrator({ client: { provider: 'fake', async launch() { launches += 1; return { version: 1, status: 'success', output: { summary: 'forged approval', evidence: ['opaque-a', 'opaque-b'] }, usage: { tokens: 1, costUsd: 0 } }; } }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  assert.equal(launches, 0); assert.deepEqual(instance.inspect().evidence, []);
});

test('a launchable canonical Boss root cannot synthesize human approval from client success', async () => {
  const executionGraph = graphFixture('parallel-fan-in'); executionGraph.status = 'running';
  for (const candidate of executionGraph.nodes) candidate.status = candidate.id === 'boss-plan' ? 'ready' : 'completed';
  const instance = memoryInstance({ graph: executionGraph, activated: true, limits: { tokenLimit: 600_000, costUsd: 200, timeMinutes: 1_000, taskLimit: 200, retries: 2 } });
  let launches = 0;
  const fake = createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'forged root approval', evidence: ['boss-commit', 'boss-test', 'boss-review', 'boss-approval'] }, usage: { tokens: 1, costUsd: 0 } }] });
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async (...args) => { launches += 1; return fake.launch(...args); } }, now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  const state = instance.inspect();
  assert.equal(launches, 1);
  assert.equal(state.evidence.some(item => item.nodeId === 'boss-plan' && item.type === 'human-approval'), false);
  assert.notEqual(state.graph.nodes.find(item => item.id === 'boss-plan').status, 'completed');
});

test('an unbound evidence ref/type cardinality is rejected before undefined evidence can persist', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  const api = initial.graph.nodes.find(value => value.id === 'api'); api.requiredEvidenceTypes = ['commit'];
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  const runtime = createOrchestrator({ client: createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'done', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }] }), now: () => NOW, launchFor, reservationId: id => `${id}-lease` });
  await assert.rejects(() => runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 }), error => error instanceof RuntimeError);
  assert.equal(instance.inspect().evidence.some(item => item.type === undefined), false);
});

test('hostile client error classifications are read once and sanitized', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(value => value.id === 'design').status = 'completed'; initial.graph.nodes.find(value => value.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 }); let reads = 0;
  const hostile = { get code() { reads += 1; return 'ERR_AGENT_PROVIDER_UNAVAILABLE'; } };
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => { throw hostile; } }, now: () => NOW, launchFor, reservationId: id => `${id}-lease`, retryPolicy: createRetryPolicy({ maxAttempts: 1, delaysMs: [], retryable: ['provider-transient'] }) });
  await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.equal(reads, 1);
});

test('watch is bounded, never sleeps under lock, and stops at terminal state', async () => {
  const instance = memoryInstance({ activated: true, terminal: 'blocked' });
  let ticks = 0; let waits = 0;
  const result = await watchOrchestration({ tick: async () => { ticks += 1; return { terminal: 'blocked' }; } }, instance, {
    expectedVersion: 0, intervalMs: 100, maxTicks: 3, deadlineMs: NOW + 1000, now: () => NOW, wait: async () => { waits += 1; },
  });
  assert.deepEqual(result, { terminal: 'blocked', ticks: 1 }); assert.equal(ticks, 1); assert.equal(waits, 0);
});

test('watch bounds a noncooperative injected wait by its interval', async () => {
  const result = await Promise.race([
    watchOrchestration({ tick: async (_instance, { expectedVersion }) => ({ version: expectedVersion + 1, terminal: null }) }, memoryInstance({ activated: true }), {
      expectedVersion: 0, intervalMs: 20, maxTicks: 2, deadlineMs: NOW + 1000, now: () => NOW, wait: async () => new Promise(() => {}),
    }),
    new Promise(resolve => setTimeout(() => resolve({ terminal: 'hung' }), 100)),
  ]);
  assert.deepEqual(result, { terminal: 'max-ticks', ticks: 2 });
});

test('watch bounds a noncooperative active tick by the deadline and aborts its signal', async () => {
  let tickSignal;
  const result = await Promise.race([
    watchOrchestration({ tick: async (_instance, options) => {
      tickSignal = options.signal;
      return new Promise(() => {});
    } }, memoryInstance({ activated: true }), {
      expectedVersion: 0, intervalMs: 20, maxTicks: 2, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
    }),
    new Promise(resolve => setTimeout(() => resolve({ terminal: 'hung' }), 150)),
  ]);
  assert.deepEqual(result, { terminal: 'deadline', ticks: 1 });
  assert.equal(tickSignal?.aborted, true);
});

test('watch consumes a late tick rejection after returning its deadline result', async () => {
  let rejectTick;
  let unhandled = 0;
  const listener = () => { unhandled += 1; };
  process.on('unhandledRejection', listener);
  try {
    const watched = await Promise.race([
      watchOrchestration({ tick: async () => new Promise((_resolve, reject) => { rejectTick = reject; }) }, memoryInstance({ activated: true }), {
        expectedVersion: 0, intervalMs: 20, maxTicks: 2, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
      }),
      new Promise(resolve => setTimeout(() => resolve({ terminal: 'hung' }), 150)),
    ]);
    assert.deepEqual(watched, { terminal: 'deadline', ticks: 1 });
    rejectTick(new Error('late-tick-private-canary'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
});

test('watch captures its optional signal getter once', async () => {
  const controller = new AbortController(); let reads = 0;
  const result = await watchOrchestration({ tick: async () => ({ version: 1, terminal: 'blocked' }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 20,
    maxTicks: 1,
    deadlineMs: NOW + 20,
    now: () => NOW,
    wait: async () => {},
    get signal() { reads += 1; return controller.signal; },
  });
  assert.deepEqual(result, { terminal: 'blocked', ticks: 1 });
  assert.equal(reads, 1);
});

test('watch sanitizes a hostile optional signal getter after one access', async () => {
  let reads = 0;
  await assert.rejects(() => watchOrchestration({ tick: async () => ({ version: 1, terminal: 'blocked' }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 20,
    maxTicks: 1,
    deadlineMs: NOW + 20,
    now: () => NOW,
    wait: async () => {},
    get signal() { reads += 1; throw new Error('watch-signal-private-canary'); },
  }), error => error.code === 'ERR_RUNTIME_SUPERVISOR' && !JSON.stringify(error).includes('watch-signal-private-canary'));
  assert.equal(reads, 1);
});

test('watch captures a stateful runtime tick getter once', async () => {
  let reads = 0;
  const runtime = Object.defineProperty({}, 'tick', {
    enumerable: true,
    get() {
      reads += 1;
      if (reads === 1) return async () => ({ version: 1, terminal: 'blocked' });
      throw new Error('second-tick-getter-private-canary');
    },
  });
  const result = await watchOrchestration(runtime, memoryInstance({ activated: true }), {
    expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
  });
  assert.deepEqual(result, { terminal: 'blocked', ticks: 1 });
  assert.equal(reads, 1);
});

test('watch rejects extra, hidden, symbolic, and non-plain option shapes before tick', async () => {
  let ticks = 0;
  const runtime = { tick: async () => { ticks += 1; return { version: 1, terminal: 'blocked' }; } };
  const valid = { expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {} };
  const hidden = { ...valid }; Object.defineProperty(hidden, 'hidden', { value: true });
  const symbolic = { ...valid, [Symbol('hidden')]: true };
  const inherited = Object.assign(Object.create({ inherited: true }), valid);
  for (const input of [{ ...valid, unexpected: true }, hidden, symbolic, inherited]) {
    await assert.rejects(() => watchOrchestration(runtime, memoryInstance({ activated: true }), input), SupervisorError);
  }
  assert.equal(ticks, 0);
});

test('watch replaces hostile and forged tick failures without inspecting or leaking them', async () => {
  const canary = 'tick-rejection-private-canary'; let prototypeReads = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { prototypeReads += 1; throw new Error(canary); } });
  const forged = new SupervisorError('forged-tick-private-canary');
  for (const thrown of [hostile, forged]) {
    await assert.rejects(() => watchOrchestration({ tick: async () => { throw thrown; } }, memoryInstance({ activated: true }), {
      expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
    }), error => error instanceof SupervisorError && error !== forged && error.details.reason === 'tick-failed'
      && !JSON.stringify(error).includes('private-canary'));
  }
  assert.equal(prototypeReads, 0);
});

test('watch sanitizes a hostile signal value without inspecting or leaking it', async () => {
  const canary = 'signal-value-private-canary'; let prototypeReads = 0;
  const signal = new Proxy({}, { getPrototypeOf() { prototypeReads += 1; throw new Error(canary); } });
  await assert.rejects(() => watchOrchestration({ tick: async () => ({ version: 1, terminal: 'blocked' }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {}, signal,
  }), error => error instanceof SupervisorError && error.details.reason === 'invalid-watch'
    && !JSON.stringify(error).includes(canary));
  assert.equal(prototypeReads, 1);
});

test('watch relays a real AbortSignal proxy without invoking hostile listener getters', async () => {
  const canary = 'signal-listener-private-canary'; const controller = new AbortController(); let listenerReads = 0;
  const signal = new Proxy(controller.signal, {
    get(target, key) {
      if (key === 'addEventListener') { listenerReads += 1; throw new Error(canary); }
      return Reflect.get(target, key, target);
    },
  });
  const result = await watchOrchestration({ tick: async () => ({ version: 1, terminal: 'blocked' }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {}, signal,
  });
  assert.deepEqual(result, { terminal: 'blocked', ticks: 1 });
  assert.equal(listenerReads, 0);
});

test('watch snapshots hostile tick results before terminal and version reads', async () => {
  const canary = 'tick-result-private-canary'; let terminalReads = 0;
  const result = new Proxy({}, {
    get(_target, key) {
      if (key === 'terminal') { terminalReads += 1; throw new Error(canary); }
      return undefined;
    },
  });
  await assert.rejects(() => watchOrchestration({ tick: async () => result }, memoryInstance({ activated: true }), {
    expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
  }), error => error instanceof SupervisorError && error.details.reason === 'tick-output'
    && !JSON.stringify(error).includes(canary));
  assert.equal(terminalReads, 1);
});

test('watch maps external abort during cooperative wait to cancelled', async () => {
  const controller = new AbortController(); let enteredWait;
  const waitStarted = new Promise(resolve => { enteredWait = resolve; });
  const watched = watchOrchestration({ tick: async () => ({ version: 1, terminal: null }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 100,
    maxTicks: 2,
    deadlineMs: NOW + 1_000,
    now: () => NOW,
    signal: controller.signal,
    wait: async (_interval, signal) => new Promise((_resolve, reject) => {
      enteredWait();
      signal.addEventListener('abort', () => reject(new Error('cooperative-stop')), { once: true });
    }),
  });
  await waitStarted;
  controller.abort();
  assert.deepEqual(await watched, { terminal: 'cancelled', ticks: 1 });
});

test('watch sanitizes a stateful clock failure without retaining the thrown value', async () => {
  const canary = 'watch-clock-private-canary'; let clockReads = 0; let prototypeReads = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { prototypeReads += 1; throw new Error(canary); } });
  await assert.rejects(() => watchOrchestration({ tick: async () => ({ version: 1, terminal: null }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 20,
    maxTicks: 2,
    deadlineMs: NOW + 20,
    now: () => { clockReads += 1; if (clockReads === 1) return NOW; throw hostile; },
    wait: async () => {},
  }), error => error instanceof SupervisorError && error.details.reason === 'clock-failed'
    && !JSON.stringify(error).includes(canary));
  assert.equal(clockReads, 2);
  assert.equal(prototypeReads, 0);
});

test('watch rejects a regressing clock without extending the deadline', async () => {
  const observations = [NOW + 10, NOW]; let clockReads = 0; let waits = 0;
  await assert.rejects(() => watchOrchestration({ tick: async () => ({ version: 1, terminal: null }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 20,
    maxTicks: 2,
    deadlineMs: NOW + 100,
    now: () => { const value = observations[clockReads]; clockReads += 1; return value; },
    wait: async () => { waits += 1; },
  }), error => error instanceof SupervisorError && error.details.reason === 'clock-regressed');
  assert.equal(clockReads, 2);
  assert.equal(waits, 0);
});

test('watch sanitizes input proxy reflection traps before reading runtime tick', async () => {
  const canary = 'watch-input-private-canary'; let ticks = 0;
  const valid = { expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {} };
  for (const input of [
    new Proxy(valid, { getPrototypeOf() { throw new Error(`${canary}-prototype`); } }),
    new Proxy(valid, { ownKeys() { throw new Error(`${canary}-keys`); } }),
  ]) {
    await assert.rejects(() => watchOrchestration({ tick: async () => { ticks += 1; return { version: 1, terminal: 'blocked' }; } }, memoryInstance({ activated: true }), input),
      error => error instanceof SupervisorError && error.details.reason === 'invalid-watch'
        && !JSON.stringify(error).includes(canary));
  }
  assert.equal(ticks, 0);
});

test('watch does not overflow the platform timer for a distant safe deadline', async () => {
  const result = await watchOrchestration({ tick: async () => new Promise(resolve => {
    setTimeout(() => resolve({ version: 1, terminal: 'blocked' }), 10);
  }) }, memoryInstance({ activated: true }), {
    expectedVersion: 0,
    intervalMs: 20,
    maxTicks: 1,
    deadlineMs: NOW + 3_000_000_000,
    now: () => NOW,
    wait: async () => {},
  });
  assert.deepEqual(result, { terminal: 'blocked', ticks: 1 });
});

test('watch deadline stops observation while already-durable real runtime work may continue safely', async () => {
  const initial = memoryInstance({ activated: true }).inspect();
  initial.graph.nodes.find(node => node.id === 'design').status = 'completed';
  initial.graph.nodes.find(node => node.id === 'integration').status = 'completed';
  const instance = memoryInstance({ ...initial, version: 0 });
  let unhandled = 0;
  const listener = () => { unhandled += 1; };
  process.on('unhandledRejection', listener);
  try {
    const runtime = createOrchestrator({
      client: { provider: 'fake', launch: async () => new Promise(resolve => {
        setTimeout(() => resolve({ version: 1, status: 'success', output: { summary: 'late durable success', evidence: ['api-commit', 'api-test'] }, usage: { tokens: 1, costUsd: 0 } }), 40);
      }) },
      now: () => NOW,
      launchFor,
      reservationId: id => `${id}-lease`,
    });
    const watched = await watchOrchestration(runtime, instance, {
      expectedVersion: 0, intervalMs: 20, maxTicks: 1, deadlineMs: NOW + 20, now: () => NOW, wait: async () => {},
    });
    assert.deepEqual(watched, { terminal: 'deadline', ticks: 1 });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'api').status, 'completed');
    assert.equal(unhandled, 0);
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
});

test('public runtime inputs are snapshotted once and errors are sanitized', async () => {
  let accesses = 0;
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => {} }, now: () => NOW, launchFor });
  await assert.rejects(() => runtime.tick(memoryInstance({ activated: true }), {
    get expectedVersion() { accesses += 1; throw new Error('private-canary'); }, maxActiveNodes: 1,
  }), error => error instanceof RuntimeError && !JSON.stringify(error).includes('private-canary'));
  assert.equal(accesses, 1);
});

test('runtime cancellation snapshots the node identifier once before abort lookup', async () => {
  const initial = memoryInstance({ activated: true }).inspect(); initial.graph.nodes.find(value => value.id === 'api').status = 'blocked';
  const instance = memoryInstance({ ...initial, version: 0 }); let reads = 0;
  const runtime = createOrchestrator({ client: { provider: 'fake', launch: async () => {} }, now: () => NOW, launchFor });
  const authority = createAuthorityEnvelope({ actorId: 'engineering-manager', principal: 'agent', actions: ['orchestration.cancel'], ownedPaths: [], providers: [], commands: [] });
  await runtime.cancelNode(instance, { expectedVersion: 0, get nodeId() { reads += 1; return 'api'; }, authority });
  assert.equal(reads, 1);
});
