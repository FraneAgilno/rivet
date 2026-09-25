import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, link, mkdtemp, open, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ProviderAdapterError,
  createProviderIdempotencyRegistry,
  createProviderWireBody,
  createSourceEnvelope,
  createTrustedConditionalMutationCapability,
  providerWriteResource,
  snapshotProviderJson,
  validateAdapter,
} from '../../src/adapters/contract.js';
import { createFixtureAdapters, createTrustedFixturePacketSource } from '../../src/adapters/fixtures.js';
import { createProviderHttpClient, createTrustedProviderTransport } from '../../src/adapters/http.js';
import { createJiraAdapter } from '../../src/adapters/jira.js';
import { createConfluenceAdapter } from '../../src/adapters/confluence.js';
import { createFigmaAdapter } from '../../src/adapters/figma.js';
import { createGithubAdapter } from '../../src/adapters/github.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'providers');
const NOW = '2029-01-01T00:00:00.000Z';
const execFileAsync = promisify(execFile);

async function fixtureAdaptersFromPreopenedPackets() {
  const handles = {};
  try {
    for (const provider of ['jira', 'confluence', 'figma', 'github']) {
      handles[provider] = await open(join(FIXTURES, `${provider}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    const source = createTrustedFixturePacketSource({ packets: handles });
    return await createFixtureAdapters({ source });
  } finally {
    await Promise.all(Object.values(handles).map(handle => handle.close().catch(() => {})));
  }
}

function trustedTransport(fetchPinned = async () => new Response('{}', {
  status: 200, headers: { 'content-type': 'application/json' },
}), resolve = async () => ['93.184.216.34']) {
  return createTrustedProviderTransport({ fetchPinned, resolve });
}

test('creates an immutable versioned source envelope with a digest and redacted raw reference', () => {
  const envelope = createSourceEnvelope({
    provider: 'jira', sourceId: 'DEMO-42', sourceUrl: 'https://jira.example.test/browse/DEMO-42',
    fetchedAt: NOW, fixtureSource: false,
    raw: { key: 'DEMO-42', authorization: 'Bearer private-provider-secret' },
    normalized: { id: 'DEMO-42', summary: 'Conference agenda' },
    retryClassification: 'none',
    capabilities: { read: ['issue'], write: ['comment', 'status'] },
  });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.provider, 'jira');
  assert.deepEqual(envelope.source, { id: 'DEMO-42', url: 'https://jira.example.test/browse/DEMO-42' });
  assert.match(envelope.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(envelope.rawPayloadRef, {
    kind: 'redacted-sha256', digest: envelope.digest, redacted: true,
  });
  assert.equal(JSON.stringify(envelope).includes('private-provider-secret'), false);
  assert.equal(envelope.retry.classification, 'none');
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.normalized));
  assert.throws(() => { envelope.normalized.summary = 'changed'; }, TypeError);
});

test('snapshots hostile public input once and exposes only typed sanitized failures', () => {
  let accesses = 0;
  const canary = 'private-adapter-canary';
  assert.throws(() => createSourceEnvelope({
    provider: 'jira', sourceId: 'DEMO-42', sourceUrl: 'https://jira.example.test/browse/DEMO-42',
    fetchedAt: NOW, fixtureSource: false,
    get raw() { accesses += 1; throw new Error(canary); },
    normalized: {}, retryClassification: 'none', capabilities: { read: [], write: [] },
  }), error => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.code, 'ERR_PROVIDER_INVALID_ENVELOPE');
    assert.equal(error.message.includes(canary), false);
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  });
  assert.equal(accesses, 1);
  const proxy = new Proxy({}, { ownKeys() { throw new Error(canary); } });
  assert.throws(() => createSourceEnvelope(proxy), ProviderAdapterError);
});

test('fixture adapters satisfy the same contract, are visibly fixture-sourced and read-only', async () => {
  const adapters = await fixtureAdaptersFromPreopenedPackets();
  assert.deepEqual(Object.keys(adapters).sort(), ['confluence', 'figma', 'github', 'jira']);
  for (const [provider, adapter] of Object.entries(adapters)) {
    assert.equal(validateAdapter(adapter), true, provider);
    assert.equal(adapter.fixtureSource, true);
    assert.deepEqual(adapter.capabilities.write, []);
    const envelope = await adapter.read({ kind: adapter.capabilities.read[0] });
    assert.equal(envelope.provider, provider);
    assert.equal(envelope.fixtureSource, true);
    assert.equal(envelope.rawPayloadRef.redacted, true);
    await assert.rejects(() => adapter.write({}), error => error instanceof ProviderAdapterError
      && error.code === 'ERR_PROVIDER_READ_ONLY');
  }
});

test('live adapters declare symmetric immutable read/write contracts and require injected fetch', () => {
  assert.throws(() => createJiraAdapter({ baseUrl: 'https://jira.example.test', fetch: async () => new Response('{}') }), ProviderAdapterError);
  const adapters = [
    createJiraAdapter({ transport: trustedTransport(), baseUrl: 'https://jira.example.test', clock: () => NOW }),
    createConfluenceAdapter({ transport: trustedTransport(), baseUrl: 'https://confluence.example.test', clock: () => NOW }),
    createFigmaAdapter({ transport: trustedTransport(), baseUrl: 'https://api.figma.com', clock: () => NOW }),
    createGithubAdapter({ transport: trustedTransport(), baseUrl: 'https://api.github.com', clock: () => NOW }),
  ];
  for (const adapter of adapters) {
    assert.equal(validateAdapter(adapter), true);
    assert.equal(adapter.version, 1);
    assert.equal(adapter.fixtureSource, false);
    assert.ok(adapter.capabilities.read.length > 0);
    assert.ok(Object.isFrozen(adapter.capabilities.read));
    assert.ok(Object.isFrozen(adapter.capabilities.write));
  }
});

test('HTTP transport pins HTTPS origin, blocks redirects, and classifies sanitized provider failures', async () => {
  const seen = [];
  const client = createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test', timeoutMs: 100,
    transport: trustedTransport(async (url, init, pin) => {
      seen.push({ url, init });
      assert.deepEqual(pin.addresses, ['93.184.216.34']);
      return new Response(JSON.stringify({ error: 'Bearer private-provider-secret' }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' },
      });
    }),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/rest/api/3/issue/DEMO-42' }), error => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.code, 'ERR_PROVIDER_REMOTE');
    assert.equal(error.retryClassification, 'transient');
    assert.equal(JSON.stringify(error).includes('private-provider-secret'), false);
    return true;
  });
  assert.equal(seen[0].url, 'https://jira.example.test/rest/api/3/issue/DEMO-42');
  assert.equal(seen[0].init.redirect, 'error');
  assert.throws(() => client.request({ method: 'GET', path: 'https://metadata.google.internal/' }), ProviderAdapterError);
  assert.throws(() => createProviderHttpClient({ provider: 'jira', baseUrl: 'http://jira.example.test', transport: trustedTransport() }), ProviderAdapterError);
});

test('classifies non-JSON retry responses by status without exposing their body', async () => {
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com',
    transport: trustedTransport(async () => new Response('upstream private diagnostic', { status: 503 })),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => {
    assert.equal(error.code, 'ERR_PROVIDER_REMOTE');
    assert.equal(error.status, 503);
    assert.equal(error.retryClassification, 'transient');
    assert.equal(JSON.stringify(error).includes('private diagnostic'), false);
    return true;
  });
});

test('HTTP transport enforces response, pagination and timeout bounds', async () => {
  const oversized = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', maxResponseBytes: 16,
    transport: trustedTransport(async () => new Response('x'.repeat(17), { status: 200 })),
  });
  await assert.rejects(() => oversized.request({ method: 'GET', path: '/repos/a/b' }), error => error.code === 'ERR_PROVIDER_RESPONSE_TOO_LARGE');

  const timed = createProviderHttpClient({
    provider: 'figma', baseUrl: 'https://api.figma.com', timeoutMs: 10,
    transport: trustedTransport(async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })),
  });
  await assert.rejects(() => timed.request({ method: 'GET', path: '/v1/files/demo' }), error => error.code === 'ERR_PROVIDER_TIMEOUT');

  let calls = 0;
  const paged = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', maxPages: 2,
    transport: trustedTransport(async () => {
      calls += 1;
      return new Response(JSON.stringify([{ page: calls }]), {
        status: 200,
        headers: calls < 3 ? { link: '<https://api.github.com/items?page=' + (calls + 1) + '>; rel="next"' } : {},
      });
    }),
  });
  await assert.rejects(() => paged.paginate({ path: '/items' }), error => error.code === 'ERR_PROVIDER_PAGINATION_LIMIT');
  assert.equal(calls, 2);
});

test('HTTP transport rejects local targets, credential query parameters, and authority-overriding headers', () => {
  for (const baseUrl of [
    'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254', 'https://10.0.0.1',
    'https://192.168.1.5', 'https://172.16.0.1', 'https://[::1]', 'https://provider.local',
  ]) assert.throws(() => createProviderHttpClient({ provider: 'jira', baseUrl, transport: trustedTransport() }), ProviderAdapterError, baseUrl);
  const client = createProviderHttpClient({ provider: 'jira', baseUrl: 'https://jira.example.test', transport: trustedTransport() });
  assert.throws(() => client.request({ method: 'GET', path: '/issue?access_token=private-value' }), ProviderAdapterError);
  assert.throws(() => client.request({ method: 'GET', path: '/issue', headers: { host: 'metadata.internal' } }), ProviderAdapterError);
});

test('HTTP timeout covers a stalled response body, not only fetch headers', async () => {
  const client = createProviderHttpClient({
    provider: 'figma', baseUrl: 'https://api.figma.com', timeoutMs: 10,
    transport: trustedTransport(async () => new Response(new ReadableStream({ start() {} }), { status: 200 })),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/v1/files/demo' }), error => error.code === 'ERR_PROVIDER_TIMEOUT');
});

test('DNS resolution snapshots hostile array length and indices exactly once before fetch', async () => {
  let lengthReads = 0;
  let indexReads = 0;
  let fetched = false;
  const addresses = new Proxy(['93.184.216.34'], {
    get(target, key, receiver) {
      if (key === 'length') {
        lengthReads += 1;
        return lengthReads === 1 ? 2 : 0;
      }
      if (key === '0') indexReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com',
    transport: trustedTransport(async () => { fetched = true; return new Response('{}'); }, async () => addresses),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => error.code === 'ERR_PROVIDER_DNS_UNSAFE');
  assert.equal(lengthReads, 1);
  assert.equal(indexReads, 1);
  assert.equal(fetched, false);
});

function responseWithReader(reader) {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'body', { value: { getReader: () => reader } });
  return response;
}

for (const [name, timeoutMs, maxResponseBytes, reader, expectedCode] of [
  ['timeout', 10, 1024, {
    read: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
  }, 'ERR_PROVIDER_TIMEOUT'],
  ['overflow', 100, 1, {
    read: async () => ({ done: false, value: Uint8Array.of(1, 2) }), cancel: () => new Promise(() => {}),
  }, 'ERR_PROVIDER_RESPONSE_TOO_LARGE'],
]) test(`noncooperative reader cancellation cannot delay the original ${name} classification`, async () => {
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', timeoutMs, maxResponseBytes,
    transport: trustedTransport(async () => responseWithReader(reader)),
  });
  const outcome = await Promise.race([
    client.request({ method: 'GET', path: '/repos/a/b' }).then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('test-deadline'), 80)),
  ]);
  assert.ok(outcome instanceof ProviderAdapterError, String(outcome));
  assert.equal(outcome.code, expectedCode);
});

test('reader failure initiates rejection-safe cancellation without leaking a late canary', async () => {
  const canary = 'private-reader-cancel-canary';
  let cancelCalls = 0;
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com',
      transport: trustedTransport(async () => responseWithReader({
        read: async () => { throw new Error(canary); },
        cancel() { cancelCalls += 1; return Promise.reject(new Error(canary)); },
      })),
    });
    await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => {
      assert.equal(error.code, 'ERR_PROVIDER_TRANSPORT');
      assert.equal(JSON.stringify(error).includes(canary), false);
      return true;
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(cancelCalls, 1);
  assert.deepEqual(unhandled, []);
});

test('reader cancellation observes a poisoned rejected native Promise through the intrinsic then', async () => {
  const canary = 'private-poisoned-cancel-promise';
  let thenGetterReads = 0;
  let rejectCancellation;
  const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; });
  Object.defineProperty(cancellation, 'then', { get() {
    thenGetterReads += 1;
    throw new ProviderAdapterError('aborted', { provider: canary });
  } });
  const observed = Promise.prototype.then.call(cancellation, () => undefined, () => undefined);
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', maxResponseBytes: 1,
    transport: trustedTransport(async () => responseWithReader({
      read: async () => ({ done: false, value: Uint8Array.of(1, 2) }),
      cancel: () => cancellation,
    })),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => {
    assert.equal(error.code, 'ERR_PROVIDER_RESPONSE_TOO_LARGE');
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(canary), false);
    return true;
  });
  rejectCancellation(new Error(canary));
  await observed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(thenGetterReads, 0);
});

test('reader cancellation ignores hostile non-Promises and settles late native outcomes without changing classification', async () => {
  for (const outcome of ['fulfilled', 'rejected', 'hostile-non-promise']) {
    let thenGetterReads = 0;
    let settle;
    let cancellation;
    let observed = Promise.resolve();
    if (outcome === 'hostile-non-promise') {
      cancellation = Object.defineProperty({}, 'then', { get() {
        thenGetterReads += 1;
        throw new Error('private-hostile-cancel-thenable');
      } });
    } else {
      cancellation = new Promise((resolve, reject) => { settle = outcome === 'fulfilled' ? resolve : reject; });
      Object.defineProperty(cancellation, 'then', { get() {
        thenGetterReads += 1;
        throw new Error('private-hostile-cancel-then');
      } });
      observed = Promise.prototype.then.call(cancellation, () => undefined, () => undefined);
    }
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com', maxResponseBytes: 1,
      transport: trustedTransport(async () => responseWithReader({
        read: async () => ({ done: false, value: Uint8Array.of(1, 2) }), cancel: () => cancellation,
      })),
    });
    await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => (
      error.code === 'ERR_PROVIDER_RESPONSE_TOO_LARGE'
    ), outcome);
    if (settle) settle(outcome === 'rejected' ? new Error('private-late-cancel-rejection') : undefined);
    await observed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(thenGetterReads, 0, outcome);
  }
});

test('native AbortSignal intrinsics isolate hostile own fields and cleanup cannot mask cancellation', async () => {
  const canary = 'private-hostile-native-signal';
  const forged = new ProviderAdapterError('remote', { provider: 'github' });
  forged.message = canary;
  forged.cause = new Error(canary);
  const controller = new AbortController();
  const accesses = { aborted: 0, addEventListener: 0, removeEventListener: 0 };
  for (const field of Object.keys(accesses)) Object.defineProperty(controller.signal, field, { get() {
    accesses[field] += 1;
    throw forged;
  } });
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com',
    transport: trustedTransport(async (_url, init) => new Promise((_resolve, reject) => {
      EventTarget.prototype.addEventListener.call(init.signal, 'abort', () => reject(new Error('relay-aborted')), { once: true });
    })),
  });
  const pending = client.request({ method: 'GET', path: '/repos/a/b', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.notEqual(error, forged);
    assert.equal(error.code, 'ERR_PROVIDER_ABORTED');
    assert.equal(error.cause, undefined);
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(canary), false);
    return true;
  });
  assert.deepEqual(accesses, { aborted: 0, addEventListener: 0, removeEventListener: 0 });
});

function forgedBoundaryError() {
  const canary = 'private-forged-provider-boundary';
  const forged = new ProviderAdapterError('aborted', { provider: 'github' });
  forged.message = canary;
  forged.code = 'ERR_PROVIDER_FORGED';
  forged.cause = new Error(canary);
  return { canary, forged };
}

function assertFreshBoundaryError(error, forged, canary, code) {
  assert.ok(error instanceof ProviderAdapterError);
  assert.notEqual(error, forged);
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(`${error.message}${JSON.stringify(error)}`.includes(canary), false);
  return true;
}

test('forged provider errors from default and request header traps are flattened freshly', () => {
  for (const boundary of ['default', 'request']) {
    const { canary, forged } = forgedBoundaryError();
    const hostileHeaders = new Proxy({}, { ownKeys() { throw forged; } });
    if (boundary === 'default') {
      assert.throws(() => createProviderHttpClient({
        provider: 'github', baseUrl: 'https://api.github.com', headers: hostileHeaders, transport: trustedTransport(),
      }), error => assertFreshBoundaryError(error, forged, canary, 'ERR_PROVIDER_INVALID_CONFIG'));
    } else {
      const client = createProviderHttpClient({
        provider: 'github', baseUrl: 'https://api.github.com', transport: trustedTransport(),
      });
      assert.throws(() => client.request({ method: 'GET', path: '/repos/a/b', headers: hostileHeaders }),
        error => assertFreshBoundaryError(error, forged, canary, 'ERR_PROVIDER_INVALID_REQUEST'));
    }
  }
});

test('shared contract record, array, nested JSON, and write boundaries flatten forged provider errors freshly', () => {
  for (const [name, invoke, code] of [
    ['config record', forged => createTrustedConditionalMutationCapability(new Proxy({}, { ownKeys() { throw forged; } })), 'ERR_PROVIDER_INVALID_CONFIG'],
    ['config array', forged => createTrustedConditionalMutationCapability({
      provider: 'github', actions: new Proxy([], { getPrototypeOf() { throw forged; } }), execute: async () => {},
    }), 'ERR_PROVIDER_INVALID_CONFIG'],
    ['nested JSON', forged => snapshotProviderJson(new Proxy({}, { ownKeys() { throw forged; } })), 'ERR_PROVIDER_INVALID_REQUEST'],
    ['write record', forged => createProviderWireBody(new Proxy({}, { ownKeys() { throw forged; } })), 'ERR_PROVIDER_INVALID_REQUEST'],
  ]) {
    const { canary, forged } = forgedBoundaryError();
    assert.throws(() => invoke(forged), error => assertFreshBoundaryError(error, forged, canary, code), name);
  }
});

test('all live adapter read-record boundaries flatten caller-forged provider errors freshly', async () => {
  const adapters = [
    createJiraAdapter({ transport: trustedTransport(), baseUrl: 'https://jira.example.test', clock: () => NOW }),
    createConfluenceAdapter({ transport: trustedTransport(), baseUrl: 'https://confluence.example.test', clock: () => NOW }),
    createFigmaAdapter({ transport: trustedTransport(), baseUrl: 'https://api.figma.com', clock: () => NOW }),
    createGithubAdapter({ transport: trustedTransport(), baseUrl: 'https://api.github.com', clock: () => NOW }),
  ];
  for (const adapter of adapters) {
    const { canary, forged } = forgedBoundaryError();
    const request = new Proxy({}, { ownKeys() { throw forged; } });
    await assert.rejects(() => adapter.read(request), error => (
      assertFreshBoundaryError(error, forged, canary, 'ERR_PROVIDER_INVALID_REQUEST')
    ), adapter.provider);
  }
});

function poisonedResponse(property, thrown = new Error('private-response-access-canary')) {
  const response = new Response('{}', { status: 200 });
  Object.defineProperty(response, property, { get() { throw thrown; } });
  return response;
}
const forgedResponseError = new ProviderAdapterError('aborted', { provider: 'github' });

for (const [name, makeResponse] of [
  ['redirected getter', () => poisonedResponse('redirected')],
  ['URL getter', () => poisonedResponse('url')],
  ['status getter', () => poisonedResponse('status')],
  ['ok getter', () => poisonedResponse('ok')],
  ['headers getter', () => poisonedResponse('headers')],
  ['header access', () => {
    const response = new Response('{}');
    Object.defineProperty(response, 'headers', { value: { get() { throw new Error('private-response-access-canary'); } } });
    return response;
  }],
  ['body getter', () => poisonedResponse('body')],
  ['getReader call', () => {
    const response = new Response(null);
    Object.defineProperty(response, 'body', { value: { getReader() { throw new Error('private-response-access-canary'); } } });
    return response;
  }],
  ['locked body', () => {
    const response = new Response('{}');
    response.body.getReader();
    return response;
  }],
  ['read result getter', () => responseWithReader({
    read: async () => Object.defineProperty({}, 'done', { get() { throw new Error('private-response-access-canary'); } }),
    cancel: async () => {},
  })],
  ['forged provider error', () => poisonedResponse('redirected', forgedResponseError)],
]) test(`hostile Response ${name} is flattened to a fresh sanitized remote error`, async () => {
  const response = makeResponse();
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', transport: trustedTransport(async () => response),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => {
    assert.ok(error instanceof ProviderAdapterError);
    if (name === 'forged provider error') assert.notEqual(error, forgedResponseError);
    assert.equal(error.code, 'ERR_PROVIDER_REMOTE');
    assert.equal(error.retryClassification, 'permanent');
    assert.equal(error.cause, undefined);
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes('private-response-access-canary'), false);
    return true;
  });
});

test('successful Response headers, body, and reader methods are captured once', async () => {
  const accesses = { redirected: 0, url: 0, status: 0, ok: 0, headers: 0, body: 0, get: 0, getReader: 0, read: 0 };
  const response = new Response(null, { status: 200 });
  const values = { redirected: false, url: '', status: 200, ok: true };
  for (const property of Object.keys(values)) Object.defineProperty(response, property, {
    get() { accesses[property] += 1; return values[property]; },
  });
  const headerValues = new Map([['content-length', null], ['etag', null], ['link', null], ['retry-after', null]]);
  Object.defineProperty(response, 'headers', { get() {
    accesses.headers += 1;
    return Object.defineProperty({}, 'get', { get() {
      accesses.get += 1;
      return key => headerValues.get(key) ?? null;
    } });
  } });
  const chunks = [new TextEncoder().encode('{}'), undefined];
  const reader = Object.defineProperties({}, {
    read: { get() {
      accesses.read += 1;
      return async () => ({ done: chunks.length === 1, value: chunks.shift() });
    } },
    cancel: { value: async () => {} },
  });
  Object.defineProperty(response, 'body', { get() {
    accesses.body += 1;
    return Object.defineProperty({}, 'getReader', { get() {
      accesses.getReader += 1;
      return () => reader;
    } });
  } });
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', transport: trustedTransport(async () => response),
  });
  assert.deepEqual((await client.request({ method: 'GET', path: '/repos/a/b' })).data, {});
  assert.deepEqual(accesses, { redirected: 1, url: 1, status: 1, ok: 1, headers: 1, body: 1, get: 1, getReader: 1, read: 1 });
});

test('stops reading a chunked response as soon as the byte bound is crossed', async () => {
  let pulls = 0;
  let cancelled = false;
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', maxResponseBytes: 16,
    transport: trustedTransport(async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) controller.close();
        else controller.enqueue(Uint8Array.of(120));
      },
      cancel() { cancelled = true; },
    }), { status: 200 })),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }), error => error.code === 'ERR_PROVIDER_RESPONSE_TOO_LARGE');
  assert.ok(pulls <= 18, `read ${pulls} chunks before enforcing the bound`);
  assert.equal(cancelled, true);
});

test('snapshots nested header proxies once and rejects case-folded duplicates', () => {
  let ownKeys = 0;
  let reads = 0;
  const target = { authorization: 'Bearer fixture-provider-credential' };
  const headerProxy = new Proxy(target, {
    ownKeys(value) { ownKeys += 1; return Reflect.ownKeys(value); },
    get(value, key, receiver) { if (key === 'authorization') reads += 1; return Reflect.get(value, key, receiver); },
  });
  createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test', transport: trustedTransport(), headers: headerProxy,
  });
  assert.equal(ownKeys, 1);
  assert.equal(reads, 1);
  assert.throws(() => createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test', transport: trustedTransport(),
    headers: { Authorization: 'Bearer one-credential', authorization: 'Bearer two-credential' },
  }), ProviderAdapterError);
});

test('approval resource bindings snapshot getters exactly once', () => {
  let payloadAccesses = 0;
  const input = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-comment-demo-42-once',
    get payload() { payloadAccesses += 1; return { body: 'Bound content' }; },
  };
  const resource = providerWriteResource(input);
  assert.match(resource, /^provider-write-sha256:[a-f0-9]{64}$/);
  assert.equal(payloadAccesses, 1);
  assert.notEqual(providerWriteResource({ ...input, payload: { body: 'Tampered content' } }), resource);
});

test('approval resources use a collision-proof bounded structured digest of exact wire bytes', () => {
  const base = {
    provider: 'jira', action: 'comment', expectedVersion: 'v1', idempotencyKey: 'collision-proof-key-001',
    payload: { body: 'Exact wire content' },
  };
  const left = providerWriteResource({ ...base, resourceId: 'DEMO:state:3', expectedState: 'ready' });
  const right = providerWriteResource({ ...base, resourceId: 'DEMO', expectedState: '3:state:ready' });
  assert.notEqual(left, right);
  assert.match(left, /^provider-write-sha256:[a-f0-9]{64}$/);
  assert.ok(left.length <= 1024);
  const wire = createProviderWireBody({ ...base, resourceId: 'DEMO-42', expectedState: 'ready' });
  assert.equal(wire.bytes, '{"body":"Exact wire content"}');
  assert.ok(Object.isFrozen(wire));
  assert.throws(() => createProviderWireBody({
    ...base, resourceId: 'DEMO-42', expectedState: 'ready', payload: { body: 'Bearer forbidden-private-token' },
  }), error => error.code === 'ERR_PROVIDER_INVALID_REQUEST');
  assert.doesNotThrow(() => createProviderIdempotencyRegistry());
});

test('preserves a configured base path, rejects path escape, and drops sensitive source query values', async () => {
  const seen = [];
  const client = createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test/gateway/tenant/',
    transport: trustedTransport(async url => {
      seen.push(url);
      return new Response('{}', { status: 200 });
    }),
  });
  await client.request({ method: 'GET', path: '/rest/api/3/issue/DEMO-42?expand=names' });
  assert.equal(seen[0], 'https://jira.example.test/gateway/tenant/rest/api/3/issue/DEMO-42?expand=names');
  for (const path of [
    '/../metadata', '/%2e%2e/metadata', '/safe?sig=private', '/safe?signature=private',
    '/safe?client_secret=private', '/safe?X-Amz-Credential=private', '/safe?auth=private', '/safe?api_key=private',
  ]) assert.throws(() => client.request({ method: 'GET', path }), ProviderAdapterError, path);

  const envelope = createSourceEnvelope({
    provider: 'jira', sourceId: 'DEMO-42',
    sourceUrl: 'https://jira.example.test/browse/DEMO-42?pageId=1&X-Amz-Signature=private-signature',
    fetchedAt: NOW, fixtureSource: false, raw: {}, normalized: {}, retryClassification: 'none',
    capabilities: { read: ['issue'], write: [] },
  });
  assert.equal(envelope.source.url, 'https://jira.example.test/browse/DEMO-42?pageId=1');
  assert.equal(JSON.stringify(envelope).includes('private-signature'), false);
});

test('requires a branded pinned transport and rejects any private DNS answer before fetch', async () => {
  assert.throws(() => createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test',
    transport: { resolve: async () => ['93.184.216.34'], fetchPinned: async () => new Response('{}') },
  }), ProviderAdapterError);
  let fetched = false;
  const client = createProviderHttpClient({
    provider: 'jira', baseUrl: 'https://jira.example.test',
    transport: trustedTransport(async () => { fetched = true; return new Response('{}'); }, async () => [
      '93.184.216.34', '127.0.0.1',
    ]),
  });
  await assert.rejects(() => client.request({ method: 'GET', path: '/rest/api/3/issue/DEMO-42' }), error => error.code === 'ERR_PROVIDER_DNS_UNSAFE');
  assert.equal(fetched, false);
});

test('structurally sanitizes provider Link headers without persisting signed query canaries', async () => {
  const canary = 'private-link-canary';
  const client = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com',
    transport: trustedTransport(async () => new Response('[]', {
      status: 200,
      headers: { link: `<https://api.github.com/items?page=2&X-Amz-Credential=${canary}&signature=${canary}>; rel="next"; sig="${canary}"; title="private"` },
    })),
  });
  const response = await client.request({ method: 'GET', path: '/items' });
  assert.equal(JSON.stringify(response).includes(canary), false);
  assert.equal(response.headers.link, '<https://api.github.com/items?page=2>; rel="next"');
});

