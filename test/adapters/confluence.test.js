import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderIdempotencyRegistry, providerWriteResource, ProviderAdapterError } from '../../src/adapters/contract.js';
import { createConfluenceAdapter, normalizeConfluence } from '../../src/adapters/confluence.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';

const NOW = '2029-01-01T00:00:00.000Z';

function transport(fetchPinned) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

test('reads Confluence content, version, parents, and links', async () => {
  const adapter = createConfluenceAdapter({
    baseUrl: 'https://confluence.example.test', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      id: '12345', title: 'Conference requirements', status: 'current',
      body: { storage: { value: '<p>Requirements</p>', representation: 'storage' } },
      version: { number: 7 }, ancestors: [{ id: '100' }],
      _links: {
        webui: '/spaces/DEMO/pages/12345?client_secret=private-link-canary',
        self: 'https://confluence.example.test/wiki/api/v2/pages/12345?X-Amz-Security-Token=private-link-canary',
      },
    }), { status: 200 })),
  });
  const result = await adapter.read({ kind: 'page', id: '12345' });
  assert.deepEqual(result.normalized.version, { number: 7 });
  assert.deepEqual(result.normalized.parentIds, ['100']);
  assert.equal(result.normalized.links.webui, '/spaces/DEMO/pages/12345');
  assert.equal(JSON.stringify(result).includes('private-link-canary'), false);
  assert.equal(result.normalized.content.value, '<p>Requirements</p>');
});

test('updates a Confluence page with approval bound to expected version and idempotency key', async () => {
  const calls = [];
  const write = {
    provider: 'confluence', action: 'page-update', resourceId: '12345', expectedState: 'current', expectedVersion: '7',
    idempotencyKey: 'confluence-page-12345-008',
    payload: { title: 'Conference requirements', body: '<p>Approved update</p>', version: 8 },
  };
  const receipt = createApprovalReceipt({
    id: 'confluence-write-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'provider.write', resource: providerWriteResource(write), policyId: 'authority.external-write',
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
  const adapter = createConfluenceAdapter({
    baseUrl: 'https://confluence.example.test', clock: () => NOW,
    governance: {
      approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] }),
      idempotencyRegistry: createProviderIdempotencyRegistry(),
      expectedApproverId: 'human-owner', subjectId: 'worker-one', now: () => Date.parse(NOW),
    },
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') return new Response(JSON.stringify({ id: '12345', status: 'current', version: { number: 7 } }), { status: 200, headers: { etag: '"page-v7"' } });
      return new Response(JSON.stringify({ id: '12345', status: 'current', version: { number: 8 } }), { status: 200 });
    }),
  });
  const result = await adapter.write({ ...write, approval: receipt });
  assert.equal(result.status, 'written');
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers['if-match'], '"page-v7"');
  assert.equal(calls[1].init.headers['idempotency-key'], write.idempotencyKey);
  assert.equal(JSON.parse(calls[1].init.body).version.number, 8);
});

test('rejects malformed or mismatched Confluence pages as sanitized remote failures', async () => {
  const adapter = createConfluenceAdapter({
    baseUrl: 'https://confluence.example.test', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ id: '99999', title: 42, status: 'current', version: { number: '7' } }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'page', id: '12345' }), error => error instanceof ProviderAdapterError
    && error.code === 'ERR_PROVIDER_REMOTE' && error.retryClassification === 'permanent');
});

for (const [name, ancestors] of [
  ['empty parent', [{ id: '' }]],
  ['noncanonical parent', [{ id: '../100' }]],
  ['overlong parent', [{ id: '1'.repeat(65) }]],
  ['duplicate parent', [{ id: '100' }, { id: '100' }]],
]) test(`rejects ${name} identities in the Confluence parent chain`, async () => {
  assert.throws(() => normalizeConfluence({ ancestors }), error => error.code === 'ERR_PROVIDER_REMOTE');
  const adapter = createConfluenceAdapter({
    baseUrl: 'https://confluence.example.test', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      id: '12345', title: 'Conference', status: 'current', body: {}, version: { number: 7 }, ancestors,
    }))),
  });
  await assert.rejects(() => adapter.read({ kind: 'page', id: '12345' }), error => error.code === 'ERR_PROVIDER_REMOTE');
});

test('sanitizes failures from an injected clock at the provider boundary', async () => {
  const canary = 'private-clock-canary';
  const adapter = createConfluenceAdapter({
    baseUrl: 'https://confluence.example.test', clock: () => { throw new Error(canary); },
    transport: transport(async () => new Response(JSON.stringify({
      id: '12345', title: 'Conference', status: 'current', body: {}, version: { number: 7 },
    }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'page', id: '12345' }), error => {
    assert.equal(error.code, 'ERR_PROVIDER_INVALID_CONFIG');
    assert.equal(error.message.includes(canary), false);
    return true;
  });
});

test('exported Confluence normalizer snapshots hostile nested data and returns immutable bounded output', () => {
  let accesses = 0;
  const result = normalizeConfluence({
    id: '12345',
    get body() { accesses += 1; return { storage: { value: 'Conference', representation: 'storage' } }; },
    version: { number: 7 },
  });
  assert.equal(accesses, 1);
  assert.ok(Object.isFrozen(result));
  let nested = 'end';
  for (let index = 0; index < 30; index += 1) nested = { child: nested };
  assert.throws(() => normalizeConfluence({ id: '12345', body: nested }));
});
