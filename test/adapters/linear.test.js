import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderAdapterError } from '../../src/adapters/contract.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { createLinearAdapter, normalizeLinear } from '../../src/adapters/linear.js';

const NOW = '2029-01-01T00:00:00.000Z';

function transport(fetchPinned) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

function issue(overrides = {}) {
  return {
    id: '4fdb9cf8-8c99-4afb-8cf0-aad2184f7434',
    identifier: 'DEMO-123',
    title: 'Smart agenda builder',
    description: 'Add deterministic recommendations.\nAC1: export the accepted agenda as .ics',
    updatedAt: '2029-01-01T00:00:00.000Z',
    url: 'https://linear.app/example/issue/DEMO-123/smart-agenda-builder',
    state: { id: 'state-1', name: 'In Progress' },
    team: { id: 'team-1', key: 'INT' },
    labels: { nodes: [{ id: 'label-1', name: 'Feature' }], pageInfo: { hasNextPage: false, endCursor: null } },
    relations: {
      nodes: [{ id: 'relation-1', type: 'blocks', relatedIssue: { identifier: 'DEMO-124' } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    comments: {
      nodes: [{ id: 'comment-1', body: 'Keep calendar output deterministic.', user: { id: 'user-1', name: 'Reviewer' } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  };
}

test('reads and normalizes one Linear issue into a source envelope', async () => {
  const calls = [];
  const adapter = createLinearAdapter({
    baseUrl: 'https://api.linear.app',
    clock: () => NOW,
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { issue: issue() } }), { status: 200 });
    }),
  });

  const result = await adapter.read({ kind: 'issue', id: 'DEMO-123' });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/graphql');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.variables.identifier, 'DEMO-123');
  assert.match(body.query, /issue\(id: \$identifier\)/);
  assert.doesNotMatch(body.query, /issues\(filter/);
  assert.equal(result.normalized.id, 'DEMO-123');
  assert.equal(result.normalized.status.name, 'In Progress');
  assert.deepEqual(result.normalized.acceptanceCriteria, ['AC1: export the accepted agenda as .ics']);
  assert.deepEqual(result.normalized.labels, [{ id: 'label-1', name: 'Feature' }]);
  assert.equal(result.normalized.links[0].issueId, 'DEMO-124');
  assert.equal(result.normalized.comments[0].author, 'Reviewer');
  assert.equal(result.normalized.revision, NOW);
  assert.equal(Object.isFrozen(result), true);
});

test('Linear adapter is read-only', async () => {
  const adapter = createLinearAdapter({
    baseUrl: 'https://api.linear.app',
    clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ data: { issue: issue() } }), { status: 200 })),
  });

  await assert.rejects(
    () => adapter.write({}),
    error => error instanceof ProviderAdapterError && error.code === 'ERR_PROVIDER_READ_ONLY',
  );
});

test('rejects identity mismatch, missing issue, nested pagination, and GraphQL errors', async t => {
  for (const [name, payload] of [
    ['identity mismatch', { data: { issue: issue({ identifier: 'DEMO-124' }) } }],
    ['missing issue', { data: { issue: null } }],
    ['nested pagination', { data: { issue: issue({ comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'private-cursor' } } }) } }],
    ['GraphQL errors', { errors: [{ message: 'Bearer private-provider-secret' }], data: null }],
  ]) {
    await t.test(name, async () => {
      const adapter = createLinearAdapter({
        baseUrl: 'https://api.linear.app',
        clock: () => NOW,
        transport: transport(async () => new Response(JSON.stringify(payload), { status: 200 })),
      });
      await assert.rejects(() => adapter.read({ kind: 'issue', id: 'DEMO-123' }), error => {
        assert.equal(error instanceof ProviderAdapterError, true);
        assert.equal(JSON.stringify(error).includes('private-provider-secret'), false);
        return true;
      });
    });
  }
});

test('exported Linear normalizer snapshots hostile input and rejects malformed nested data', () => {
  let reads = 0;
  const normalized = normalizeLinear({
    ...issue({ identifier: undefined }),
    get identifier() { reads += 1; return 'DEMO-123'; },
  });
  assert.equal(reads, 1);
  assert.equal(normalized.id, 'DEMO-123');
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(() => normalizeLinear(issue({ labels: { nodes: [null], pageInfo: { hasNextPage: false } } })), ProviderAdapterError);
});


test('extracts explicit Markdown acceptance criteria without inventing requirements', () => {
  const result = normalizeLinear(issue({ description: '## Outcome\nFind sessions.\n\n## Acceptance criteria\n- [ ] Search ignores case.\n- Filters compose.\n  Include reset behavior.\n\n## Constraints\n- No dependencies.' }));
  assert.deepEqual(result.acceptanceCriteria, ['Search ignores case.', 'Filters compose. Include reset behavior.']);
  assert.deepEqual(normalizeLinear(issue({ description: '## Outcome\n- Search sessions.' })).acceptanceCriteria, []);
});