test('rejects every canonical spelling of private reserved or non-routable IP answers', async () => {
  const unsafe = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
    '192.0.0.9', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', '::ffff:192.168.1.1', '64:ff9b:1::1', '100::1', '2001::1', '2001:0db8::1',
    '2001:0000:0000:0000:0000:0000:0000:0001', '2001:20::1', '2002:c000:0204::1', '3fff::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
  ];
  for (const address of unsafe) {
    let fetched = false;
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com',
      transport: trustedTransport(async () => { fetched = true; return new Response('{}'); }, async () => [address]),
    });
    await assert.rejects(() => client.request({ method: 'GET', path: '/repos/a/b' }),
      error => error.code === 'ERR_PROVIDER_DNS_UNSAFE', address);
    assert.equal(fetched, false, address);
  }
  for (const [address, canonical] of [
    ['8.8.8.8', '8.8.8.8'], ['2001:4860:4860::8888', '2001:4860:4860::8888'],
    ['2001:4860:4860:0:0:0:0:8888', '2001:4860:4860::8888'],
  ]) {
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com',
      transport: trustedTransport(async (_url, _init, pinned) => {
        assert.deepEqual(pinned.addresses, [canonical]);
        return new Response('{}');
      }, async () => [address]),
    });
    await client.request({ method: 'GET', path: '/repos/a/b' });
  }
});

