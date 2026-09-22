import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { completionStatus, graphCompletionStatus } from '../../src/graph/completion.js';
import { graphFixture } from '../../src/graph/fixtures.js';
import { reduceGraph, transitionAllowed } from '../../src/graph/reducer.js';
import { GraphValidationError, validateExecutionGraph } from '../../src/graph/validate.js';

function assertSanitizedGraphError(operation, reason, canary) {
  assert.throws(operation, error => {
    assert.ok(error instanceof GraphValidationError);
    assert.equal(error.details.reason, reason);
    const exposed = JSON.stringify({
      message: error.message,
      safeMessage: error.safeMessage,
      details: error.details,
      cause: error.cause,
      serialized: JSON.stringify(error),
    });
    assert.equal(exposed.includes(canary), false);
    return true;
  });
}

function transition(graph, nodeId, priorState, newState, sequence = 1) {
  return {
    schemaVersion: 1,
    eventId: `event-${String(sequence).padStart(3, '0')}`,
    graphId: graph.id,
    nodeId,
    sequence,
    timestamp: '2026-08-20T12:00:00.000Z',
    actor: { role: 'system', id: 'scheduler' },
    type: 'state-transition',
    priorState,
    newState,
  };
}

function evidenceFor(node, types = node.requiredEvidenceTypes) {
  return types.map((type, index) => ({
    id: node.evidenceRefs[index] ?? `extra-${index}`,
    type,
    approvalState: 'approved',
  }));
}

test('validates canonical DAG fixtures without mutating them', () => {
  const graph = graphFixture('parallel-fan-in');
  const before = structuredClone(graph);
  assert.equal(validateExecutionGraph(graph), true);
  assert.deepEqual(graph, before);
  assert.notStrictEqual(graphFixture('parallel-fan-in'), graph);
});

test('keeps every checked-in JSON graph fixture canonical and bounded', () => {
  const fixtureDirectory = new URL('../fixtures/graphs/', import.meta.url);
  const filenames = readdirSync(fixtureDirectory).filter(name => name.endsWith('.json')).sort();
  assert.deepEqual(filenames, ['corrective.json', 'parallel-fan-in.json']);
  for (const filename of filenames) {
    const graph = JSON.parse(readFileSync(new URL(filename, fixtureDirectory), 'utf8'));
    assert.equal(validateExecutionGraph(graph), true);
    assert.ok(graph.nodes.length <= 16);
    assert.deepEqual(graphFixture(filename.replace('.json', '')), graph);
  }
});

test('rejects cycles, dangling dependencies, and missing parents with sanitized errors', async t => {
  await t.test('dependency cycle', () => {
    const graph = graphFixture('parallel-fan-in');
    graph.nodes.find(node => node.id === 'design').dependencies = ['integration'];
    assert.throws(() => validateExecutionGraph(graph), GraphValidationError);
  });
  await t.test('dangling dependency', () => {
    const graph = graphFixture('parallel-fan-in');
    graph.nodes.find(node => node.id === 'api').dependencies = ['missing-node'];
    assert.throws(() => validateExecutionGraph(graph), error => (
      error instanceof GraphValidationError
      && error.code === 'ERR_INVALID_GOAL_GRAPH'
      && !error.message.includes('missing-node')
    ));
  });
  await t.test('missing parent', () => {
    const graph = graphFixture('parallel-fan-in');
    graph.nodes.find(node => node.id === 'api').parentId = 'missing-parent';
    assert.throws(() => validateExecutionGraph(graph), GraphValidationError);
  });
});

test('rejects duplicate node IDs and owner identities reused across roles', async t => {
  await t.test('node ID', () => {
    const graph = graphFixture('parallel-fan-in');
    graph.nodes[3].id = graph.nodes[2].id;
    assert.throws(() => validateExecutionGraph(graph), GraphValidationError);
  });
  await t.test('owner identity role conflict', () => {
    const graph = graphFixture('parallel-fan-in');
    graph.nodes.find(node => node.id === 'api').owner.id = 'engineering-manager';
    assert.throws(() => validateExecutionGraph(graph), GraphValidationError);
  });
});

