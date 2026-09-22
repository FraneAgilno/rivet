import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderAdapterError } from '../../src/adapters/contract.js';
import { createFigmaAdapter, normalizeFigma } from '../../src/adapters/figma.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';

const NOW = '2029-01-01T00:00:00.000Z';

function transport(fetchPinned) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

test('reads Figma file metadata, nodes, components, styles, variables, and rendered references', async () => {
  const calls = [];
  const adapter = createFigmaAdapter({
    baseUrl: 'https://api.figma.com', clock: () => NOW,
    transport: transport(async url => {
      calls.push(url);
      if (url.includes('/images/')) return new Response(JSON.stringify({
        images: { '1:2': 'https://images.example.test/1-2.png?X-Amz-Credential=private-signature' },
      }), { status: 200 });
      if (url.includes('/variables/local')) return new Response(JSON.stringify({ meta: {
        variables: { 'VariableID:1': { name: 'Spacing/Small', valuesByMode: { mode: 8 } } },
      } }), { status: 200 });
      return new Response(JSON.stringify({
        name: 'Conference planner', version: '42', lastModified: NOW,
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{ id: '1:2', name: 'Agenda', type: 'FRAME' }] },
        components: { '1:3': { key: 'component-key', name: 'Button' } }, styles: { '1:4': { key: 'style-key', name: 'Heading' } },
      }), { status: 200 });
    }),
  });
  const result = await adapter.read({ kind: 'file', id: 'conference-file', nodeIds: ['1:2'], render: true, includeVariables: true });
  assert.equal(result.normalized.metadata.version, '42');
  assert.equal(result.normalized.nodes[0].id, '1:2');
  assert.equal(result.normalized.components['1:3'].name, 'Button');
  assert.equal(result.normalized.styles['1:4'].name, 'Heading');
  assert.equal(result.normalized.variables['VariableID:1'].name, 'Spacing/Small');
  assert.deepEqual(result.normalized.renderedReferences, [{ nodeId: '1:2', url: 'https://images.example.test/1-2.png' }]);
  assert.equal(JSON.stringify(result).includes('private-signature'), false);
  assert.equal(calls.length, 3);
});

test('Figma adapter is read-only and bounds node identifiers before fetch', async () => {
  let called = false;
  const adapter = createFigmaAdapter({
    baseUrl: 'https://api.figma.com', transport: transport(async () => { called = true; return new Response('{}'); }), clock: () => NOW,
  });
  await assert.rejects(() => adapter.write({}), error => error instanceof ProviderAdapterError && error.code === 'ERR_PROVIDER_READ_ONLY');
  await assert.rejects(() => adapter.read({ kind: 'nodes', id: 'conference-file', nodeIds: Array(101).fill('1:2') }), ProviderAdapterError);
  assert.equal(called, false);
});

test('exported Figma normalizer snapshots recursive nodes once and rejects oversized depth', () => {
  let accesses = 0;
  const result = normalizeFigma({
    name: 'Conference',
    get document() { accesses += 1; return { id: '0:0', type: 'DOCUMENT', children: [{ id: '1:2', type: 'FRAME' }] }; },
  });
  assert.equal(accesses, 1);
  assert.ok(Object.isFrozen(result));
  let node = { id: '1:2', type: 'FRAME' };
  for (let index = 0; index < 30; index += 1) node = { id: `1:${index + 3}`, type: 'FRAME', children: [node] };
  assert.throws(() => normalizeFigma({ name: 'Too deep', document: node }), ProviderAdapterError);
});

test('rejects malformed Figma provider snapshots without leaking raw TypeErrors', async () => {
  const adapter = createFigmaAdapter({
    baseUrl: 'https://api.figma.com', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ name: 42, version: null, document: [] }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'file', id: 'conference-file' }), error => error instanceof ProviderAdapterError
    && error.code === 'ERR_PROVIDER_REMOTE' && error.retryClassification === 'permanent');
});

test('Figma node reads require the exact requested node identity set', async () => {
  const adapter = createFigmaAdapter({
    baseUrl: 'https://api.figma.com', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      name: 'Nodes', nodes: { '1:2': { document: { id: '1:2', name: 'One', type: 'FRAME' } }, '9:9': { document: { id: '9:9', name: 'Extra', type: 'FRAME' } } },
    }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'nodes', id: 'conference-file', nodeIds: ['1:2', '1:3'] }), error => error.code === 'ERR_PROVIDER_REMOTE');
});

for (const [name, request, responseFor] of [
  ['component map', { kind: 'file', id: 'conference-file' }, () => ({
    name: 'File', version: '1', document: { id: '0:0', name: 'Document', type: 'DOCUMENT' }, components: null, styles: {},
  })],
  ['rendered identity', { kind: 'file', id: 'conference-file', nodeIds: ['1:2'], render: true }, url => url.includes('/images/')
    ? { images: { '9:9': 'https://images.example.test/9.png' } }
    : { name: 'File', version: '1', document: { id: '0:0', name: 'Document', type: 'DOCUMENT' }, components: {}, styles: {} }],
  ['variable entry', { kind: 'file', id: 'conference-file', includeVariables: true }, url => url.includes('/variables/local')
    ? { meta: { variables: { bad: null } } }
    : { name: 'File', version: '1', document: { id: '0:0', name: 'Document', type: 'DOCUMENT' }, components: {}, styles: {} }],
]) test(`rejects malformed Figma ${name} response as a permanent remote error`, async () => {
  const adapter = createFigmaAdapter({
    baseUrl: 'https://api.figma.com', clock: () => NOW,
    transport: transport(async url => new Response(JSON.stringify(responseFor(url)), { status: 200 })),
  });
  await assert.rejects(() => adapter.read(request), error => error.code === 'ERR_PROVIDER_REMOTE'
    && error.retryClassification === 'permanent');
});
