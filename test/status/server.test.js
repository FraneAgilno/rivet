import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';

import { createStatusServer } from '../../src/status/server.js';

const NOW = Date.parse('2029-01-01T00:10:00.000Z');

function state() {
  return {
    schemaVersion: 1,
    version: 1,
    activated: true,
    terminal: null,
    graph: {
      schemaVersion: 1,
      id: 'demo-graph',
      goal: 'private goal prompt',
      status: 'running',
      nodes: [{
        id: 'worker-one',
        objective: 'private worker prompt',
        owner: { role: 'worker', id: 'worker-one-owner' },
        dependencies: [],
        authorityScopes: ['implement'],
        budget: { timeMinutes: 10, tokenLimit: 100, costUsd: 1, taskLimit: 1 },
        completionProfile: 'engineering',
        requiredEvidenceTypes: ['test'],
        evidenceRefs: ['worker-test'],
        status: 'running',
      }],
    },
    events: [
      {
        schemaVersion: 1, eventId: 'event-one', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 1,
        timestamp: '2029-01-01T00:00:00.000Z', actor: { role: 'worker', id: 'worker-one-owner' },
        type: 'heartbeat', instanceId: 'demo-instance', leaseId: 'private-lease', heartbeatSequence: 1,
        heartbeatIntervalMs: 5_000, rawPrompt: 'prompt-canary',
      },
      {
        schemaVersion: 1, eventId: 'event-two', graphId: 'demo-graph', nodeId: 'worker-one', sequence: 2,
        timestamp: '2029-01-01T00:00:01.000Z', actor: { role: 'worker', id: 'worker-one-owner' },
        type: 'evidence-recorded', evidenceRefs: ['worker-test'], credential: 'credential-canary',
      },
    ],
    launchIntents: {
      'worker-one': {
        nodeId: 'worker-one', status: 'started', attempt: 1, startedAtMs: NOW - 5_000,
        worktree: { path: '/Users/private/worktree', reservationId: 'private-lease' },
      },
    },
    heartbeats: {
      'worker-one': {
        version: 1, instanceId: 'demo-instance', nodeId: 'worker-one', actorId: 'worker-one-owner',
        leaseId: 'private-lease', sequence: 1, timestampMs: NOW - 1_000, intervalMs: 5_000,
      },
    },
    evidence: [],
    usage: { tokens: 1, costUsd: '0', retries: 0, timeMinutes: 1, taskLimit: 1 },
    limits: { tokens: 100, costUsd: '1', retries: 2, timeMinutes: 10, taskLimit: 2 },
    environment: { API_TOKEN: 'environment-canary' },
  };
}

async function runningServer(t, overrides = {}) {
  const status = createStatusServer({
    readState: async () => state(),
    now: () => NOW,
    pollIntervalMs: 25,
    ...overrides,
  });
  const address = await status.start();
  t.after(() => status.close());
  return { status, address };
}

function requestRaw(address, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host: address.host, port: address.port, method: 'GET', path, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

function rawPacketStatus(address, headers) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: address.host, port: address.port });
    let data = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolvePromise(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
    socket.once('connect', () => socket.end(`GET /api/state HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`));
  });
}

test('binds only to loopback on a random default port and serves bounded redacted state', async t => {
  const { address } = await runningServer(t);

  assert.equal(address.host, '127.0.0.1');
  assert.ok(Number.isSafeInteger(address.port) && address.port > 0);
  assert.equal(address.url, `http://127.0.0.1:${address.port}`);
  const response = await fetch(`${address.url}/api/state`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const serialized = await response.text();
  assert.doesNotMatch(serialized, /prompt-canary|credential-canary|environment-canary|\/Users\/private|private-lease/);
  const model = JSON.parse(serialized);
  assert.equal(model.goal.id, 'demo-graph');
  assert.equal(model.graph.nodes[0].status, 'running');
});

test('rejects every non-GET request before routing and exposes no mutation endpoint', async t => {
  const { address } = await runningServer(t);

  for (const [method, path] of [
    ['POST', '/api/state'], ['PUT', '/api/events'], ['PATCH', '/events'], ['DELETE', '/'], ['OPTIONS', '/api/state'],
  ]) {
    const response = await fetch(`${address.url}${path}`, { method });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(await response.text(), 'Method Not Allowed');
  }
  assert.equal((await fetch(`${address.url}/api/mutate`)).status, 404);
});

test('applies CSP and security headers to API, event, error, and static responses', async t => {
  const { address } = await runningServer(t);

  for (const path of ['/', '/app.js', '/styles.css', '/api/state', '/api/events', '/missing']) {
    const response = await fetch(`${address.url}${path}`);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/, path);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', path);
    await response.body?.cancel();
  }
});

