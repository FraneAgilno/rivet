import assert from 'node:assert/strict';
import test from 'node:test';

import { graphFixture } from '../../src/graph/fixtures.js';
import { completionStatus } from '../../src/graph/completion.js';
import { canStart, readyNodeIds, scheduleReadyNodes } from '../../src/graph/scheduler.js';
import { GraphValidationError, graphFailure } from '../../src/graph/validate.js';

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

test('schedules independent ready nodes and waits at fan-in', () => {
  const graph = graphFixture('parallel-fan-in');
  assert.deepEqual(readyNodeIds(graph), ['design', 'api']);
  assert.equal(canStart(graph, 'integration'), false);
});

test('opens fan-in only after every dependency completes and never schedules blocked descendants', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.nodes.find(node => node.id === 'design').status = 'completed';
  graph.nodes.find(node => node.id === 'api').status = 'completed';
  assert.equal(canStart(graph, 'integration'), true);
  graph.nodes.find(node => node.id === 'api').status = 'failed';
  assert.equal(canStart(graph, 'integration'), false);
});

test('does not schedule through a literally blocked dependency', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.nodes.find(node => node.id === 'design').status = 'completed';
  graph.nodes.find(node => node.id === 'api').status = 'blocked';
  assert.equal(canStart(graph, 'integration'), false);
  assert.equal(readyNodeIds(graph).includes('integration'), false);
});

test('schedules corrective work after its completed dependencies', () => {
  const graph = graphFixture('corrective');
  assert.deepEqual(readyNodeIds(graph), ['fix-journey']);
});

test('orders candidates by priority, dependency depth, then code-point node ID', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.nodes.find(node => node.id === 'integration').dependencies = ['manager-plan'];
  assert.deepEqual(readyNodeIds(graph, {
    priorities: { design: 2, api: 2, integration: 3 },
  }), ['integration', 'design', 'api']);
  assert.deepEqual(readyNodeIds(graph), ['design', 'integration', 'api']);
});

test('enforces active-node and per-owner capacity ceilings', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.nodes.find(node => node.id === 'integration').status = 'running';
  assert.deepEqual(scheduleReadyNodes(graph, { maxActiveNodes: 1 }), []);
  assert.deepEqual(scheduleReadyNodes(graph, { maxActiveNodes: 2 }), ['design']);

  graph.nodes.find(node => node.id === 'integration').status = 'ready';
  graph.nodes.find(node => node.id === 'api').owner.id = 'design-worker';
  assert.deepEqual(scheduleReadyNodes(graph, {
    capacityByOwner: { 'design-worker': 1 },
  }), ['design']);
});

test('enforces parent child-capacity and delegation-depth ceilings', () => {
  const graph = graphFixture('parallel-fan-in');
  assert.deepEqual(scheduleReadyNodes(graph, {
    childCapacityByParent: { 'manager-plan': 1 },
  }), ['design']);
  assert.deepEqual(scheduleReadyNodes(graph, { maxDelegationDepth: 1 }), []);
});

test('enforces cumulative integer-safe budget ceilings deterministically', () => {
  const graph = graphFixture('parallel-fan-in');
  assert.deepEqual(scheduleReadyNodes(graph, {
    priorities: { api: 1 },
    budget: { timeMinutes: 120, tokenLimit: 60000, costUsd: 12, taskLimit: 10 },
  }), ['api']);
  assert.deepEqual(scheduleReadyNodes(graph, {
    budget: { timeMinutes: 100, tokenLimit: 100000, costUsd: 100, taskLimit: 100 },
  }), ['design']);
  assert.throws(() => scheduleReadyNodes(graph, {
    budget: { timeMinutes: Number.MAX_SAFE_INTEGER + 1, tokenLimit: 1, costUsd: 1, taskLimit: 1 },
  }), GraphValidationError);
});

