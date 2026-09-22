import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { validateEvent } from '../../src/config/validate.js';
import { RuntimeError } from '../../src/runtime/orchestrator.js';
import { cancelGoal, cancelNode, createCorrectiveNode, recoverRuntimeLock, recoverStalledNode, retryNode } from '../../src/runtime/recovery.js';
import { createRetryPolicy } from '../../src/runtime/retry.js';
import { goalsCancelGoal, goalsCancelNode, goalsEvents, goalsRetryNode, goalsStatus } from '../../src/commands/goals.js';

function recoveryGraph(workerOverrides = {}) {
  return {
    schemaVersion: 1, id: 'demo-graph', goal: 'Recover the demo safely', providerRefs: ['git-ci-main'], maxDelegationDepth: 3, status: 'running',
    nodes: [
      { id: 'boss-one', objective: 'Own recovery', owner: { role: 'boss', id: 'boss-owner' }, dependencies: [], authorityScopes: ['implement', 'verify'], budget: { timeMinutes: 60, tokenLimit: 5000, costUsd: 5, taskLimit: 5 }, completionProfile: 'delivery', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['boss-commit', 'boss-test'], status: 'completed' },
      { id: 'manager-one', parentId: 'boss-one', objective: 'Manage recovery', owner: { role: 'manager', id: 'manager-owner' }, dependencies: ['boss-one'], authorityScopes: ['implement', 'verify'], budget: { timeMinutes: 40, tokenLimit: 4000, costUsd: 4, taskLimit: 4 }, completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['manager-commit', 'manager-test'], status: 'completed' },
      { id: 'worker-one', parentId: 'manager-one', objective: 'Implement recovery', owner: { role: 'worker', id: 'worker-one-owner' }, dependencies: ['manager-one'], authorityScopes: ['implement'], budget: { timeMinutes: 20, tokenLimit: 1000, costUsd: 1, taskLimit: 2 }, completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['worker-commit', 'worker-test'], status: 'blocked', ...workerOverrides },
      { id: 'human-final', parentId: 'boss-one', objective: 'Approve recovery', owner: { role: 'boss', id: 'boss-owner' }, dependencies: ['worker-one'], authorityScopes: ['verify'], budget: { timeMinutes: 10, tokenLimit: 500, costUsd: 1, taskLimit: 1 }, completionProfile: 'delivery', requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], approvalGate: 'final-delivery', status: 'completed' },
    ],
  };
}

function instance(initial = {}) {
  let state = structuredClone({ schemaVersion: 1, version: 4, activated: true, terminal: null, graph: recoveryGraph(), events: [], attempts: { 'worker-one': 1 }, launchIntents: {}, heartbeats: {}, evidence: [], usage: { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0, taskLimit: 0 }, limits: { tokens: 10000, costUsd: '10', retries: 2 }, ...initial });
  let locked = false;
  return {
    id: 'demo-instance',
    async acquire() { locked = true; return { release: async () => { locked = false; } }; },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expected, next) { assert.equal(expected, state.version); state = structuredClone(next); return structuredClone(state); },
    inspect: () => structuredClone(state),
  };
}

function authority(actorId, actions, principal = 'agent') {
  return createAuthorityEnvelope({ actorId, principal, actions, ownedPaths: [], providers: [], commands: [] });
}

function recoveryAuthority() {
  return createAuthorityEnvelope({ actorId: 'recovery-admin', principal: 'agent', actions: ['orchestration.recover'], ownedPaths: [], providers: [], commands: [] });
}

function durableWorkerIntent(overrides = {}) {
  return {
    id: 'launch-worker-one-1', nodeId: 'worker-one', reservationId: 'worker-lease', attempt: 1,
    idempotencyKey: 'demo-instance:worker-one:1',
    allocation: { timeMinutes: 20, tokenLimit: 1000, costUsd: '1', taskLimit: 2 },
    status: 'started', startedAtMs: 0, eventSequence: 0, ...overrides,
  };
}

test('read-only goal commands return immutable bounded snapshots without committing', async () => {
  const value = instance(); const before = value.inspect();
  const status = await goalsStatus(value); const events = await goalsEvents(value, { limit: 10 });
  assert.deepEqual(value.inspect(), before); assert.equal(status.version, 4); assert.equal(events.length, 0);
  assert.ok(Object.isFrozen(status)); assert.ok(Object.isFrozen(events));
});