test('applies only allowed validated transitions and keeps reducer inputs immutable', () => {
  const graph = graphFixture('parallel-fan-in');
  const before = structuredClone(graph);
  const event = transition(graph, 'design', 'ready', 'reserved');
  const next = reduceGraph(graph, event);
  assert.equal(next.nodes.find(node => node.id === 'design').status, 'reserved');
  assert.deepEqual(graph, before);
  assert.notStrictEqual(next, graph);
  assert.equal(transitionAllowed('ready', 'reserved'), true);
  assert.equal(transitionAllowed('ready', 'completed'), false);
  assert.throws(() => reduceGraph(graph, transition(graph, 'design', 'running', 'verifying')), GraphValidationError);
  assert.throws(() => reduceGraph(graph, transition(graph, 'design', 'ready', 'completed')), GraphValidationError);
});

test('accepts bounded heartbeat lease facts as a schema-valid graph no-op', () => {
  const graph = graphFixture('parallel-fan-in');
  const heartbeat = { schemaVersion: 1, eventId: 'event-heartbeat', graphId: graph.id, nodeId: 'design', sequence: 1, timestamp: '2026-08-20T12:00:00.000Z', actor: { role: 'worker', id: 'design-worker' }, type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'design-lease', heartbeatSequence: 1, heartbeatIntervalMs: 100 };
  assert.deepEqual(reduceGraph(graph, heartbeat), graph);
});

test('defines blocked, corrective, cancelled, and terminal transition semantics', () => {
  assert.equal(transitionAllowed('running', 'corrective'), true);
  assert.equal(transitionAllowed('corrective', 'ready'), true);
  assert.equal(transitionAllowed('blocked', 'corrective'), true);
  assert.equal(transitionAllowed('failed', 'corrective'), true);
  assert.equal(transitionAllowed('completed', 'archived'), true);
  assert.equal(transitionAllowed('cancelled', 'ready'), false);
  assert.equal(transitionAllowed('archived', 'ready'), false);

  const graph = graphFixture('parallel-fan-in');
  const cancelled = {
    schemaVersion: 1,
    eventId: 'event-cancelled',
    graphId: graph.id,
    nodeId: 'design',
    sequence: 1,
    timestamp: '2026-08-20T12:00:00.000Z',
    actor: { role: 'human', id: 'demo-owner' },
    type: 'cancelled',
  };
  assert.equal(reduceGraph(graph, cancelled).nodes.find(node => node.id === 'design').status, 'cancelled');
});

test('records evidence references only through validated events without duplicates', () => {
  const graph = graphFixture('parallel-fan-in');
  const event = {
    schemaVersion: 1,
    eventId: 'event-evidence',
    graphId: graph.id,
    nodeId: 'design',
    sequence: 1,
    timestamp: '2026-08-20T12:00:00.000Z',
    actor: { role: 'worker', id: 'design-worker' },
    type: 'evidence-recorded',
    evidenceRefs: ['new-evidence'],
  };
  const next = reduceGraph(graph, event);
  assert.deepEqual(next.nodes.find(node => node.id === 'design').evidenceRefs.at(-1), 'new-evidence');
  assert.throws(() => reduceGraph(next, event), GraphValidationError);
});

test('accepts an actual approval event as an idempotent graph fact', () => {
  const graph = graphFixture('parallel-fan-in');
  const approval = { schemaVersion: 1, eventId: 'event-approval', graphId: graph.id, nodeId: 'human-final', sequence: 1, timestamp: '2026-08-20T12:00:00.000Z', actor: { role: 'human', id: 'demo-owner' }, type: 'approval-recorded', evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], approvalReceiptId: 'final-approval' };
  const next = reduceGraph(graph, approval);
  assert.deepEqual(next, graph);
  assert.deepEqual(reduceGraph(next, approval), graph);
});

test('rejects partial and non-gate node approval facts', () => {
  const graph = graphFixture('parallel-fan-in');
  const base = { schemaVersion: 1, eventId: 'event-approval-invalid', graphId: graph.id, sequence: 1, timestamp: '2026-08-20T12:00:00.000Z', actor: { role: 'human', id: 'demo-owner' }, type: 'approval-recorded' };
  assert.throws(() => reduceGraph(graph, { ...base, nodeId: 'human-final', evidenceRefs: ['final-approval'], approvalReceiptId: 'final-approval' }), GraphValidationError);
  assert.throws(() => reduceGraph(graph, { ...base, nodeId: 'design', evidenceRefs: ['design-commit', 'design-test'], approvalReceiptId: 'design-commit' }), GraphValidationError);
});