test('accounts for decimal cost budgets exactly in either candidate order', () => {
  const graph = graphFixture('parallel-fan-in');
  graph.nodes.find(node => node.id === 'design').budget.costUsd = 0.1;
  graph.nodes.find(node => node.id === 'api').budget.costUsd = 0.2;
  const budget = { timeMinutes: 210, tokenLimit: 110000, costUsd: 0.3, taskLimit: 18 };
  assert.deepEqual(scheduleReadyNodes(graph, { budget }), ['design', 'api']);
  assert.deepEqual(scheduleReadyNodes(graph, {
    priorities: { api: 2, design: 1 },
    budget,
  }), ['api', 'design']);
});

test('accounts exactly for exponent-form and schema-boundary decimal costs', () => {
  const graph = graphFixture('parallel-fan-in');
  const design = graph.nodes.find(node => node.id === 'design');
  const api = graph.nodes.find(node => node.id === 'api');
  design.budget.costUsd = 1e-7;
  api.budget.costUsd = 2e-7;
  assert.deepEqual(scheduleReadyNodes(graph, {
    budget: { timeMinutes: 210, tokenLimit: 110000, costUsd: 3e-7, taskLimit: 18 },
  }), ['design', 'api']);

  design.budget.costUsd = 9999.9;
  api.budget.costUsd = 0.1;
  assert.deepEqual(scheduleReadyNodes(graph, {
    budget: { timeMinutes: 210, tokenLimit: 110000, costUsd: 10000, taskLimit: 18 },
  }), ['design', 'api']);
});

test('fails closed on malformed options, unknown nodes, and invalid graphs', () => {
  const graph = graphFixture('parallel-fan-in');
  assert.throws(() => canStart(graph, 'missing-node'), GraphValidationError);
  assert.throws(() => scheduleReadyNodes(graph, { maxActiveNodes: -1 }), GraphValidationError);
  assert.throws(() => scheduleReadyNodes(graph, { unrecognized: true }), GraphValidationError);
  assert.throws(() => scheduleReadyNodes(graph, { priorities: { 'design-worker': 1 } }), GraphValidationError);
  assert.throws(() => scheduleReadyNodes(graph, { capacityByOwner: { design: 1 } }), GraphValidationError);
  assert.throws(() => scheduleReadyNodes(graph, { childCapacityByParent: { 'design-worker': 1 } }), GraphValidationError);
  graph.nodes.find(node => node.id === 'design').dependencies = ['integration'];
  assert.throws(() => readyNodeIds(graph), GraphValidationError);
});

test('does not mutate graph or scheduler options', () => {
  const graph = graphFixture('parallel-fan-in');
  const options = { priorities: { api: 5, design: 4 }, maxActiveNodes: 2 };
  const graphBefore = structuredClone(graph);
  const optionsBefore = structuredClone(options);
  assert.deepEqual(scheduleReadyNodes(graph, options), ['api', 'design']);
  assert.deepEqual(graph, graphBefore);
  assert.deepEqual(options, optionsBefore);
});

test('snapshots every top-level scheduler option exactly once', () => {
  const graph = graphFixture('parallel-fan-in');
  const accesses = {};
  const options = {};
  const fields = {
    maxActiveNodes: [2, Number.POSITIVE_INFINITY],
    maxDelegationDepth: [3, Number.POSITIVE_INFINITY],
    priorities: [{ design: 2, api: 1 }, { design: Number.POSITIVE_INFINITY }],
    capacityByOwner: [{ 'design-worker': 1, 'api-worker': 1 }, { 'design-worker': Number.POSITIVE_INFINITY }],
    childCapacityByParent: [{ 'manager-plan': 1 }, { 'manager-plan': Number.POSITIVE_INFINITY }],
    budget: [
      { timeMinutes: 300, tokenLimit: 200000, costUsd: 30, taskLimit: 30 },
      { timeMinutes: Number.POSITIVE_INFINITY },
    ],
  };
  for (const [field, [first, second]] of Object.entries(fields)) {
    accesses[field] = 0;
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        accesses[field] += 1;
        return accesses[field] === 1 ? first : second;
      },
    });
  }
  assert.deepEqual(scheduleReadyNodes(graph, options), ['design']);
  assert.deepEqual(accesses, Object.fromEntries(Object.keys(fields).map(field => [field, 1])));
});