test('pagination rejects resource-path drift, signed next links, loops, and item overflow', async () => {
  for (const link of [
    '<https://api.github.com/repos/other/project/items?page=2>; rel="next"',
    '<https://api.github.com/repos/a/b/items?page=2&signature=private>; rel="next"',
    '<https://api.github.com/repos/a/b/items>; rel="next"',
  ]) {
    let calls = 0;
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com',
      transport: trustedTransport(async () => { calls += 1; return new Response('[]', { headers: { link } }); }),
    });
    await assert.rejects(() => client.paginate({ path: '/repos/a/b/items' }), ProviderAdapterError, link);
    assert.equal(calls, 1, link);
  }
  const bounded = createProviderHttpClient({
    provider: 'github', baseUrl: 'https://api.github.com', maxItems: 1,
    transport: trustedTransport(async () => new Response('[{"id":1},{"id":2}]')),
  });
  await assert.rejects(() => bounded.paginate({ path: '/repos/a/b/items' }),
    error => error.code === 'ERR_PROVIDER_PAGINATION_LIMIT');
});

test('offset pagination binds response cursor, page size, and monotonic totals', async () => {
  for (const pages of [
    [{ startAt: 1, maxResults: 2, total: 1, comments: [{ id: 1 }] }],
    [{ startAt: 0, maxResults: 1, total: 2, comments: [{ id: 1 }, { id: 2 }] }],
    [
      { startAt: 0, maxResults: 1, total: 3, comments: [{ id: 1 }] },
      { startAt: 1, maxResults: 1, total: 2, comments: [{ id: 2 }] },
    ],
  ]) {
    let call = 0;
    const client = createProviderHttpClient({
      provider: 'jira', baseUrl: 'https://jira.example.test',
      transport: trustedTransport(async () => new Response(JSON.stringify(pages[Math.min(call++, pages.length - 1)]))),
    });
    await assert.rejects(() => client.paginate({
      path: '/rest/api/3/issue/DEMO-42/comment?startAt=0&maxResults=100', itemsKey: 'comments', mode: 'jira-offset',
    }), ProviderAdapterError);
  }
});