test('accepts a node-less activation approval fact without mutating the graph', () => {
  const graph = graphFixture('parallel-fan-in');
  const activation = { schemaVersion: 1, eventId: 'event-activation', graphId: graph.id, sequence: 1, timestamp: '2026-08-20T12:00:00.000Z', actor: { role: 'human', id: 'demo-owner' }, type: 'approval-recorded', evidenceRefs: ['activation-approval'], approvalReceiptId: 'activation-approval' };
  assert.deepEqual(reduceGraph(graph, activation), graph);
});

test('snapshots stateful transition event fields once before validation and lookup', () => {
  const graph = graphFixture('parallel-fan-in');
  const values = {
    schemaVersion: [1, 2], eventId: ['event-snapshot', 'INVALID'], graphId: [graph.id, 'other-graph'],
    nodeId: ['design', 'api'], sequence: [1, 0], timestamp: ['2026-08-20T12:00:00.000Z', 'invalid'],
    type: ['state-transition', 'cancelled'], priorState: ['ready', 'failed'], newState: ['reserved', 'failed'],
  };
  const accesses = {};
  const event = {};
  for (const [field, [first, second]] of Object.entries(values)) {
    accesses[field] = 0;
    Object.defineProperty(event, field, {
      enumerable: true,
      get() {
        accesses[field] += 1;
        return accesses[field] === 1 ? first : second;
      },
    });
  }
  const actorAccesses = { role: 0, id: 0 };
  let actorFieldAccesses = 0;
  Object.defineProperty(event, 'actor', {
    enumerable: true,
    get() {
      actorFieldAccesses += 1;
      return {
        get role() {
          actorAccesses.role += 1;
          return actorAccesses.role === 1 ? 'system' : 'invalid';
        },
        get id() {
          actorAccesses.id += 1;
          return actorAccesses.id === 1 ? 'scheduler' : 'INVALID';
        },
      };
    },
  });

  const next = reduceGraph(graph, event);
  assert.equal(next.nodes.find(node => node.id === 'design').status, 'reserved');
  assert.equal(next.nodes.find(node => node.id === 'api').status, 'ready');
  assert.deepEqual(accesses, Object.fromEntries(Object.keys(values).map(field => [field, 1])));
  assert.equal(actorFieldAccesses, 1);
  assert.deepEqual(actorAccesses, { role: 1, id: 1 });
});

test('snapshots evidence event arrays and nested indices once', () => {
  const graph = graphFixture('parallel-fan-in');
  let evidenceFieldAccesses = 0;
  let evidenceIndexAccesses = 0;
  const references = ['design-extra'];
  Object.defineProperty(references, 0, {
    enumerable: true,
    configurable: true,
    get() {
      evidenceIndexAccesses += 1;
      return evidenceIndexAccesses === 1 ? 'design-extra' : 'api-extra';
    },
  });
  const event = {
    schemaVersion: 1,
    eventId: 'event-evidence-snapshot',
    graphId: graph.id,
    nodeId: 'design',
    sequence: 1,
    timestamp: '2026-08-20T12:00:00.000Z',
    actor: { role: 'worker', id: 'design-worker' },
    type: 'evidence-recorded',
    get evidenceRefs() {
      evidenceFieldAccesses += 1;
      return evidenceFieldAccesses === 1 ? references : ['api-extra'];
    },
  };

  const next = reduceGraph(graph, event);
  assert.equal(next.nodes.find(node => node.id === 'design').evidenceRefs.at(-1), 'design-extra');
  assert.equal(next.nodes.find(node => node.id === 'api').evidenceRefs.includes('api-extra'), false);
  assert.equal(evidenceFieldAccesses, 1);
  assert.equal(evidenceIndexAccesses, 1);
});