test('serves only exact packaged assets and rejects traversal and query aliases', async t => {
  const { address } = await runningServer(t);

  const index = await fetch(`${address.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.match(await index.text(), /Orchestration status/i);
  assert.match(await (await fetch(`${address.url}/app.js`)).text(), /EventSource/);
  assert.match(await (await fetch(`${address.url}/styles.css`)).text(), /presentation/i);
  assert.equal((await fetch(`${address.url}/app.js?private=1`)).status, 404);
  assert.equal((await fetch(`${address.url}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${address.url}//app.js`)).status, 404);
  assert.equal((await requestRaw(address, '/./app.js')).status, 404);
  assert.equal((await requestRaw(address, '/%61pp.js')).status, 404);
});

test('requires the exact actual loopback Host and same-origin Origin before every route', async t => {
  const { address } = await runningServer(t);
  assert.equal((await requestRaw(address, '/api/state', { host: `localhost:${address.port}` })).status, 421);
  assert.equal((await requestRaw(address, '/api/state', { host: '127.0.0.1' })).status, 421);
  assert.equal((await requestRaw(address, '/api/state', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await requestRaw(address, '/api/state', { origin: address.url })).status, 200);
  assert.equal(await rawPacketStatus(address, `Host: 127.0.0.1:${address.port}\r\nHost: localhost:${address.port}`), 421);
  assert.equal(await rawPacketStatus(address, `Host: 127.0.0.1:${address.port}\r\nOrigin: ${address.url}\r\nOrigin: ${address.url}`), 403);
  assert.ok([400, 421].includes(await rawPacketStatus(address, 'Accept: application/json')));
});

async function firstSseFrame(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  let frame = '';
  for (let index = 0; index < 8 && !/event: (?:status|reset)|: heartbeat/.test(frame); index += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    frame += new TextDecoder().decode(value);
  }
  controller.abort();
  return frame;
}

test('SSE sends retry metadata and resumes strictly after Last-Event-ID without leaking private fields', async t => {
  const { address } = await runningServer(t);

  const initial = await firstSseFrame(`${address.url}/events`);
  assert.match(initial, /retry: 2000/);
  assert.match(initial, /id: 1/);
  assert.match(initial, /id: 2/);
  assert.doesNotMatch(initial, /prompt-canary|credential-canary|private-lease/);

  const resumed = await firstSseFrame(`${address.url}/events`, { 'last-event-id': '1' });
  assert.doesNotMatch(resumed, /id: 1(?:\D|$)/);
  assert.match(resumed, /id: 2/);
  assert.match(resumed, /event: status/);
});

test('SSE emits an explicit reset marker when reconnect history is outside the bounded event window', async t => {
  const crowded = state();
  crowded.events = Array.from({ length: 6 }, (_, index) => ({
    schemaVersion: 1, eventId: `event-${index + 1}`, graphId: 'demo-graph', nodeId: 'worker-one', sequence: index + 1,
    timestamp: new Date(Date.parse('2029-01-01T00:00:00.000Z') + index).toISOString(),
    actor: { role: 'worker', id: 'worker-one-owner' }, type: 'evidence-recorded', evidenceRefs: ['worker-test'],
  }));
  const { address } = await runningServer(t, { readState: async () => crowded, limits: { events: 3 } });

  const frame = await firstSseFrame(`${address.url}/events`, { 'last-event-id': '1' });
  assert.match(frame, /event: reset/);
  assert.match(frame, /(?:^|\n)id:\n/);
  assert.match(frame, /"firstAvailableSequence":4/);
  assert.match(frame, /id: 4/);
  assert.match(frame, /id: 6/);
});

test('rejects malformed reconnect cursors and caps simultaneous SSE clients', async t => {
  const { address } = await runningServer(t, { maxSseClients: 1 });
  assert.equal((await fetch(`${address.url}/events`, { headers: { 'last-event-id': 'private' } })).status, 400);

  const controller = new AbortController();
  const first = await fetch(`${address.url}/events`, { signal: controller.signal });
  assert.equal(first.status, 200);
  const second = await fetch(`${address.url}/events`);
  assert.equal(second.status, 503);
  controller.abort();
  await first.body?.cancel().catch(() => {});
});

test('bounds every state read with an AbortSignal and returns a fixed sanitized unavailable response', async t => {
  let observedSignal;
  let rejectLate;
  const late = new Promise((_resolve, reject) => { rejectLate = reject; });
  const { address } = await runningServer(t, {
    readTimeoutMs: 25,
    readState: ({ signal }) => { observedSignal = signal; return late; },
  });
  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort(), 250);
  const response = await fetch(`${address.url}/api/state`, { signal: requestController.signal });
  clearTimeout(requestTimeout);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Status unavailable');
  assert.equal(observedSignal.aborted, true);
  rejectLate(new Error('Bearer late-private-canary'));
  await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
});

test('observes native reader promises without invoking poisoned own then properties', async t => {
  let thenCalls = 0;
  const result = Promise.resolve(state());
  Object.defineProperty(result, 'then', {
    value() { thenCalls += 1; throw new Error('Bearer poisoned-then-private-canary'); },
    enumerable: true,
  });
  const { address } = await runningServer(t, { readState: () => result });

  const response = await fetch(`${address.url}/api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).goal.id, 'demo-graph');
  assert.equal(thenCalls, 0);
});

test('flattens hostile thenables without reading or invoking their caller-owned then property', async t => {
  let thenCalls = 0;
  const thenable = {};
  Object.defineProperty(thenable, 'then', {
    value() { thenCalls += 1; throw new Error('sessionid=thenable-private-canary'); },
    enumerable: true,
  });
  const { address } = await runningServer(t, { readTimeoutMs: 25, readState: () => thenable });

  const response = await fetch(`${address.url}/api/state`);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Status unavailable');
  assert.equal(thenCalls, 0);
});

test('disconnect aborts an in-flight SSE read and never installs a polling interval afterward', async t => {
  let calls = 0;
  let signal;
  const { status, address } = await runningServer(t, {
    readTimeoutMs: 200,
    readState: options => { calls += 1; signal = options.signal; return new Promise(() => {}); },
  });
  const controller = new AbortController();
  const response = await fetch(`${address.url}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  controller.abort();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 80));
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  await Promise.race([
    status.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close hung')), 200)),
  ]);
});

test('static presentation renders worktrees, concrete graph edges, and handles SSE cursor resets', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL('../../src/status/public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/status/public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/status/public/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="worktrees"/);
  assert.match(app, /model\.worktrees/);
  assert.match(app, /displayPath/);
  assert.match(app, /parentId/);
  assert.match(app, /dependencies\.join/);
  assert.match(app, /addEventListener\(['"]reset['"]/);
  assert.match(styles, /presentation/i);
});
