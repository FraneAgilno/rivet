import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readyNodeIds } from '../../src/graph/scheduler.js';
import { validateExecutionGraph } from '../../src/graph/validate.js';
import { createOrchestrator } from '../../src/runtime/orchestrator.js';

const fixtureRoot = path.resolve(import.meta.dirname, '../fixtures');
const NOW = Date.parse('2029-01-01T00:00:00.000Z');

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(fixtureRoot, relativePath), 'utf8'));
}

function memoryInstance(graph) {
  let locked = false;
  let state = structuredClone({
    schemaVersion: 1,
    version: 0,
    activated: true,
    terminal: null,
    graph,
    events: [],
    attempts: {},
    launchIntents: {},
    results: {},
    heartbeats: {},
    evidence: [],
    usage: { tokens: 0, costUsd: 0, retries: 0, timeMinutes: 0, taskLimit: 0 },
    limits: { tokens: 1_000_000, costUsd: 100, retries: 1 },
  });
  return {
    id: 'fixture-orchestration',
    async acquire() {
      assert.equal(locked, false);
      locked = true;
      let released = false;
      return { release: async () => { if (!released) { released = true; locked = false; } } };
    },
    async read() {
      assert.equal(locked, true);
      return structuredClone(state);
    },
    async commit(expectedVersion, next) {
      assert.equal(locked, true);
      assert.equal(state.version, expectedVersion);
      state = structuredClone(next);
      return structuredClone(state);
    },
    inspect() { return structuredClone(state); },
  };
}

function launchFor(node, intent) {
  return {
    nodeId: node.id,
    parentId: node.parentId ?? null,
    objective: node.objective,
    ownedPaths: [`src/${node.id}.js`],
    authority: { actions: ['file.write'], providers: [] },
    commands: ['test.unit'],
    evidence: node.evidenceRefs,
    budget: {
      maxTokens: node.budget.tokenLimit,
      maxRuntimeMs: 10_000,
      maxCostUsd: node.budget.costUsd,
    },
    worktree: {
      path: `/tmp/${node.id}`,
      dev: '1',
      ino: '2',
      reservationId: intent.reservationId,
    },
    contextRefs: ['fixture-orchestration'],
    heartbeatInterval: 1_000,
    stopConditions: ['objective-complete'],
  };
}

test('generic graph fixture validates and exposes a bounded fan-in', async () => {
  const graph = await json('graphs/parallel-fan-in.json');

  assert.equal(validateExecutionGraph(graph), true);
  assert.deepEqual(readyNodeIds(graph, { maxActiveNodes: 2 }), ['design', 'api']);
  assert.equal(readyNodeIds(graph).includes('integration'), false);

  graph.nodes.find(node => node.id === 'design').status = 'completed';
  graph.nodes.find(node => node.id === 'api').status = 'completed';
  assert.deepEqual(readyNodeIds(graph), ['integration']);
});

test('generic graph fixture executes independent workers and records fan-in evidence', async () => {
  const graph = await json('graphs/parallel-fan-in.json');
  const instance = memoryInstance(graph);
  const runtime = createOrchestrator({
    client: {
      provider: 'fixture',
      launch: async contract => ({
        version: 1,
        status: 'success',
        output: { summary: 'fixture worker completed', evidence: contract.evidence },
        usage: { tokens: 1, costUsd: 0 },
      }),
    },
    now: () => NOW,
    launchFor,
    reservationId: (_nodeId, sequence) => `fixture-lease-${sequence}`,
  });

  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 2 });
  assert.deepEqual(first.launched, ['api', 'design']);
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'integration').status, 'ready');

  const second = await runtime.tick(instance, { expectedVersion: first.version, maxActiveNodes: 2 });
  assert.deepEqual(second.launched, ['integration']);
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'integration').status, 'completed');
  assert.deepEqual(
    instance.inspect().evidence.filter(item => item.nodeId === 'integration').map(item => item.id),
    ['integration-commit', 'integration-journey', 'integration-test'],
  );
});