test('breaks cross-node graph aliases before reducer mutation', () => {
  const graph = graphFixture('parallel-fan-in');
  const design = graph.nodes.find(node => node.id === 'design');
  const api = graph.nodes.find(node => node.id === 'api');
  api.owner = design.owner;
  api.dependencies = design.dependencies;
  api.authorityScopes = design.authorityScopes;
  api.budget = design.budget;
  api.requiredEvidenceTypes = design.requiredEvidenceTypes;
  api.evidenceRefs = design.evidenceRefs;
  const before = structuredClone(graph);
  const event = {
    schemaVersion: 1, eventId: 'event-alias', graphId: graph.id, nodeId: 'design', sequence: 1,
    timestamp: '2026-08-20T12:00:00.000Z', actor: { role: 'worker', id: 'design-worker' },
    type: 'evidence-recorded', evidenceRefs: ['design-extra'],
  };

  const next = reduceGraph(graph, event);
  const nextDesign = next.nodes.find(node => node.id === 'design');
  const nextApi = next.nodes.find(node => node.id === 'api');
  assert.deepEqual(graph, before);
  assert.equal(nextDesign.evidenceRefs.at(-1), 'design-extra');
  assert.equal(nextApi.evidenceRefs.includes('design-extra'), false);
  for (const field of ['owner', 'dependencies', 'authorityScopes', 'budget', 'requiredEvidenceTypes', 'evidenceRefs']) {
    assert.notStrictEqual(nextDesign[field], nextApi[field]);
  }
});

test('snapshots stateful graph and node getters before reducer validation and use', () => {
  const graph = graphFixture('parallel-fan-in');
  const design = graph.nodes.find(node => node.id === 'design');
  let graphIdAccesses = 0;
  let statusAccesses = 0;
  Object.defineProperty(graph, 'id', {
    enumerable: true,
    get() {
      graphIdAccesses += 1;
      return graphIdAccesses === 1 ? 'parallel-fan-in' : 'redirected-graph';
    },
  });
  Object.defineProperty(design, 'status', {
    enumerable: true,
    get() {
      statusAccesses += 1;
      return statusAccesses === 1 ? 'ready' : 'failed';
    },
  });
  const next = reduceGraph(graph, transition({ id: 'parallel-fan-in' }, 'design', 'ready', 'reserved'));
  assert.equal(next.nodes.find(node => node.id === 'design').status, 'reserved');
  assert.equal(graphIdAccesses, 1);
  assert.equal(statusAccesses, 1);
});

test('requires exact approved evidence types for node completion profiles', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'integration');
  const profile = { id: 'engineering', requiredEvidence: ['commit', 'test', 'journey'] };
  const complete = completionStatus(node, evidenceFor(node), profile);
  assert.deepEqual(complete, {
    complete: true,
    missing: [],
    unexpected: [],
    unapproved: [],
    missingRefs: [],
    unboundRefs: [],
  });

  const missing = completionStatus(node, evidenceFor(node, ['commit', 'test']), profile);
  assert.deepEqual(missing.missing, ['journey']);
  assert.equal(missing.complete, false);

  const extra = evidenceFor(node);
  extra.push({ id: 'extra-report', type: 'report', approvalState: 'approved' });
  assert.deepEqual(completionStatus(node, extra, profile).unexpected, ['report']);

  const unapproved = evidenceFor(node);
  unapproved[1].approvalState = 'pending';
  assert.deepEqual(completionStatus(node, unapproved, profile).unapproved, ['test']);
});

test('binds direct completion evidence to the node reference set exactly', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  const profile = { id: 'engineering', requiredEvidence: ['commit', 'test'] };
  const mismatched = [
    { id: 'other-commit', type: 'commit', approvalState: 'approved' },
    { id: 'design-test', type: 'test', approvalState: 'approved' },
  ];
  const status = completionStatus(node, mismatched, profile);
  assert.equal(status.complete, false);
  assert.deepEqual(status.missingRefs, ['design-commit']);
  assert.deepEqual(status.unboundRefs, ['other-commit']);

  const duplicate = evidenceFor(node);
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => completionStatus(node, duplicate, profile), GraphValidationError);

  node.evidenceRefs.push(node.evidenceRefs[0]);
  assert.throws(() => completionStatus(node, evidenceFor(node), profile), GraphValidationError);
});

