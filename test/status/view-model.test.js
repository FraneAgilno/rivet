import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStatusViewModel,
  projectStatusEvents,
} from '../../src/status/view-model.js';

const NOW = Date.parse('2029-01-01T00:10:00.000Z');
const STARTED = Date.parse('2029-01-01T00:00:00.000Z');

function isStatusViewError(error) {
  return error?.name === 'StatusViewError' && error?.code === 'ERR_STATUS_VIEW_INVALID';
}

function node(id, role, status, overrides = {}) {
  return {
    id,
    ...(role === 'boss' ? {} : { parentId: role === 'manager' ? 'boss-plan' : 'manager-plan' }),
    objective: `Private objective for ${id}`,
    owner: { role, id: `${id}-owner` },
    dependencies: role === 'boss' ? [] : [role === 'manager' ? 'boss-plan' : 'manager-plan'],
    authorityScopes: ['implement', 'verify'],
    budget: { timeMinutes: 60, tokenLimit: 10_000, costUsd: 5, taskLimit: 8 },
    completionProfile: role === 'boss' ? 'delivery' : 'engineering',
    requiredEvidenceTypes: ['commit', 'test'],
    evidenceRefs: [`${id}-commit`, `${id}-test`],
    status,
    ...overrides,
  };
}

function runtimeState() {
  const events = [
    {
      schemaVersion: 1,
      eventId: 'event-one',
      graphId: 'demo-graph',
      nodeId: 'quality-worker',
      sequence: 1,
      timestamp: new Date(STARTED).toISOString(),
      actor: { role: 'worker', id: 'quality-worker-owner' },
      type: 'retry',
      retryReason: 'bounded provider retry',
      rawPrompt: 'DO NOT EXPOSE raw prompt canary',
      fullLog: 'DO NOT EXPOSE full log canary',
    },
    {
      schemaVersion: 1,
      eventId: 'event-two',
      graphId: 'demo-graph',
      nodeId: 'human-final',
      sequence: 2,
      timestamp: new Date(STARTED + 1_000).toISOString(),
      actor: { role: 'human', id: 'release-owner' },
      type: 'approval-recorded',
      evidenceRefs: ['final-approval'],
      approvalReceiptId: 'final-approval',
      credential: 'credential-canary',
    },
  ];
  return {
    schemaVersion: 1,
    version: 7,
    activated: true,
    terminal: null,
    startedAtMs: STARTED,
    graph: {
      schemaVersion: 1,
      id: 'demo-graph',
      goal: 'Private raw goal prompt must not be exposed',
      status: 'running',
      nodes: [
        node('boss-plan', 'boss', 'completed'),
        node('manager-plan', 'manager', 'completed'),
        node('quality-worker', 'worker', 'corrective'),
        node('human-final', 'boss', 'ready', {
          parentId: 'boss-plan',
          dependencies: ['quality-worker'],
          approvalGate: 'final-delivery',
          requiredEvidenceTypes: ['human-approval'],
          evidenceRefs: ['final-approval'],
        }),
      ],
    },
    events,
    attempts: { 'quality-worker': 2 },
    launchIntents: {
      'quality-worker': {
        nodeId: 'quality-worker',
        status: 'started',
        attempt: 2,
        startedAtMs: STARTED + 5_000,
        allocation: { timeMinutes: 30, tokenLimit: 5_000, costUsd: '2', taskLimit: 4 },
        worktree: {
          path: '/Users/private/person/project/.worktrees/credential-canary',
          reservationId: 'private-lease',
          branch: 'codex/quality-fix',
          dev: '123',
          ino: '456',
        },
      },
    },
    heartbeats: {
      'quality-worker': {
        version: 1,
        instanceId: 'demo-instance',
        nodeId: 'quality-worker',
        actorId: 'quality-worker-owner',
        leaseId: 'private-lease',
        sequence: 3,
        timestampMs: NOW - 2_000,
        intervalMs: 5_000,
      },
    },
    evidence: [
      {
        id: 'quality-test',
        nodeId: 'quality-worker',
        type: 'test',
        approvalState: 'approved',
        url: 'https://evidence.example/runs/7/report?token=credential-canary#private',
        path: '/Users/private/person/full-report.json',
        raw: 'raw evidence canary',
      },
    ],
    usage: { tokens: 300, costUsd: '0.75', retries: 1, timeMinutes: 10, taskLimit: 3 },
    limits: { tokens: 10_000, costUsd: '5', retries: 3, timeMinutes: 60, taskLimit: 8 },
    environment: { API_TOKEN: 'environment-secret-canary' },
    rawPrompt: 'top-level prompt canary',
    logs: ['top-level log canary'],
  };
}

