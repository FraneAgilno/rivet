import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeClient } from '../../src/clients/fake.js';

function validLaunch(overrides = {}) {
  return {
    nodeId: 'worker-one', parentId: 'manager-one', objective: 'Implement safely.',
    ownedPaths: ['src/agenda/button.js'], authority: { actions: ['code.write'], providers: [] },
    commands: ['test.unit'], evidence: ['test-results'],
    budget: { maxTokens: 12000, maxRuntimeMs: 30000, maxCostUsd: 2 },
    worktree: { path: '/tmp/worktree', dev: '1', ino: '2', reservationId: 'lease-one' },
    contextRefs: ['jira-demo-1'], heartbeatInterval: 5000, stopConditions: ['objective-complete'],
    ...overrides,
  };
}

test('plays immutable scripted success and retry fixtures deterministically', async () => {
  const clock = { now: () => 1000, wait: async () => {} };
  const scripts = [
    { version: 1, kind: 'retry', delayMs: 10, output: { summary: 'retry later', evidence: [] }, usage: { tokens: 2, costUsd: 0 } },
    { version: 1, kind: 'success', output: { summary: 'done', evidence: ['tests'] }, usage: { tokens: 10, costUsd: 0.1 } },
  ];
  const client = createFakeClient({ scripts, clock });
  scripts[0].delayMs = 999;
  const first = await client.launch(validLaunch());
  const second = await client.launch(validLaunch());
  assert.deepEqual(first, { version: 1, status: 'retry', output: { summary: 'retry later', evidence: [] }, usage: { tokens: 2, costUsd: 0 } });
  assert.deepEqual(second, { version: 1, status: 'success', output: { summary: 'done', evidence: ['tests'] }, usage: { tokens: 10, costUsd: 0.1 } });
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(second.output));
  assert.ok(Object.isFrozen(second.usage));
});

test('supports stall, malformed, budget exhaustion and cancellation without processes or network', async () => {
  const stalled = createFakeClient({ scripts: [{ version: 1, kind: 'stall' }], clock: { now: () => 1, wait: async () => {} } });
  await assert.rejects(() => stalled.launch(validLaunch()), error => error.code === 'ERR_AGENT_TIMEOUT');
  const malformed = createFakeClient({ scripts: [{ version: 1, kind: 'malformed', payload: 'not-json' }] });
  await assert.rejects(() => malformed.launch(validLaunch()), error => error.code === 'ERR_AGENT_OUTPUT_INVALID');
  const budget = createFakeClient({ scripts: [{ version: 1, kind: 'budget-exhausted', output: { summary: 'budget used', evidence: [] }, usage: { tokens: 12000, costUsd: 2 } }] });
  assert.deepEqual(await budget.launch(validLaunch()), { version: 1, status: 'budget-exhausted', output: { summary: 'budget used', evidence: [] }, usage: { tokens: 12000, costUsd: 2 } });
  const controller = new AbortController(); controller.abort();
  const cancelled = createFakeClient({ scripts: [{ version: 1, kind: 'cancel' }] });
  await assert.rejects(() => cancelled.launch(validLaunch(), { signal: controller.signal }), error => error.code === 'ERR_AGENT_ABORTED');

  const waitingController = new AbortController();
  const waiting = createFakeClient({
    scripts: [{ version: 1, kind: 'retry', delayMs: 1000, output: { summary: 'retry later', evidence: [] }, usage: { tokens: 0, costUsd: 0 } }],
    clock: { now: () => 2, wait: () => new Promise(() => {}) },
  }).launch(validLaunch(), { signal: waitingController.signal });
  waitingController.abort();
  await assert.rejects(() => waiting, error => error.code === 'ERR_AGENT_ABORTED');
});

test('supports exact failed and blocked production envelopes', async () => {
  const client = createFakeClient({ scripts: [
    { version: 1, kind: 'failed', output: { summary: 'implementation failed', evidence: ['failure-log'] }, usage: { tokens: 20, costUsd: 0.1 } },
    { version: 1, kind: 'blocked', output: { summary: 'human decision required', evidence: ['approval-request'] }, usage: { tokens: 25, costUsd: 0.2 } },
  ] });
  assert.deepEqual(await client.launch(validLaunch()), {
    version: 1, status: 'failed', output: { summary: 'implementation failed', evidence: ['failure-log'] }, usage: { tokens: 20, costUsd: 0.1 },
  });
  assert.deepEqual(await client.launch(validLaunch()), {
    version: 1, status: 'blocked', output: { summary: 'human decision required', evidence: ['approval-request'] }, usage: { tokens: 25, costUsd: 0.2 },
  });
});

test('rejects canonical sensitive-label assignments in fake results without over-redacting ordinary text', () => {
  for (const secret of [
    '{"token":"secret-value"}', 'token\u200b=supersecret', '“password”\u2060:\u2060“private-value”',
    'API KEY: private-value', 'auth.token=private-value', '\\"token\\":\\"private-value\\"', 'access - token = private-value',
  ]) {
    assert.throws(() => createFakeClient({ scripts: [{
      version: 1, kind: 'success', output: { summary: secret, evidence: ['tests'] }, usage: { tokens: 1, costUsd: 0 },
    }] }), error => error.code === 'ERR_AGENT_INVALID_SCRIPT' && !error.message.includes('supersecret'));
  }
  assert.doesNotThrow(() => createFakeClient({ scripts: [{
    version: 1, kind: 'success',
    output: { summary: 'Use a token bucket and document API key rotation.', evidence: ['tests'] },
    usage: { tokens: 1, costUsd: 0 },
  }] }));
});