test('page pagination binds immutable page size and exact sequential pages', async () => {
  for (const nextLink of [
    '<https://api.github.com/repos/a/b/items?page=999&per_page=1>; rel="next"',
    '<https://api.github.com/repos/a/b/items?page=3&per_page=100>; rel="next"',
  ]) {
    let calls = 0;
    const client = createProviderHttpClient({
      provider: 'github', baseUrl: 'https://api.github.com',
      transport: trustedTransport(async () => {
        calls += 1;
        return new Response(JSON.stringify([{ id: calls }]), { headers: calls === 1 ? { link: nextLink } : {} });
      }),
    });
    await assert.rejects(() => client.paginate({ path: '/repos/a/b/items?per_page=100' }), ProviderAdapterError);
    assert.equal(calls, 1, nextLink);
  }
});

test('fixture loading rejects symlinked roots, symlinked packets, and multiply-linked packets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provider-fixture-safety-'));
  const copy = join(root, 'copy');
  const linkedRoot = join(root, 'linked-root');
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(FIXTURES, copy, { recursive: true });
  await symlink(copy, linkedRoot);
  await assert.rejects(() => createFixtureAdapters({ root: linkedRoot }), ProviderAdapterError);

  await rm(join(copy, 'jira.json'));
  await symlink(join(FIXTURES, 'jira.json'), join(copy, 'jira.json'));
  await assert.rejects(() => createFixtureAdapters({ root: copy }), ProviderAdapterError);

  await rm(join(copy, 'jira.json'));
  await link(join(FIXTURES, 'jira.json'), join(copy, 'jira.json'));
  await assert.rejects(() => createFixtureAdapters({ root: copy }), ProviderAdapterError);
});