test('builds an immutable presentation model for graph, agents, gates, corrective work, evidence, and decisions', () => {
  const model = buildStatusViewModel(runtimeState(), { nowMs: NOW });

  assert.equal(model.schemaVersion, 1);
  assert.deepEqual(model.goal, { id: 'demo-graph', status: 'running', version: 7, activated: true, terminal: null });
  assert.deepEqual(model.graph.nodes.map(({ id, parentId, role, status }) => ({ id, parentId, role, status })), [
    { id: 'boss-plan', parentId: null, role: 'boss', status: 'completed' },
    { id: 'manager-plan', parentId: 'boss-plan', role: 'manager', status: 'completed' },
    { id: 'quality-worker', parentId: 'manager-plan', role: 'worker', status: 'corrective' },
    { id: 'human-final', parentId: 'boss-plan', role: 'boss', status: 'ready' },
  ]);
  assert.equal(model.agents.find(agent => agent.id === 'quality-worker-owner').currentNodeId, 'quality-worker');
  assert.equal(model.agents.find(agent => agent.id === 'quality-worker-owner').latestHeartbeatAt, '2029-01-01T00:09:58.000Z');
  assert.equal(model.agents.find(agent => agent.id === 'quality-worker-owner').heartbeatAgeMs, 2_000);
  assert.deepEqual(model.worktrees, [{
    nodeId: 'quality-worker', ownerId: 'quality-worker-owner', status: 'started',
    displayPath: '.worktrees/quality-worker',
  }]);
  assert.deepEqual(model.gates, [{ id: 'final-delivery', nodeId: 'human-final', status: 'ready', requiredEvidence: ['human-approval'] }]);
  assert.deepEqual(model.correctiveWork.map(item => item.nodeId), ['quality-worker']);
  assert.deepEqual(model.evidence, [{
    id: 'quality-test', nodeId: 'quality-worker', type: 'test', approvalState: 'approved',
    url: 'https://evidence.example/runs/7/report',
  }]);
  assert.deepEqual(model.humanDecisions, [{
    id: 'event-two', gateId: 'final-delivery', nodeId: 'human-final', decision: 'approved',
    decidedAt: '2029-01-01T00:00:01.000Z', actorId: 'release-owner', evidenceRefs: ['final-approval'],
  }]);
  assert.equal(model.budget.elapsedMs, 600_000);
  assert.equal(model.budget.usage.tokens, 300);
  assert.equal(model.latestHeartbeatAt, '2029-01-01T00:09:58.000Z');
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.graph.nodes));
});

test('uses an allowlist boundary that omits prompts, logs, environment, credentials, absolute paths, leases, and URL secrets', () => {
  const model = buildStatusViewModel(runtimeState(), { nowMs: NOW });
  const serialized = JSON.stringify(model);

  for (const canary of [
    'Private objective', 'Private raw goal prompt', 'raw prompt canary', 'full log canary',
    'credential-canary', 'environment-secret-canary', '/Users/private', 'private-lease', 'raw evidence canary',
  ]) assert.doesNotMatch(serialized, new RegExp(canary));
  assert.doesNotMatch(serialized, /(?:password|secret|credential|rawPrompt|fullLog|environment|leaseId|worktreePath)/i);
});