test('maps every planned semantic evidence category to the frozen canonical vocabulary', () => {
  const plannedSemanticToCanonical = {
    commit: 'commit',
    tests: 'test',
    'design reference': 'screenshot',
    'journey result': 'journey',
    review: 'review',
    preview: 'report',
    'human approval': 'human-approval',
    'external updates': 'external-update',
  };
  assert.deepEqual(plannedSemanticToCanonical, {
    commit: 'commit',
    tests: 'test',
    'design reference': 'screenshot',
    'journey result': 'journey',
    review: 'review',
    preview: 'report',
    'human approval': 'human-approval',
    'external updates': 'external-update',
  });
  const required = Object.values(plannedSemanticToCanonical);
  const node = {
    ...graphFixture('parallel-fan-in').nodes[2],
    completionProfile: 'conference-delivery',
    requiredEvidenceTypes: required,
    evidenceRefs: required.map((_, index) => `evidence-${index}`),
  };
  const profile = { id: 'conference-delivery', requiredEvidence: required };
  assert.equal(completionStatus(node, evidenceFor(node), profile).complete, true);
  const substituted = evidenceFor(node);
  substituted[2].type = 'report';
  const status = completionStatus(node, substituted, profile);
  assert.deepEqual(status.missing, ['screenshot']);
  assert.deepEqual(status.unexpected, ['report']);

  node.requiredEvidenceTypes = ['tests', 'design-reference', 'journey-result', 'preview'];
  node.evidenceRefs = ['alias-tests', 'alias-design', 'alias-journey', 'alias-preview'];
  assert.throws(() => completionStatus(node, [
    { id: 'alias-tests', type: 'test', approvalState: 'approved' },
    { id: 'alias-design', type: 'screenshot', approvalState: 'approved' },
    { id: 'alias-journey', type: 'journey', approvalState: 'approved' },
    { id: 'alias-preview', type: 'report', approvalState: 'approved' },
  ]), GraphValidationError);
});

test('marks a graph complete only when every node is completed with exact evidence', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.status = 'completed';
  for (const node of graph.nodes) node.status = 'completed';
  const profiles = [
    { id: 'engineering', requiredEvidence: ['commit', 'test'] },
    { id: 'delivery', requiredEvidence: ['commit', 'test', 'review', 'human-approval'] },
  ];
  const items = graph.nodes.flatMap(node => evidenceFor(node));
  assert.equal(graphCompletionStatus(graph, items, profiles).complete, false);
  const integration = graph.nodes.find(node => node.id === 'integration');
  integration.requiredEvidenceTypes = ['commit', 'test'];
  integration.evidenceRefs = integration.evidenceRefs.slice(0, 2);
  items.splice(items.findIndex(item => item.id === 'integration-journey'), 1);
  assert.equal(graphCompletionStatus(graph, items, profiles).complete, true);
  graph.nodes.find(node => node.id === 'api').evidenceRefs.push('unresolved-api-evidence');
  const unresolved = graphCompletionStatus(graph, items, profiles);
  assert.equal(unresolved.complete, false);
  assert.deepEqual(
    unresolved.nodes.find(node => node.id === 'api').evidence.missingRefs,
    ['unresolved-api-evidence'],
  );
  graph.nodes.find(node => node.id === 'api').evidenceRefs.pop();
  items.push({ id: 'unreferenced-report', type: 'report', approvalState: 'approved' });
  assert.equal(graphCompletionStatus(graph, items, profiles).complete, false);
  assert.deepEqual(graphCompletionStatus(graph, items, profiles).unreferenced, ['unreferenced-report']);
  items.pop();
  graph.nodes.find(node => node.id === 'api').status = 'verifying';
  assert.equal(graphCompletionStatus(graph, items, profiles).complete, false);
});

test('rejects malformed completion profiles instead of normalizing them', () => {
  const node = graphFixture('parallel-fan-in').nodes.find(candidate => candidate.id === 'design');
  const duplicate = { id: 'engineering', requiredEvidence: ['commit', 'commit'] };
  assert.throws(() => completionStatus(node, evidenceFor(node), duplicate), GraphValidationError);
});

