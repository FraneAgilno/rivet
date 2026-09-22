import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createNodeProviderTransport } from '../../src/adapters/node-transport.js';
import { createProviderHttpClient } from '../../src/adapters/http.js';

test('pins HTTPS lookup while preserving TLS hostname and streams the response', async () => {
  let seen;
  const transport = createNodeProviderTransport({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url, options, callback) => {
      seen = { url, options };
      const req = new EventEmitter();
      req.end = body => {
        assert.equal(body, 'query-body');
        const incoming = Readable.from([Buffer.from('{"ok":true}')]);
        incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' };
        callback(incoming);
      };
      return req;
    },
  });
  const addresses = await transport.resolve('api.linear.app');
  const response = await transport.fetchPinned('https://api.linear.app/graphql', { method: 'POST', headers: {}, body: 'query-body', signal: new AbortController().signal }, { hostname: 'api.linear.app', addresses });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen.options.servername, 'api.linear.app');
  assert.equal(seen.options.rejectUnauthorized, true);
  assert.equal(seen.options.agent, false);
  seen.options.lookup('api.linear.app', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, addresses[0]); assert.equal(family, 4);
  });
  seen.options.lookup('api.linear.app', { all: true }, (error, result) => {
    assert.equal(error, null); assert.deepEqual(result, [{ address: addresses[0], family: 4 }]);
  });
});

test('does not dispatch private DNS destinations or follow redirects', async () => {
  let requests = 0;
  const transport = createNodeProviderTransport({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: () => { requests += 1; throw new Error('Must not dispatch'); },
  });
  const client = createProviderHttpClient({ provider: 'linear', baseUrl: 'https://api.linear.app', transport });
  await assert.rejects(() => client.request({ method: 'GET', path: '/graphql' }), error => error.code === 'ERR_PROVIDER_DNS_UNSAFE');
  assert.equal(requests, 0);
  const redirecting = createNodeProviderTransport({ request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => { const stream = Readable.from([]); stream.statusCode = 302; callback(stream); };
    return req;
  } });
  await assert.rejects(() => redirecting.fetchPinned('https://api.linear.app/graphql', { method: 'GET', headers: {} }, { hostname: 'api.linear.app', addresses: ['93.184.216.34'] }), /redirect/);
});
