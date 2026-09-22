import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseDocument } from 'yaml';

import { createFakeClient } from '../../src/clients/fake.js';
import { readyNodeIds } from '../../src/graph/scheduler.js';
import { validateExecutionGraph } from '../../src/graph/validate.js';
import { createOrchestrator } from '../../src/runtime/orchestrator.js';
import { createRetryPolicy } from '../../src/runtime/retry.js';

const root = path.resolve(import.meta.dirname, '../..');
const demoRoot = path.join(root, 'demo/conference');
const NOW = Date.parse('2029-01-01T00:00:00.000Z');

async function readBounded(relativePath, maximum = 128 * 1024) {
  const absolutePath = path.join(demoRoot, relativePath);
  const metadata = await lstat(absolutePath);
  assert.equal(metadata.isSymbolicLink(), false, `${relativePath} cannot be a symlink`);
  assert.equal(metadata.isFile(), true, `${relativePath} must be a file`);
  assert.ok(metadata.size > 0 && metadata.size <= maximum, `${relativePath} must be bounded`);
  return readFile(absolutePath, 'utf8');
}

async function yaml(relativePath) {
  const document = parseDocument(await readBounded(relativePath), {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.warnings, []);
  return document.toJS({ maxAliasCount: 0, mapAsMap: false });
}

async function json(relativePath) {
  return JSON.parse(await readBounded(relativePath));
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
    id: 'conference-local-rehearsal',
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
    ownedPaths: ['templates/conference-planner/src/components/ConflictDialog.tsx'],
    authority: { actions: ['file.write'], providers: [] },
    commands: ['test.unit'],
    evidence: node.evidenceRefs,
    budget: {
      maxTokens: node.budget.tokenLimit,
      maxRuntimeMs: 10_000,
      maxCostUsd: node.budget.costUsd,
    },
    worktree: {
      path: '/tmp/conference-local-rehearsal',
      dev: '1',
      ino: '2',
      reservationId: intent.reservationId,
    },
    contextRefs: ['conference-fixtures'],
    heartbeatInterval: 1_000,
    stopConditions: ['objective-complete'],
  };
}

test('conference graph is canonical, bounded, provider-independent, and has three Manager lanes', async () => {
  const graph = await yaml('goal-graph.yaml');
  assert.equal(validateExecutionGraph(graph), true);
  assert.equal(graph.id, 'conference-local-release');
  assert.deepEqual(graph.providerRefs, ['bitbucket-ci', 'confluence-fixture', 'jira-fixture']);
  assert.equal(graph.maxDelegationDepth, 3);
  assert.ok(graph.nodes.length <= 16);

  const bossOwners = new Set(graph.nodes.filter(node => node.owner.role === 'boss').map(node => node.owner.id));
  const managerOwners = new Set(graph.nodes.filter(node => node.owner.role === 'manager').map(node => node.owner.id));
  assert.deepEqual([...bossOwners], ['conference-boss']);
  assert.deepEqual([...managerOwners].sort(), ['delivery-manager', 'product-manager', 'quality-manager']);
  assert.match(graph.goal, /provider-independent/i);
  assert.equal(JSON.stringify(graph).toLowerCase().includes('figma'), false);
});

test('conference graph starts three parallel Worker lanes and preserves integration fan-in', async () => {
  const graph = await yaml('goal-graph.yaml');
  assert.deepEqual(readyNodeIds(graph, { maxActiveNodes: 3 }), [
    'api-adjustment',
    'storybook-journey',
    'ui-state',
  ]);
  assert.equal(readyNodeIds(graph).includes('integration'), false);

  for (const id of ['api-adjustment', 'storybook-journey', 'ui-state']) {
    graph.nodes.find(node => node.id === id).status = 'completed';
  }
  assert.deepEqual(readyNodeIds(graph), ['integration']);
  graph.nodes.find(node => node.id === 'integration').status = 'completed';
  assert.deepEqual(readyNodeIds(graph), ['acceptance-run']);
  graph.nodes.find(node => node.id === 'acceptance-run').status = 'completed';
  assert.deepEqual(readyNodeIds(graph), ['focus-restoration-correction']);
});