test('enforces runtime deadlines, watchdogs never-settling waits, and cleans abort listeners', async () => {
  let waitCalls = 0;
  const overBudget = createFakeClient({
    scripts: [{ version: 1, kind: 'success', delayMs: 30, output: { summary: 'late', evidence: [] }, usage: { tokens: 1, costUsd: 0 } }],
    clock: { now: () => 0, wait: async () => { waitCalls += 1; } },
  });
  await assert.rejects(() => overBudget.launch(validLaunch({ budget: { maxTokens: 10, maxRuntimeMs: 20, maxCostUsd: 1 } })), error => error.code === 'ERR_AGENT_TIMEOUT');
  assert.equal(waitCalls, 0);

  const neverSettling = createFakeClient({
    scripts: [{ version: 1, kind: 'success', delayMs: 5, output: { summary: 'never', evidence: [] }, usage: { tokens: 1, costUsd: 0 } }],
    clock: { now: () => 0, wait: () => new Promise(() => {}) },
  });
  const bounded = await Promise.race([
    neverSettling.launch(validLaunch({ budget: { maxTokens: 10, maxRuntimeMs: 25, maxCostUsd: 1 } })).then(() => 'resolved', error => error.code),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 250)),
  ]);
  assert.equal(bounded, 'ERR_AGENT_TIMEOUT');

  let nowCall = 0;
  const deadline = createFakeClient({
    scripts: [{ version: 1, kind: 'success', delayMs: 5, output: { summary: 'late clock', evidence: [] }, usage: { tokens: 1, costUsd: 0 } }],
    clock: { now: () => [0, 30][Math.min(nowCall++, 1)], wait: async () => {} },
  });
  await assert.rejects(() => deadline.launch(validLaunch({ budget: { maxTokens: 10, maxRuntimeMs: 20, maxCostUsd: 1 } })), error => error.code === 'ERR_AGENT_TIMEOUT');

  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added += 1; originalAdd(...args); controller.abort(); };
  signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  const cancelling = createFakeClient({
    scripts: [{ version: 1, kind: 'retry', delayMs: 5, output: { summary: 'retry', evidence: [] }, usage: { tokens: 0, costUsd: 0 } }],
    clock: { now: () => 0, wait: () => new Promise(() => {}) },
  });
  await assert.rejects(() => cancelling.launch(validLaunch(), { signal }), error => error.code === 'ERR_AGENT_ABORTED');
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('rejects hostile or unversioned scripts and snapshots abort signal once', async () => {
  assert.throws(() => createFakeClient({ scripts: [{ version: 2, kind: 'stall' }] }), /script/i);
  assert.throws(() => createFakeClient({ scripts: [{ kind: 'stall' }] }), /script/i);
  const client = createFakeClient({ scripts: [{ version: 1, kind: 'stall' }] });
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'signal', { enumerable: true, get() { reads += 1; return undefined; } });
  await assert.rejects(() => client.launch(validLaunch(), options), error => error.code === 'ERR_AGENT_TIMEOUT');
  assert.equal(reads, 1);
});

test('sanitizes hostile nested scripts, results, evidence, clocks, and options', async () => {
  const canary = 'CANARY-FAKE-SECRET';
  const hostileScripts = new Proxy([], { get() { throw new Error(canary); } });
  assert.throws(() => createFakeClient({ scripts: hostileScripts }), error => error.code === 'ERR_AGENT_INVALID_SCRIPT' && !error.message.includes(canary));

  const evidence = new Proxy([], { get() { throw new Error(canary); } });
  assert.throws(() => createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'done', evidence }, usage: { tokens: 1, costUsd: 0 } }] }), error => (
    error.code === 'ERR_AGENT_INVALID_SCRIPT' && !error.message.includes(canary)
  ));
  const evidencePrototype = new Proxy([], { getPrototypeOf() { throw new Error(canary); } });
  assert.throws(() => createFakeClient({ scripts: [{ version: 1, kind: 'success', output: { summary: 'done', evidence: evidencePrototype }, usage: { tokens: 1, costUsd: 0 } }] }), error => (
    error.code === 'ERR_AGENT_INVALID_SCRIPT' && !error.message.includes(canary)
  ));

  const clock = new Proxy({}, { ownKeys() { throw new Error(canary); } });
  assert.throws(() => createFakeClient({ scripts: [{ version: 1, kind: 'stall' }], clock }), error => error.code === 'ERR_AGENT_INVALID_SCRIPT');

  const client = createFakeClient({ scripts: [{ version: 1, kind: 'stall' }] });
  const options = new Proxy({}, { ownKeys() { throw new Error(canary); } });
  await assert.rejects(() => client.launch(validLaunch(), options), error => error.code === 'ERR_AGENT_INVALID_SCRIPT' && !error.message.includes(canary));

  let kindReads = 0;
  let evidenceReads = 0;
  const script = { version: 1, output: { summary: 'done', evidence: [] }, usage: { tokens: 1, costUsd: 0 } };
  Object.defineProperty(script, 'kind', { enumerable: true, get() { kindReads += 1; return 'success'; } });
  Object.defineProperty(script.output.evidence, '0', { enumerable: true, configurable: true, get() { evidenceReads += 1; return 'tests'; } });
  script.output.evidence.length = 1;
  createFakeClient({ scripts: [script] });
  assert.equal(kindReads, 1);
  assert.equal(evidenceReads, 1);
});