test('bounds all collections and strings and reports truncation instead of silently presenting complete evidence', () => {
  const state = runtimeState();
  state.graph.nodes = Array.from({ length: 20 }, (_, index) => node(`worker-${index}`, 'worker', 'ready'));
  state.events = Array.from({ length: 20 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `event-${index}`,
    graphId: 'demo-graph',
    nodeId: `worker-${index}`,
    sequence: index + 1,
    timestamp: new Date(STARTED + index).toISOString(),
    actor: { role: 'worker', id: `worker-${index}-owner` },
    type: 'retry',
    retryReason: 'x'.repeat(200),
  }));
  state.evidence = Array.from({ length: 20 }, (_, index) => ({
    id: `evidence-${index}`, nodeId: `worker-${index}`, type: 'test', approvalState: 'approved',
  }));

  const model = buildStatusViewModel(state, {
    nowMs: NOW,
    limits: { nodes: 5, agents: 5, events: 4, evidence: 3, stringLength: 32 },
  });

  assert.equal(model.graph.nodes.length, 5);
  assert.equal(model.agents.length, 5);
  assert.equal(model.events.length, 4);
  assert.equal(model.evidence.length, 3);
  assert.deepEqual(model.truncated, { nodes: 15, agents: 15, events: 16, evidence: 17 });
  assert.ok(model.events.every(event => !event.retryReason || event.retryReason.length <= 32));
});

test('projects reconnectable events by numeric sequence and never returns arbitrary event fields', () => {
  const events = runtimeState().events;
  const projected = projectStatusEvents(events, { afterSequence: 1, maxEvents: 20, stringLength: 64 });

  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0], {
    id: 'event-two', sequence: 2, timestamp: '2029-01-01T00:00:01.000Z', type: 'approval-recorded',
    nodeId: 'human-final', actor: { role: 'human', id: 'release-owner' }, evidenceRefs: ['final-approval'],
  });
  assert.equal(Object.hasOwn(projected[0], 'credential'), false);
});

test('never invokes caller-owned array methods and rejects extra hidden symbolic and sparse array fields', () => {
  const forged = runtimeState();
  let mapCalls = 0;
  Object.defineProperty(forged.events, 'map', {
    value() { mapCalls += 1; return []; }, enumerable: true,
  });
  assert.throws(
    () => buildStatusViewModel(forged, { nowMs: NOW }),
    isStatusViewError,
  );
  assert.equal(mapCalls, 0);

  for (const mutate of [
    values => { values.extra = 'credential-canary'; },
    values => { Object.defineProperty(values, 'hidden', { value: 'credential-canary' }); },
    values => { values[Symbol('credential-canary')] = true; },
    values => { delete values[0]; },
  ]) {
    const state = runtimeState();
    mutate(state.graph.nodes);
    assert.throws(
      () => buildStatusViewModel(state, { nowMs: NOW }),
      error => isStatusViewError(error)
        && !JSON.stringify(error).includes('credential-canary'),
    );
  }
});

test('strictly snapshots hostile nested state once and replaces thrown values with a fresh fixed error', () => {
  const canary = new Error('authorization Bearer private-canary');
  const forged = Object.assign(new Error('forged private canary'), { name: 'StatusViewError', code: 'ERR_STATUS_VIEW_INVALID' });
  let getterCalls = 0;
  const state = runtimeState();
  Object.defineProperty(state.graph.nodes[0], 'id', {
    enumerable: true,
    get() { getterCalls += 1; throw canary; },
  });
  assert.throws(() => buildStatusViewModel(state, { nowMs: NOW }), error => {
    assert.equal(isStatusViewError(error), true);
    assert.notEqual(error, canary);
    assert.notEqual(error, forged);
    assert.equal(error.message, 'Status state is invalid.');
    assert.doesNotMatch(JSON.stringify(error), /private-canary|Bearer/);
    return true;
  });
  assert.ok(getterCalls <= 1);

  const trapped = runtimeState();
  trapped.events = new Proxy([], { ownKeys() { throw forged; } });
  assert.throws(() => buildStatusViewModel(trapped, { nowMs: NOW }), error => {
    assert.equal(isStatusViewError(error), true);
    assert.notEqual(error, forged);
    assert.equal(error.message, 'Status state is invalid.');
    return true;
  });
});