test('read commands reject invalid terminal state and omit raw event payload and actor identity', async () => {
  const unsafe = instance({ terminal: 'secret=private-canary' });
  await assert.rejects(() => goalsStatus(unsafe), error => !JSON.stringify(error).includes('private-canary'));
  const event = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1, timestamp: '1970-01-01T00:00:00.000Z', actor: { role: 'manager', id: 'manager-owner' }, type: 'retry', retryReason: 'bounded retry evidence' };
  const output = await goalsEvents(instance({ events: [event], appliedSequence: 1 }), { limit: 1 });
  assert.deepEqual(Object.keys(output[0]).sort(), ['actorRole', 'evidenceCount', 'nodeId', 'sequence', 'timestamp', 'type']);
  assert.equal(JSON.stringify(output).includes('manager-owner'), false);
  assert.equal(JSON.stringify(output).includes('bounded retry evidence'), false);
});

test('read commands support the schema-valid 1000-event boundary without a generic clone cap', async () => {
  const events = Array.from({ length: 1000 }, (_, index) => ({ schemaVersion: 1, eventId: `runtime-${index + 1}`, graphId: 'demo-graph', nodeId: 'worker-one', sequence: index + 1, timestamp: new Date(index).toISOString(), actor: { role: 'worker', id: 'worker-one-owner' }, type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'worker-lease', heartbeatSequence: index + 1, heartbeatIntervalMs: 100 }));
  const output = await goalsEvents(instance({ events, appliedSequence: 1000 }), { limit: 1000 });
  assert.equal(output.length, 1000);
});