test('snapshots nested scheduler maps and budget values exactly once', () => {
  const graph = graphFixture('parallel-fan-in');
  const accesses = {};
  const mapFrom = (name, values) => {
    const result = {};
    for (const [key, value] of Object.entries(values)) {
      accesses[`${name}:${key}`] = 0;
      Object.defineProperty(result, key, {
        enumerable: true,
        get() {
          accesses[`${name}:${key}`] += 1;
          return accesses[`${name}:${key}`] === 1 ? value : Number.POSITIVE_INFINITY;
        },
      });
    }
    return result;
  };
  const options = {
    priorities: mapFrom('priority', { design: 2, api: 1 }),
    capacityByOwner: mapFrom('owner', { 'design-worker': 1, 'api-worker': 1 }),
    childCapacityByParent: mapFrom('child', { 'manager-plan': 2 }),
    budget: mapFrom('budget', { timeMinutes: 300, tokenLimit: 200000, costUsd: 30, taskLimit: 30 }),
  };
  assert.deepEqual(scheduleReadyNodes(graph, options), ['design', 'api']);
  assert.deepEqual(Object.values(accesses), Object.values(accesses).map(() => 1));
});

test('enumerates scheduler option proxies once and never reads through them again', () => {
  const graph = graphFixture('parallel-fan-in');
  let enumerations = 0;
  let reads = 0;
  const priorities = new Proxy({ design: 2 }, {
    ownKeys() {
      enumerations += 1;
      return enumerations === 1 ? ['design'] : [];
    },
    get(target, property, receiver) {
      if (property === 'design') {
        reads += 1;
        return reads === 1 ? 2 : Number.POSITIVE_INFINITY;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(scheduleReadyNodes(graph, { priorities }), ['design', 'api']);
  assert.equal(enumerations, 1);
  assert.equal(reads, 1);
});

test('sanitizes hostile scheduler option getters at every public entry point', () => {
  const graph = graphFixture('parallel-fan-in');
  for (const [name, operation] of [
    ['schedule', options => scheduleReadyNodes(graph, options)],
    ['ready', options => readyNodeIds(graph, options)],
    ['can-start', options => canStart(graph, 'design', options)],
  ]) {
    const canary = `scheduler-${name}-private-canary`;
    let accesses = 0;
    const options = Object.defineProperty({}, 'maxActiveNodes', {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error(canary);
      },
    });
    assertSanitizedGraphError(() => operation(options), 'invalid-scheduler-options', canary);
    assert.equal(accesses, 1);
  }
});

test('sanitizes nested scheduler option proxies and budget getters', () => {
  const graph = graphFixture('parallel-fan-in');
  const proxyCanary = 'scheduler-nested-proxy-private-canary';
  const priorities = new Proxy({}, {
    ownKeys() {
      throw new Error(proxyCanary);
    },
  });
  assertSanitizedGraphError(
    () => scheduleReadyNodes(graph, { priorities }),
    'invalid-scheduler-options',
    proxyCanary,
  );

  const budgetCanary = 'scheduler-budget-private-canary';
  let accesses = 0;
  const budget = {
    timeMinutes: 1,
    tokenLimit: 1,
    taskLimit: 1,
    get costUsd() {
      accesses += 1;
      throw new Error(budgetCanary);
    },
  };
  assertSanitizedGraphError(
    () => readyNodeIds(graph, { budget }),
    'invalid-scheduler-options',
    budgetCanary,
  );
  assert.equal(accesses, 1);
});

test('does not inspect hostile thrown proxies while sanitizing scheduler inputs', () => {
  const graph = graphFixture('parallel-fan-in');
  const canary = 'scheduler-thrown-proxy-private-canary';
  let prototypeAccesses = 0;
  const thrown = new Proxy({}, {
    getPrototypeOf() {
      prototypeAccesses += 1;
      throw new Error(canary);
    },
  });
  const options = Object.defineProperty({}, 'maxActiveNodes', {
    enumerable: true,
    get() {
      throw thrown;
    },
  });

  assertSanitizedGraphError(
    () => scheduleReadyNodes(graph, options),
    'invalid-scheduler-options',
    canary,
  );
  assert.equal(prototypeAccesses, 0);
});

test('rejects forged, subclassed, and reused graph errors as scheduler input failures', () => {
  const graph = graphFixture('parallel-fan-in');
  class ExternalGraphError extends GraphValidationError {}
  const forgedPrototype = Object.create(GraphValidationError.prototype);
  Object.defineProperties(forgedPrototype, {
    message: { value: 'forged-prototype-private-canary', enumerable: true },
    safeMessage: { value: 'forged-prototype-private-canary', enumerable: true },
    details: { value: { reason: 'forged-prototype-private-canary' }, enumerable: true },
  });

  let reused;
  try {
    graphFailure('reused-internal-classification');
  } catch (error) {
    reused = error;
  }
  const mutationCanary = 'mutated-reused-private-canary';
  Reflect.set(reused, 'message', mutationCanary);
  Reflect.set(reused, 'safeMessage', mutationCanary);

  for (const [name, thrown] of [
    ['constructed', new GraphValidationError('constructed-private-canary')],
    ['subclass', new ExternalGraphError('subclass-private-canary')],
    ['prototype', forgedPrototype],
    ['reused', reused],
  ]) {
    const canary = name === 'reused' ? mutationCanary : `${name}-private-canary`;
    const options = Object.defineProperty({}, 'maxActiveNodes', {
      enumerable: true,
      get() {
        throw thrown;
      },
    });
    assertSanitizedGraphError(
      () => readyNodeIds(graph, options),
      'invalid-scheduler-options',
      canary,
    );
  }
  assert.equal(Object.isFrozen(reused), true);
});

test('uses scheduler-owned classifications for internal failures at public entry points', () => {
  const graph = graphFixture('parallel-fan-in');
  assert.throws(
    () => canStart(graph, 'missing-node'),
    error => error instanceof GraphValidationError && error.details.reason === 'invalid-scheduler-options',
  );
  assert.throws(
    () => scheduleReadyNodes(graph, { maxActiveNodes: -1 }),
    error => error instanceof GraphValidationError && error.details.reason === 'invalid-scheduler-options',
  );
});

test('flattens an exported graphFailure thrown reentrantly by a scheduler getter', () => {
  const graph = graphFixture('parallel-fan-in');
  const canary = 'ACTIVE_GRAPH_FAILURE_CANARY';
  let accesses = 0;
  const options = Object.defineProperty({}, 'maxActiveNodes', {
    enumerable: true,
    get() {
      accesses += 1;
      graphFailure(canary);
    },
  });

  assertSanitizedGraphError(
    () => scheduleReadyNodes(graph, options),
    'invalid-scheduler-options',
    canary,
  );
  assert.equal(accesses, 1);
});

test('flattens a nested public graph error caught and rethrown by a scheduler getter', () => {
  const graph = graphFixture('parallel-fan-in');
  const node = graph.nodes.find(candidate => candidate.id === 'design');
  let accesses = 0;
  const options = Object.defineProperty({}, 'maxActiveNodes', {
    enumerable: true,
    get() {
      accesses += 1;
      try {
        completionStatus(node, null);
      } catch (error) {
        throw error;
      }
    },
  });

  assertSanitizedGraphError(
    () => readyNodeIds(graph, options),
    'invalid-scheduler-options',
    'invalid-evidence-item',
  );
  assert.equal(accesses, 1);
});