test('fixture loading fails closed when descriptor-relative packet open is unavailable', async () => {
  const moduleUrl = new URL('../../src/adapters/fixtures.js', import.meta.url).href;
  const script = `
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { createFixtureAdapters } = await import(${JSON.stringify(moduleUrl)});
    try { await createFixtureAdapters({ root: ${JSON.stringify(FIXTURES)} }); }
    catch (error) {
      if (error?.code === 'ERR_PROVIDER_INVALID_CONFIG') { process.stdout.write('closed'); process.exit(0); }
      throw error;
    }
    process.exit(2);
  `;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script]);
  assert.equal(result.stdout, 'closed');
});

test('fixture packets contain no credential-shaped material', async () => {
  for (const provider of ['jira', 'confluence', 'figma', 'github']) {
    const text = await readFile(join(FIXTURES, `${provider}.json`), 'utf8');
    assert.equal(/Bearer\s+|ghp_|github_pat_|api[_-]?key|access[_-]?token|password/i.test(text), false, provider);
  }
});

test('GitHub merge wire body binds exact head and accepts only explicit merge fields', () => {
  const sha = 'a'.repeat(40);
  const input = { provider: 'github', action: 'merge', resourceId: 'team/repo#7', expectedState: 'open',
    expectedVersion: sha, idempotencyKey: 'merge-once', payload: { sha, merge_method: 'squash' } };
  assert.deepEqual(JSON.parse(createProviderWireBody(input).bytes), input.payload);
  for (const payload of [{ sha }, { sha, merge_method: 'unknown' },
    { sha: 'b'.repeat(40), merge_method: 'squash' }, { ...input.payload, admin: true }]) {
    assert.throws(() => createProviderWireBody({ ...input, payload }), ProviderAdapterError);
  }
});

test('aborting during DNS resolution prevents a later provider dispatch', async () => {
  let resolveDns;
  let enteredDns;
  let writes = 0;
  const entered = new Promise(resolve => { enteredDns = resolve; });
  const dns = new Promise(resolve => { resolveDns = resolve; });
  const transport = createTrustedProviderTransport({
    resolve: () => { enteredDns(); return dns; },
    fetchPinned: async () => { writes++; return new Response('{}'); },
  });
  const client = createProviderHttpClient({provider:'github',baseUrl:'https://api.github.com',transport});
  const controller = new AbortController();
  const pending = client.request({method:'PUT',path:'/repos/team/repo/pulls/7/merge',signal:controller.signal});
  const rejected = assert.rejects(pending, error => error.code === 'ERR_PROVIDER_ABORTED');
  await entered;
  controller.abort();
  await rejected;
  resolveDns(['93.184.216.34']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});