test('goal mutation command wrappers preserve explicit version and authority inputs', async () => {
  const value = instance();
  let aborts = 0;
  const runtime = { retryNode: (target, input) => retryNode(target, input), cancelGoal: async (target, input) => { aborts += 1; return cancelGoal(target, input); } };
  const retried = await goalsRetryNode(runtime, value, { expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.retry']), reason: 'transient provider failure' });
  const cancelled = await goalsCancelGoal(runtime, value, { expectedVersion: retried.version, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
  assert.equal(cancelled.terminal, 'cancelled');
  assert.equal(aborts, 1);
});

test('cancel-node command delegates through the runtime cancellation surface', async () => {
  const value = instance(); let calls = 0;
  const runtime = { cancelNode: async (target, input) => { calls += 1; return cancelNode(target, input); } };
  const cancelled = await goalsCancelNode(runtime, value, { expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.cancel']) });
  assert.equal(cancelled.graph.nodes.find(node => node.id === 'worker-one').status, 'cancelled');
  assert.equal(calls, 1);
});

test('retry and cancellation mutations require exact version and structural authority', async () => {
  const value = instance();
  const manager = authority('manager-owner', ['orchestration.retry', 'orchestration.cancel']);
  await assert.rejects(() => retryNode(value, { expectedVersion: 3, nodeId: 'worker-one', authority: manager, reason: 'verified transient failure' }), error => error.code === 'ERR_RUNTIME_VERSION_CONFLICT');
  const retried = await retryNode(value, { expectedVersion: 4, nodeId: 'worker-one', authority: manager, reason: 'verified transient failure' });
  assert.equal(retried.graph.nodes.find(node => node.id === 'worker-one').status, 'ready'); assert.equal(retried.attempts['worker-one'], 2);
  const cancelled = await cancelNode(value, { expectedVersion: retried.version, nodeId: 'worker-one', authority: manager });
  assert.equal(cancelled.graph.nodes.find(node => node.id === 'worker-one').status, 'cancelled');
  const goal = await cancelGoal(value, { expectedVersion: cancelled.version, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
  assert.equal(goal.terminal, 'cancelled');
  assert.ok(goal.events.every(event => validateEvent(event) === true));
});

test('manual retry retires the prior heartbeat lease inside the durable retry transaction', async t => {
  for (const [label, runtimeOptions] of [
    ['fallback retry bound', null],
    ['runtime retry policy', { retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [0], retryable: ['provider-transient'] }) }],
  ]) await t.test(label, async () => {
    const value = instance({
      launchIntents: { 'worker-one': durableWorkerIntent({ status: 'complete' }) },
      heartbeats: { 'worker-one': { version: 1, instanceId: 'demo-instance', nodeId: 'worker-one', actorId: 'worker-one-owner', leaseId: 'worker-lease', sequence: 4, timestampMs: 1, intervalMs: 100 } },
      lastHeartbeatAt: { 'worker-one': 1 },
    });
    const retried = await retryNode(value, {
      expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.retry']), reason: 'verified transient failure',
    }, runtimeOptions);
    assert.equal(Object.hasOwn(retried.heartbeats, 'worker-one'), false);
    assert.equal(Object.hasOwn(retried.lastHeartbeatAt, 'worker-one'), false);
  });
});

test('authorized manual recovery reopens a blocked terminal graph canonically', async () => {
  const value = instance({ terminal: 'blocked', graph: { ...recoveryGraph(), status: 'blocked' } });
  const retried = await retryNode(value, { expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.retry']), reason: 'verified recovery' });
  assert.equal(retried.terminal, null);
  assert.equal(retried.graph.status, 'running');
});

test('pending ledger facts replay into runtime state before appliedSequence advances', async () => {
  const events = [
    { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1, timestamp: '1970-01-01T00:00:00.000Z', actor: { role: 'manager', id: 'manager-owner' }, type: 'retry', retryReason: 'replay retry' },
    { schemaVersion: 1, eventId: 'runtime-2', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 2, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'worker', id: 'worker-one-owner' }, type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'worker-lease', heartbeatSequence: 1, heartbeatIntervalMs: 100 },
    { schemaVersion: 1, eventId: 'runtime-3', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 3, timestamp: '1970-01-01T00:00:00.002Z', actor: { role: 'worker', id: 'worker-one-owner' }, type: 'evidence-recorded', evidenceRefs: ['worker-commit', 'worker-test'] },
    { schemaVersion: 1, eventId: 'runtime-4', graphId: 'demo-graph', sequence: 4, timestamp: '1970-01-01T00:00:00.003Z', actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded', evidenceRefs: ['activation-approval'], approvalReceiptId: 'activation-approval' },
  ];
  const value = instance({ activated: false, events, appliedSequence: 0, graph: recoveryGraph({ status: 'corrective' }),
    launchIntents: { 'worker-one': durableWorkerIntent({ status: 'complete' }) },
    heartbeats: { 'worker-one': { version: 1, instanceId: 'demo-instance', nodeId: 'worker-one', actorId: 'worker-one-owner', leaseId: 'worker-lease', sequence: 1, timestampMs: 1, intervalMs: 100 } },
  });
  const state = await cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
  assert.equal(state.attempts['worker-one'], 2);
  assert.equal(state.usage.retries, 1);
  assert.equal(state.lastHeartbeatAt['worker-one'], 1);
  assert.deepEqual(state.evidence.filter(item => item.nodeId === 'worker-one').map(item => item.id).sort(), ['worker-commit', 'worker-test']);
  assert.equal(state.activated, true);
});

test('durable retry usage exactly matches applied retry facts before another retry', async t => {
  const retryEvent = (sequence, retryReason) => ({
    schemaVersion: 1, eventId: `runtime-${sequence}`, graphId: 'demo-graph', nodeId: 'worker-one', sequence,
    timestamp: new Date(sequence - 1).toISOString(), actor: { role: sequence % 2 ? 'worker' : 'manager', id: sequence % 2 ? 'worker-one-owner' : 'manager-owner' },
    type: 'retry', retryReason,
  });

  await t.test('an omitted applied retry is rejected before retry budget can be reused', async () => {
    const value = instance({ events: [retryEvent(1, 'provider-transient')], appliedSequence: 1, limits: { tokens: 10000, costUsd: '10', retries: 1 } });
    await assert.rejects(() => retryNode(value, {
      expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.retry']), reason: 'must not reuse retry budget',
    }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
    assert.equal(value.inspect().events.length, 1);
  });

  await t.test('an invented retry counter is rejected', async () => {
    const value = instance({ events: [retryEvent(1, 'provider-transient')], appliedSequence: 1, usage: { tokens: 0, costUsd: '0', retries: 2, timeMinutes: 0, taskLimit: 0 } });
    await assert.rejects(() => cancelGoal(value, {
      expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human'),
    }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  });

  await t.test('multiple applied retry reasons are counted as exact durable retry facts', async () => {
    const events = ['provider-transient', 'manual recovery', 'stalled lease', 'corrective retry'].map((reason, index) => retryEvent(index + 1, reason));
    const value = instance({
      events, appliedSequence: events.length, attempts: { 'worker-one': 5 },
      usage: { tokens: 0, costUsd: '0', retries: events.length, timeMinutes: 0, taskLimit: 0 },
      limits: { tokens: 10000, costUsd: '10', retries: events.length },
    });
    const state = await cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
    assert.equal(state.usage.retries, events.length);
  });

  await t.test('pending retry replay reaches the exact durable count', async () => {
    const events = [retryEvent(1, 'provider-transient'), retryEvent(2, 'manual recovery')];
    const value = instance({ events, appliedSequence: 1, attempts: { 'worker-one': 2 }, usage: { tokens: 0, costUsd: '0', retries: 1, timeMinutes: 0, taskLimit: 0 } });
    const state = await cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
    assert.equal(state.appliedSequence, state.events.length);
    assert.deepEqual(state.events.slice(0, events.length), events);
    assert.equal(state.usage.retries, events.length);
  });
});

test('pending approval replay binds the explicit receipt identity to human approval evidence', async () => {
  const approvalEvent = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'human-final', sequence: 1, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded', evidenceRefs: ['final-test', 'final-review', 'final-approval', 'final-commit'], approvalReceiptId: 'final-approval' };
  const value = instance({ events: [approvalEvent], appliedSequence: 0 });
  const state = await cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
  assert.ok(state.evidence.some(item => item.id === 'final-approval' && item.type === 'human-approval'));
});

test('pending approval replay rejects partial and non-gate node facts', async () => {
  const base = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', sequence: 1, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded' };
  for (const event of [
    { ...base, nodeId: 'human-final', evidenceRefs: ['final-approval'], approvalReceiptId: 'final-approval' },
    { ...base, nodeId: 'boss-one', evidenceRefs: ['boss-commit', 'boss-test'], approvalReceiptId: 'boss-commit' },
  ]) {
    const value = instance({ events: [event], appliedSequence: 0 });
    await assert.rejects(() => cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  }
});

test('pending heartbeat independently reconstructs canonical lease-bound liveness state', async () => {
  const heartbeatEvent = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'worker', id: 'worker-one-owner' }, type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'worker-lease', heartbeatSequence: 1, heartbeatIntervalMs: 100 };
  const value = instance({ events: [heartbeatEvent], appliedSequence: 0, graph: recoveryGraph({ status: 'running' }), launchIntents: { 'worker-one': durableWorkerIntent() } });
  const state = await cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') });
  assert.equal(state.appliedSequence, state.events.length);
  assert.deepEqual(state.heartbeats['worker-one'], { version: 1, instanceId: 'demo-instance', nodeId: 'worker-one', actorId: 'worker-one-owner', leaseId: 'worker-lease', sequence: 1, timestampMs: 1, intervalMs: 100 });
});

test('pending heartbeat replay rejects a lease fact bound to another runtime instance', async () => {
  const heartbeatEvent = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'worker', id: 'worker-one-owner' }, type: 'heartbeat', instanceId: 'another-instance', leaseId: 'worker-lease', heartbeatSequence: 1, heartbeatIntervalMs: 100 };
  const value = instance({ events: [heartbeatEvent], appliedSequence: 0, graph: recoveryGraph({ status: 'running' }), launchIntents: { 'worker-one': durableWorkerIntent() } });
  await assert.rejects(() => cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  assert.equal(value.inspect().appliedSequence, 0);
  assert.deepEqual(value.inspect().heartbeats, {});
});

test('pending heartbeat replay rejects an actor role that does not own the node', async () => {
  const heartbeatEvent = { schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1, timestamp: '1970-01-01T00:00:00.001Z', actor: { role: 'manager', id: 'worker-one-owner' }, type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'worker-lease', heartbeatSequence: 1, heartbeatIntervalMs: 100 };
  const value = instance({ events: [heartbeatEvent], appliedSequence: 0, graph: recoveryGraph({ status: 'running' }), launchIntents: { 'worker-one': durableWorkerIntent() } });
  await assert.rejects(() => cancelGoal(value, { expectedVersion: 4, authority: authority('human-owner', ['orchestration.cancel'], 'human') }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  assert.equal(value.inspect().appliedSequence, 0);
  assert.deepEqual(value.inspect().heartbeats, {});
});

test('lock recovery requires stale proof, structural authority, and bound human approval', async () => {
  let recovered = 0;
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const receipt = createApprovalReceipt({ id: 'recover-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'recovery-admin', action: 'orchestration.recover', resource: 'demo-instance', policyId: 'runtime.stale-lock-recovery', decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true });
  const target = { id: 'demo-instance', version: async () => 1, inspectLock: async () => ({ ownerId: 'owner-one', acquiredAtMs: 0, expiresAtMs: 1, ownerAlive: false }), recoverLock: async proof => { assert.equal(proof.expectedOwnerId, 'owner-one'); recovered += 1; } };
  await assert.rejects(() => recoverRuntimeLock(target, { expectedVersion: 1, nowMs: 1, authority: recoveryAuthority(), approval: {}, approvalRegistry: registry, expectedApproverId: 'human-owner' }));
  assert.equal(recovered, 0);
  const result = await recoverRuntimeLock(target, { expectedVersion: 1, nowMs: 1, authority: recoveryAuthority(), approval: receipt, approvalRegistry: registry, expectedApproverId: 'human-owner' });
  assert.equal(result.recovered, true); assert.equal(recovered, 1);
});

test('ambiguous durable lock recovery cannot roll back and reuse its finalized receipt', async () => {
  let recovered = 0; let stale = true;
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const receipt = createApprovalReceipt({ id: 'recover-ambiguous', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'recovery-admin', action: 'orchestration.recover', resource: 'demo-instance', policyId: 'runtime.stale-lock-recovery', decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true });
  const target = { id: 'demo-instance', version: async () => 1, inspectLock: async () => stale ? ({ ownerId: 'owner-one', acquiredAtMs: 0, expiresAtMs: 1, ownerAlive: false }) : ({ ownerId: 'owner-two', acquiredAtMs: 2, expiresAtMs: 10, ownerAlive: true }), recoverLock: async () => { recovered += 1; stale = false; throw new Error('ambiguous recovery publication'); } };
  const input = { expectedVersion: 1, nowMs: 1, authority: recoveryAuthority(), approval: receipt, approvalRegistry: registry, expectedApproverId: 'human-owner' };
  await assert.rejects(() => recoverRuntimeLock(target, input));
  stale = true;
  await assert.rejects(() => recoverRuntimeLock(target, input), error => error instanceof RuntimeError && error.details.reason === 'approval-required');
  assert.equal(recovered, 1);
});

test('unchanged stale lock metadata rolls back approval despite an unrelated version advance', async () => {
  let recovered = 0; let currentVersion = 1;
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const receipt = createApprovalReceipt({ id: 'recover-version-race', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'recovery-admin', action: 'orchestration.recover', resource: 'demo-instance', policyId: 'runtime.stale-lock-recovery', decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true });
  const target = { id: 'demo-instance', version: async () => currentVersion, inspectLock: async () => ({ ownerId: 'owner-one', acquiredAtMs: 0, expiresAtMs: 1, ownerAlive: false }), recoverLock: async () => { recovered += 1; currentVersion += 1; throw new Error('unrelated state version changed'); } };
  const base = { nowMs: 1, authority: recoveryAuthority(), approval: receipt, approvalRegistry: registry, expectedApproverId: 'human-owner' };
  await assert.rejects(() => recoverRuntimeLock(target, { ...base, expectedVersion: 1 }));
  await assert.rejects(() => recoverRuntimeLock(target, { ...base, expectedVersion: 2 }), error => !(error instanceof RuntimeError && error.details.reason === 'approval-required'));
  assert.equal(recovered, 2);
});

test('corrective and stale recovery nodes stay bounded, parented, and evidence-reasoned', async () => {
  const used = { tokens: 900, costUsd: '0.75', timeMinutes: 18, tasks: 1 };
  const value = instance({
    terminal: 'failed', graph: { ...recoveryGraph({ owner: { role: 'worker', id: 'worker-owner' }, objective: 'Implement journey', status: 'failed' }), status: 'failed' },
    nodeUsage: { 'worker-one': used }, delegatedUsage: { 'manager-one': used, 'boss-one': used },
    usage: { tokens: 900, costUsd: '0.75', retries: 0, timeMinutes: 18, taskLimit: 1 },
  });
  const corrected = await createCorrectiveNode(value, { expectedVersion: 4, sourceNodeId: 'worker-one', nodeId: 'worker-correction', ownerId: 'correction-worker', authority: authority('manager-owner', ['orchestration.correct']), reason: 'journey evidence failed', evidenceRefs: ['correction-commit', 'correction-test'] });
  const correction = corrected.graph.nodes.find(node => node.id === 'worker-correction');
  assert.equal(correction.parentId, 'manager-one'); assert.deepEqual(correction.dependencies, ['manager-one']); assert.equal(correction.status, 'corrective');
  correction.evidenceRefs.push('caller-alias');
  assert.equal(value.inspect().graph.nodes.find(node => node.id === 'worker-correction').evidenceRefs.includes('caller-alias'), false);
  assert.equal(corrected.attempts['worker-one'], 2);
  assert.equal(corrected.usage.retries, 1);
  assert.equal(corrected.terminal, null);
  assert.equal(corrected.graph.status, 'running');
  assert.equal(corrected.graph.nodes.find(node => node.id === 'worker-one').status, 'archived');
  assert.deepEqual(corrected.graph.nodes.find(node => node.id === 'human-final').dependencies, ['worker-correction']);
  assert.deepEqual(correction.budget, { timeMinutes: 2, tokenLimit: 100, costUsd: 0.25, taskLimit: 1 });

  await assert.rejects(() => createCorrectiveNode(value, { expectedVersion: corrected.version, sourceNodeId: 'worker-one', nodeId: 'worker-correction-two', ownerId: 'correction-worker-two', authority: authority('manager-owner', ['orchestration.correct']), reason: 'duplicate correction', evidenceRefs: ['second-commit', 'second-test'] }));

  const stalled = instance({ graph: recoveryGraph({ owner: { role: 'worker', id: 'worker-owner' }, status: 'running' }), launchIntents: { 'worker-one': durableWorkerIntent({ startedAtMs: 100 }) }, heartbeats: { 'worker-one': { version: 1, instanceId: 'demo-instance', nodeId: 'worker-one', actorId: 'worker-owner', leaseId: 'worker-lease', sequence: 1, timestampMs: 100, intervalMs: 100 } }, lastHeartbeatAt: { 'worker-one': 100 } });
  const recovered = await recoverStalledNode(stalled, { expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.recover']), nowMs: 301, reason: 'heartbeat stalled' });
  assert.equal(recovered.graph.nodes.find(node => node.id === 'worker-one').status, 'ready');
  assert.equal(recovered.launchIntents['worker-one'].status, 'recovered');
  assert.equal(Object.hasOwn(recovered.heartbeats, 'worker-one'), false);
  assert.equal(Object.hasOwn(recovered.lastHeartbeatAt, 'worker-one'), false);
});

test('corrective evidence types cannot depart from the inherited source completion contract', async () => {
  const value = instance({ terminal: 'failed', graph: { ...recoveryGraph({ status: 'failed' }), status: 'failed' } });
  await assert.rejects(() => createCorrectiveNode(value, { expectedVersion: 4, sourceNodeId: 'worker-one', nodeId: 'review-correction', ownerId: 'review-worker', authority: authority('manager-owner', ['orchestration.correct']), reason: 'human review correction', evidenceRefs: ['opaque-a', 'opaque-b'], evidenceTypes: ['human-approval', 'review'] }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');
  assert.equal(value.inspect().graph.nodes.some(node => node.id === 'review-correction'), false);
});

test('corrective evidence types accept the inherited source multiset independent of order', async () => {
  const value = instance({ terminal: 'failed', graph: { ...recoveryGraph({ status: 'failed' }), status: 'failed' } });
  const corrected = await createCorrectiveNode(value, { expectedVersion: 4, sourceNodeId: 'worker-one', nodeId: 'worker-correction-explicit', ownerId: 'review-worker', authority: authority('manager-owner', ['orchestration.correct']), reason: 'explicit inherited contract', evidenceRefs: ['opaque-a', 'opaque-b'], evidenceTypes: ['test', 'commit'] });
  assert.deepEqual(corrected.graph.nodes.find(node => node.id === 'worker-correction-explicit').requiredEvidenceTypes, ['commit', 'test']);
});

test('corrective creation rejects a Boss human gate before any invalid state is committed', async () => {
  const graph = recoveryGraph();
  graph.status = 'failed';
  graph.nodes.find(node => node.id === 'human-final').status = 'failed';
  const value = instance({ terminal: 'failed', graph });
  const before = value.inspect();

  await assert.rejects(() => createCorrectiveNode(value, {
    expectedVersion: 4,
    sourceNodeId: 'human-final',
    nodeId: 'human-final-correction',
    ownerId: 'correction-worker',
    authority: authority('boss-owner', ['orchestration.correct']),
    reason: 'human approval cannot be synthesized by a Worker',
    evidenceRefs: ['correction-commit', 'correction-test', 'correction-review', 'correction-approval'],
  }), error => error instanceof RuntimeError && error.details.reason === 'invalid-runtime-input');

  assert.deepEqual(value.inspect(), before);
});

test('node cancellation cascades to dependents, derives terminal state, and preserves completed evidence', async () => {
  const graph = recoveryGraph({ status: 'running' }); graph.nodes.find(node => node.id === 'human-final').status = 'ready';
  const evidence = [{ id: 'manager-commit', nodeId: 'manager-one', type: 'commit', approvalState: 'approved' }];
  const value = instance({ graph, evidence, launchIntents: { 'worker-one': durableWorkerIntent() } });
  const state = await cancelNode(value, { expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.cancel']) });
  assert.equal(state.graph.nodes.find(node => node.id === 'human-final').status, 'cancelled');
  assert.equal(state.terminal, 'cancelled');
  assert.deepEqual(state.evidence, evidence);
});

test('node cancellation clears both automatic and manual retry deadlines canonically', async () => {
  const retryEvent = {
    schemaVersion: 1, eventId: 'runtime-1', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1,
    timestamp: '1970-01-01T00:00:00.000Z', actor: { role: 'worker', id: 'worker-one-owner' },
    type: 'retry', retryReason: 'provider-transient',
  };
  const manager = authority('manager-owner', ['orchestration.cancel']);
  const automatic = instance({
    graph: recoveryGraph({ status: 'corrective' }), events: [retryEvent], appliedSequence: 1,
    attempts: { 'worker-one': 2 },
    usage: { tokens: 0, costUsd: '0', retries: 1, timeMinutes: 0, taskLimit: 0 },
    launchIntents: { 'worker-one': durableWorkerIntent({ status: 'complete', retryAtMs: 100 }) },
  });
  const automaticState = await cancelNode(automatic, { expectedVersion: 4, nodeId: 'worker-one', authority: manager });
  assert.equal(Object.hasOwn(automaticState.launchIntents['worker-one'], 'retryAtMs'), false);

  const manual = instance({
    graph: recoveryGraph({ status: 'corrective' }), events: [retryEvent], appliedSequence: 1,
    attempts: { 'worker-one': 2 }, retryAtMs: { 'worker-one': 100 },
    usage: { tokens: 0, costUsd: '0', retries: 1, timeMinutes: 0, taskLimit: 0 },
  });
  const manualState = await cancelNode(manual, { expectedVersion: 4, nodeId: 'worker-one', authority: manager });
  assert.equal(Object.hasOwn(manualState.retryAtMs, 'worker-one'), false);
});

test('recovery command inputs are captured once and sanitize hostile failures', async () => {
  let accesses = 0;
  await assert.rejects(() => retryNode(instance(), {
    expectedVersion: 4, nodeId: 'worker-one', authority: authority('manager-owner', ['orchestration.retry']),
    get reason() { accesses += 1; throw new Error('recovery-private-canary'); },
  }), error => error.code === 'ERR_RUNTIME_INVALID_RUNTIME_INPUT' && !JSON.stringify(error).includes('recovery-private-canary'));
  assert.equal(accesses, 1);
});