test('redacts secret patterns absolute paths and unsafe evidence URLs without discarding safe public HTTPS evidence', () => {
  const state = runtimeState();
  const reasons = [
    'Authorization: Bearer bearer-private-canary',
    'provider returned ghp_providerprivatecanary123456',
    'credential=free-text-private-canary',
    '/workspace/person/private/file.js',
    '/home/person/private/project/file.js',
    'C:\\Users\\person\\private\\file.js',
    '\\\\server\\share\\private\\file.js',
    'https://user:private-canary@public.example/path?token=private#fragment',
  ];
  state.events = reasons.map((retryReason, index) => ({
    schemaVersion: 1, eventId: `event-${index + 1}`, graphId: 'demo-graph', nodeId: 'quality-worker',
    sequence: index + 1, timestamp: new Date(STARTED + index).toISOString(),
    actor: { role: 'worker', id: 'quality-worker-owner' }, type: 'retry', retryReason,
  }));
  state.evidence = [
    ['safe-evidence', 'https://evidence.example/public/report'],
    ['userinfo-evidence', 'https://user:private-canary@evidence.example/report'],
    ['query-evidence', 'https://evidence.example/report?token=private-canary'],
    ['fragment-evidence', 'https://evidence.example/report#private-canary'],
    ['path-evidence', 'https://evidence.example/ghp_providerprivatecanary123456/report'],
    ['localhost-evidence', 'https://localhost/report'],
    ['loopback-evidence', 'https://127.0.0.1/report'],
    ['private-ip-evidence', 'https://10.2.3.4/report'],
    ['internal-evidence', 'https://evidence.internal/report'],
  ].map(([id, url]) => ({ id, nodeId: 'quality-worker', type: 'test', approvalState: 'approved', url }));

  const model = buildStatusViewModel(state, { nowMs: NOW });
  const serialized = JSON.stringify(model);
  for (const canary of ['bearer-private-canary', 'ghp_providerprivatecanary123456', 'free-text-private-canary', '/workspace/person', '/home/person', 'C:\\\\Users', '\\\\server', 'user:private-canary']) {
    assert.doesNotMatch(serialized, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.deepEqual(model.evidence.map(item => [item.id, item.url ?? null]), [
    ['safe-evidence', 'https://evidence.example/public/report'],
    ['userinfo-evidence', null],
    ['query-evidence', 'https://evidence.example/report'],
    ['fragment-evidence', 'https://evidence.example/report'],
    ['path-evidence', null],
    ['localhost-evidence', null], ['loopback-evidence', null], ['private-ip-evidence', null], ['internal-evidence', null],
  ]);
});

test('rejects cookie session environment credentials and punctuation-embedded absolute paths', () => {
  const state = runtimeState();
  const reasons = [
    'Cookie: sessionid=cookie-private-canary',
    'session=session-private-canary',
    'sessionid: sessionid-private-canary',
    'AWS_SECRET_ACCESS_KEY=aws-private-canary',
    'AWS_SECRET_ACCESS_KEY: aws-colon-private-canary',
    'AWS_ACCESS_KEY_ID=access-private-canary',
    'DATABASE_URL=database-private-canary',
    'OPENAI_API_KEY: openai-private-canary',
    'GITHUB_TOKEN=github-private-canary',
    'detail=/workspace/person/private/file.js',
    'detail:C:\\Users\\person\\private\\file.js',
    'detail=\\\\server\\share\\private\\file.js',
  ];
  state.events = reasons.map((retryReason, index) => ({
    schemaVersion: 1, eventId: `secret-event-${index + 1}`, graphId: 'demo-graph', nodeId: 'quality-worker',
    sequence: index + 1, timestamp: new Date(STARTED + index).toISOString(),
    actor: { role: 'worker', id: 'quality-worker-owner' }, type: 'retry', retryReason,
  }));
  state.events.push({
    schemaVersion: 1, eventId: 'safe-event', graphId: 'demo-graph', nodeId: 'quality-worker',
    sequence: reasons.length + 1, timestamp: new Date(STARTED + reasons.length).toISOString(),
    actor: { role: 'worker', id: 'quality-worker-owner' }, type: 'retry', retryReason: 'bounded provider retry',
  });

  const model = buildStatusViewModel(state, { nowMs: NOW });
  const serialized = JSON.stringify(model);
  for (const canary of [
    'cookie-private-canary', 'session-private-canary', 'sessionid-private-canary', 'aws-private-canary',
    'aws-colon-private-canary', 'access-private-canary', 'database-private-canary', 'openai-private-canary',
    'github-private-canary', '/workspace/person',
    'C:\\\\Users', '\\\\server',
  ]) assert.doesNotMatch(serialized, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.equal(model.events.at(-1).retryReason, 'bounded provider retry');
});

test('evidence links reject percent-encoded and credential-shaped path segments at every encoding depth', () => {
  const state = runtimeState();
  state.evidence = [
    ['safe', 'https://evidence.example/public/report?signature=private#fragment'],
    ['encoded-once', 'https://evidence.example/public/%67%68%70_private-canary/report'],
    ['encoded-twice', 'https://evidence.example/public/%2567%2568%2570_private-canary/report'],
    ['encoded-separator', 'https://evidence.example/public%2Fcredential%2Fprivate-canary'],
    ['session-segment', 'https://evidence.example/public/session/private-canary'],
    ['session-token-segment', 'https://evidence.example/public/report/session-token'],
    ['key-segment', 'https://evidence.example/public/access-key/private-canary'],
  ].map(([id, url]) => ({ id, nodeId: 'quality-worker', type: 'test', approvalState: 'approved', url }));

  const model = buildStatusViewModel(state, { nowMs: NOW });
  assert.deepEqual(model.evidence.map(item => [item.id, item.url ?? null]), [
    ['safe', 'https://evidence.example/public/report'],
    ['encoded-once', null], ['encoded-twice', null], ['encoded-separator', null],
    ['session-segment', null], ['session-token-segment', null], ['key-segment', null],
  ]);
  assert.doesNotMatch(JSON.stringify(model), /private-canary|%25|%67|%2F/i);
});

test('accepts and exactly truncates the canonical ten-thousand-event runtime window', () => {
  const events = Array.from({ length: 10_000 }, (_, index) => ({
    schemaVersion: 1, eventId: `bounded-event-${index + 1}`, graphId: 'demo-graph', nodeId: 'quality-worker',
    sequence: index + 1, timestamp: new Date(STARTED + index).toISOString(),
    actor: { role: 'worker', id: 'quality-worker-owner' }, type: 'heartbeat',
    heartbeatSequence: index + 1, heartbeatIntervalMs: 5_000,
  }));
  const projected = projectStatusEvents(events);
  assert.equal(projected.length, 200);
  assert.equal(projected[0].sequence, 9_801);
  assert.equal(projected.at(-1).sequence, 10_000);

  const state = runtimeState();
  state.events = events;
  const fullModel = buildStatusViewModel(state, { nowMs: NOW });
  assert.equal(fullModel.events.length, 200);
  assert.equal(fullModel.events[0].sequence, 9_801);
  assert.equal(fullModel.truncated.events, 9_800);

  state.events = events.slice(0, 4_097);
  const model = buildStatusViewModel(state, { nowMs: NOW });
  assert.equal(model.events.length, 200);
  assert.equal(model.events[0].sequence, 3_898);
  assert.equal(model.truncated.events, 3_897);

  const tooMany = [...events, events[0]];
  assert.throws(() => projectStatusEvents(tooMany), isStatusViewError);
});