test('cannot complete when node and profile evidence contracts differ', () => {
  const node = graphFixture('parallel-fan-in').nodes.find(candidate => candidate.id === 'design');
  node.requiredEvidenceTypes = ['commit'];
  node.evidenceRefs = ['design-commit'];
  const profile = { id: 'engineering', requiredEvidence: ['commit', 'test'] };
  assert.equal(completionStatus(node, [{ id: 'design-commit', type: 'commit', approvalState: 'approved' }], profile).complete, false);
  assert.equal(completionStatus(node, [
    { id: 'design-commit', type: 'commit', approvalState: 'approved' },
    { id: 'design-test', type: 'test', approvalState: 'approved' },
  ], profile).complete, false);
});

test('snapshots completion node, profile, and evidence fields once', () => {
  const counters = {};
  const once = (target, field, label, first, second) => {
    counters[label] = 0;
    Object.defineProperty(target, field, {
      enumerable: true,
      get() {
        counters[label] += 1;
        return counters[label] === 1 ? first : second;
      },
    });
  };
  const node = {};
  once(node, 'id', 'node.id', 'design', 'INVALID');
  once(node, 'requiredEvidenceTypes', 'node.requiredEvidenceTypes', ['commit'], ['report']);
  once(node, 'evidenceRefs', 'node.evidenceRefs', ['evidence-one'], ['redirected-evidence']);
  once(node, 'completionProfile', 'node.completionProfile', 'engineering', 'redirected-profile');
  const profile = {};
  once(profile, 'id', 'profile.id', 'engineering', 'redirected-profile');
  once(profile, 'requiredEvidence', 'profile.requiredEvidence', ['commit'], ['report']);
  const item = {};
  once(item, 'id', 'item.id', 'evidence-one', 'INVALID');
  once(item, 'type', 'item.type', 'commit', 'report');
  once(item, 'approvalState', 'item.approvalState', 'approved', 'rejected');

  assert.equal(completionStatus(node, [item], profile).complete, true);
  assert.deepEqual(Object.values(counters), Object.values(counters).map(() => 1));
});

test('snapshots graph completion evidence items once across every node', () => {
  const graph = graphFixture('parallel-fan-in');
  const accesses = { id: 0, type: 0, approvalState: 0 };
  const item = {
    get id() { accesses.id += 1; return 'design-commit'; },
    get type() { accesses.type += 1; return 'commit'; },
    get approvalState() { accesses.approvalState += 1; return 'approved'; },
  };
  assert.equal(graphCompletionStatus(graph, [item]).complete, false);
  assert.deepEqual(accesses, { id: 1, type: 1, approvalState: 1 });
});

test('rejects noncanonical and oversized completion evidence identifiers', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  for (const id of ['Uppercase', 'leading--gap', `a${'x'.repeat(64)}`, 'x'.repeat(100000)]) {
    assert.throws(
      () => completionStatus(node, [{ id, type: 'commit', approvalState: 'approved' }]),
      GraphValidationError,
    );
  }
  const invalidNode = { ...node, evidenceRefs: ['INVALID'] };
  assert.throws(() => completionStatus(invalidNode, evidenceFor(node)), GraphValidationError);
  assert.throws(
    () => completionStatus(node, Array.from({ length: 1001 }, (_, index) => ({
      id: `evidence-${index}`, type: 'commit', approvalState: 'approved',
    }))),
    GraphValidationError,
  );
});

test('rejects noncanonical completion profile and node identifiers with bounded errors', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  const hugeId = `a${'x'.repeat(999999)}`;
  for (const id of ['', 'Engineering', 'leading--gap', `a${'x'.repeat(64)}`, hugeId]) {
    assert.throws(() => completionStatus({ ...node, completionProfile: id }, evidenceFor(node)), error => {
      assert.ok(error instanceof GraphValidationError);
      assert.equal(error.details.reason, 'invalid-evidence-item');
      assert.ok(JSON.stringify(error).length < 500);
      if (id) assert.equal(JSON.stringify(error).includes(id.slice(0, 100)), false);
      return true;
    });
  }
  for (const id of ['Invalid', 'node--gap', `a${'x'.repeat(64)}`]) {
    assert.throws(
      () => completionStatus({ ...node, id }, evidenceFor(node)),
      GraphValidationError,
    );
  }
  assert.throws(
    () => completionStatus(node, evidenceFor(node), { id: 'Invalid', requiredEvidence: ['commit', 'test'] }),
    GraphValidationError,
  );
});