test('completion and authority policies keep external effects disabled and final delivery human-gated', async () => {
  const profiles = await yaml('completion-profile.yaml');
  const authority = await yaml('authority.yaml');
  const graph = await yaml('goal-graph.yaml');

  assert.equal(profiles.schemaVersion, 1);
  assert.deepEqual(profiles.profiles.map(profile => profile.id), ['delivery', 'engineering', 'quality']);
  assert.deepEqual(profiles.profiles.find(profile => profile.id === 'delivery').requiredApprovals, ['human']);
  assert.equal(authority.enabled, false);
  assert.equal(authority.maxDelegationDepth, 3);
  assert.deepEqual(authority.approvalGates, ['activation', 'external-write', 'final-delivery']);
  for (const role of authority.roles) {
    assert.equal(role.permissions.externalWrites, false);
    assert.equal(role.permissions.merge, false);
    assert.equal(role.permissions.deploy, false);
  }

  const final = graph.nodes.find(node => node.id === 'human-final');
  assert.equal(final.approvalGate, 'final-delivery');
  assert.deepEqual(final.dependencies, ['evidence-bundle']);
  assert.ok(final.requiredEvidenceTypes.includes('human-approval'));
});

test('sanitized provider fixtures contain only bounded read-only conference facts', async () => {
  const jira = await json('fixtures/jira/issues.json');
  const confluence = await json('fixtures/confluence/pages.json');

  assert.deepEqual(jira, {
    schemaVersion: 1,
    source: { kind: 'fixture', mode: 'read-only', resource: 'conference-planner' },
    issues: jira.issues,
  });
  assert.deepEqual(confluence, {
    schemaVersion: 1,
    source: { kind: 'fixture', mode: 'read-only', resource: 'conference-planner' },
    pages: confluence.pages,
  });
  assert.ok(jira.issues.length >= 2 && jira.issues.length <= 8);
  assert.ok(confluence.pages.length >= 1 && confluence.pages.length <= 8);
  const exposed = JSON.stringify({ jira, confluence });
  assert.equal(/(?:token|password|authorization|cookie)\s*[:=]/i.test(exposed), false);
  assert.equal(exposed.includes('/Users/'), false);
  assert.equal(exposed.includes('http://'), false);
});

test('real orchestrator and fake client make the controlled correction retry once and then pass', async () => {
  const graph = await yaml('goal-graph.yaml');
  const fixture = await json('fixtures/runtime/corrective-run.json');
  const completedBeforeCorrection = new Set([
    'boss-plan', 'manager-product', 'manager-delivery', 'manager-quality', 'design-contract',
    'ui-state', 'api-adjustment', 'storybook-journey', 'integration', 'acceptance-run',
  ]);
  for (const node of graph.nodes) {
    if (completedBeforeCorrection.has(node.id)) node.status = 'completed';
  }
  graph.status = 'running';

  let nowMs = NOW;
  const instance = memoryInstance(graph);
  const runtime = createOrchestrator({
    client: createFakeClient({ scripts: fixture.scripts }),
    now: () => nowMs,
    launchFor,
    reservationId: (_nodeId, sequence) => `focus-correction-lease-${sequence}`,
    retryPolicy: createRetryPolicy({ maxAttempts: 2, delaysMs: [100], retryable: ['provider-transient'] }),
  });

  const first = await runtime.tick(instance, { expectedVersion: 0, maxActiveNodes: 1 });
  assert.deepEqual(first.launched, ['focus-restoration-correction']);
  assert.equal(instance.inspect().graph.nodes.find(node => node.id === 'focus-restoration-correction').status, 'corrective');
  assert.equal(instance.inspect().usage.retries, 1);
  nowMs += 100;

  const second = await runtime.tick(instance, { expectedVersion: first.version, maxActiveNodes: 1 });
  assert.deepEqual(second.launched, ['focus-restoration-correction']);
  const finalState = instance.inspect();
  assert.equal(finalState.graph.nodes.find(node => node.id === 'focus-restoration-correction').status, 'completed');
  assert.equal(finalState.attempts['focus-restoration-correction'], 2);
  assert.deepEqual(
    finalState.evidence.filter(item => item.nodeId === 'focus-restoration-correction').map(item => item.id),
    ['focus-commit', 'focus-journey', 'focus-test'],
  );
  assert.equal(finalState.graph.nodes.find(node => node.id === 'human-final').status, 'ready');
});