test('sanitizes hostile evidence getters at both completion entry points', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  const profile = { id: 'engineering', requiredEvidence: ['commit', 'test'] };
  for (const [name, operation] of [
    ['node', items => completionStatus(node, items, profile)],
    ['graph', items => graphCompletionStatus(graph, items, [profile, {
      id: 'delivery',
      requiredEvidence: ['commit', 'test', 'review', 'human-approval'],
    }])],
  ]) {
    const canary = `completion-${name}-private-canary`;
    let accesses = 0;
    const item = {
      get id() {
        accesses += 1;
        throw new Error(canary);
      },
      type: 'commit',
      approvalState: 'approved',
    };
    assertSanitizedGraphError(() => operation([item]), 'invalid-evidence-item', canary);
    assert.equal(accesses, 1);
  }
});

test('sanitizes hostile evidence array and nested item proxies', () => {
  const node = graphFixture('parallel-fan-in').nodes.find(candidate => candidate.id === 'design');
  const profile = { id: 'engineering', requiredEvidence: ['commit', 'test'] };
  const arrayCanary = 'completion-array-private-canary';
  const items = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') throw new Error(arrayCanary);
      return Reflect.get(target, property, receiver);
    },
  });
  assertSanitizedGraphError(
    () => completionStatus(node, items, profile),
    'invalid-evidence-item',
    arrayCanary,
  );

  const itemCanary = 'completion-item-proxy-private-canary';
  const item = new Proxy({ id: 'design-commit', approvalState: 'approved' }, {
    get(target, property, receiver) {
      if (property === 'type') throw new Error(itemCanary);
      return Reflect.get(target, property, receiver);
    },
  });
  assertSanitizedGraphError(
    () => completionStatus(node, [item], profile),
    'invalid-evidence-item',
    itemCanary,
  );
});

test('sanitizes hostile top-level and nested event getters without re-reading them', () => {
  const graph = graphFixture('parallel-fan-in');
  const eventAccesses = { 'top-level': 0, nested: 0 };
  for (const [name, event] of [
    ['top-level', Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get() {
        eventAccesses['top-level'] += 1;
        throw new Error('event-top-level-private-canary');
      },
    })],
    ['nested', {
      schemaVersion: 1,
      eventId: 'event-hostile',
      graphId: graph.id,
      nodeId: 'design',
      sequence: 1,
      timestamp: '2026-08-20T12:00:00.000Z',
      actor: Object.defineProperty({ role: 'system' }, 'id', {
        enumerable: true,
        get() {
          eventAccesses.nested += 1;
          throw new Error('event-nested-private-canary');
        },
      }),
      type: 'heartbeat',
    }],
  ]) {
    const canary = `event-${name}-private-canary`;
    assertSanitizedGraphError(() => reduceGraph(graph, event), 'invalid-event', canary);
    assert.equal(eventAccesses[name], 1);
  }
});

test('sanitizes transition argument coercion and nested primitive traps once', () => {
  for (const [name, priorState] of [
    ['access', new Proxy({}, {
      get(target, property, receiver) {
        if (property === Symbol.toPrimitive) throw new Error('transition-access-private-canary');
        return Reflect.get(target, property, receiver);
      },
    })],
    ['coercion', {
      [Symbol.toPrimitive]() {
        throw new Error('transition-coercion-private-canary');
      },
    }],
  ]) {
    const canary = `transition-${name}-private-canary`;
    let evaluations = 0;
    const wrapped = new Proxy(priorState, {
      get(target, property, receiver) {
        if (property === Symbol.toPrimitive) evaluations += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    assertSanitizedGraphError(
      () => transitionAllowed(wrapped, 'ready'),
      'invalid-transition-arguments',
      canary,
    );
    assert.equal(evaluations, 1);
  }
});

test('uses boundary-owned completion and reducer classifications', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  assert.throws(
    () => completionStatus(node, [
      { id: 'design-commit', type: 'commit', approvalState: 'approved' },
      { id: 'design-commit', type: 'test', approvalState: 'approved' },
    ]),
    error => error instanceof GraphValidationError && error.details.reason === 'invalid-evidence-item',
  );
  assert.throws(
    () => reduceGraph(graph, transition(graph, 'missing-node', 'ready', 'reserved')),
    error => error instanceof GraphValidationError && error.details.reason === 'invalid-event',
  );
});
