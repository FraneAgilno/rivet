import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderIdempotencyRegistry,
  createTrustedConditionalMutationCapability,
  providerWriteResource,
  ProviderAdapterError,
} from '../../src/adapters/contract.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { createJiraAdapter, normalizeJira } from '../../src/adapters/jira.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';

const NOW = '2029-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function approval(write, id = 'jira-write-one') {
  return createApprovalReceipt({
    id, approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'provider.write', resource: providerWriteResource(write), policyId: 'authority.external-write',
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
}

function transport(fetchPinned) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

function governance(approvalRegistry = registry(), idempotencyRegistry = createProviderIdempotencyRegistry()) {
  return {
    approvalRegistry, idempotencyRegistry, expectedApproverId: 'human-owner', subjectId: 'worker-one', now: () => NOW_MS,
  };
}

function conditional(execute = async ({ operation }) => operation.run()) {
  return createTrustedConditionalMutationCapability({ provider: 'jira', actions: ['comment', 'status'], execute });
}

function registry() {
  return createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
}

test('reads Jira epic/issue links, status, acceptance criteria, and comments into a source envelope', async () => {
  const calls = [];
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      if (new URL(url).pathname.endsWith('/comment')) return new Response(JSON.stringify({
        startAt: 0, maxResults: 100, total: 1,
        comments: [{ id: '100', body: { type: 'doc', content: [] }, author: { displayName: 'Reviewer' } }],
      }), { status: 200 });
      return new Response(JSON.stringify({
        id: '42', key: 'DEMO-42',
        fields: {
          summary: 'Conference agenda', issuetype: { name: 'Story' }, parent: { key: 'DEMO-1' },
          status: { id: '3', name: 'In Progress' }, updated: NOW,
          description: 'AC1: filter by track\nAC2: bookmark',
          issuelinks: [{ id: '10', outwardIssue: { key: 'DEMO-43' }, type: { name: 'Blocks' } }],
          comment: { comments: [{ id: '100', body: { type: 'doc', content: [] }, author: { displayName: 'Reviewer' } }] },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const result = await adapter.read({ kind: 'issue', id: 'DEMO-42' });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/DEMO-42/);
  assert.equal(result.normalized.id, 'DEMO-42');
  assert.equal(result.normalized.epicId, 'DEMO-1');
  assert.deepEqual(result.normalized.status, { id: '3', name: 'In Progress' });
  assert.deepEqual(result.normalized.acceptanceCriteria, ['AC1: filter by track', 'AC2: bookmark']);
  assert.equal(result.normalized.revision, NOW);
  assert.equal(result.normalized.links[0].issueId, 'DEMO-43');
  assert.equal(result.normalized.comments[0].id, '100');
});

test('writes a proposed Jira comment only after state-bound single-use human approval', async () => {
  const calls = [];
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-comment-demo-42-001', payload: { body: 'Ready for review' },
  };
  const approvals = registry();
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      return new Response(JSON.stringify({ id: '101' }), { status: 201 });
    }),
  });
  const result = await adapter.write({ ...write, approval: approval(write) });
  assert.equal(result.status, 'written');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['idempotency-key'], write.idempotencyKey);
  assert.equal(calls[1].init.headers['if-match'], undefined);
  assert.equal(calls[1].init.body, '{"body":"Ready for review"}');
  assert.match(calls[1].url, /\/rest\/api\/3\/issue\/DEMO-42\/comment$/);
});

test('fails before mutation on stale state, invalid approval, or reused idempotency key', async () => {
  const calls = [];
  const approvals = registry();
  const base = {
    provider: 'jira', action: 'status', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-status-demo-42-001', payload: { transitionId: '5' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: calls.length === 1 ? '2' : '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      return new Response(null, { status: 204 });
    }),
  });
  await assert.rejects(() => adapter.write({ ...base, approval: approval(base) }), error => error.code === 'ERR_PROVIDER_STATE_CONFLICT');
  assert.equal(calls.length, 1);

  await assert.rejects(() => adapter.write({
    ...base, approval: approval({ ...base, expectedState: 'wrong' }, 'jira-write-two'),
  }), error => error.code === 'ERR_PROVIDER_APPROVAL_REQUIRED');
  assert.equal(calls.length, 2);

  const accepted = { ...base, approval: approval(base, 'jira-write-three') };
  await adapter.write(accepted);
  assert.equal(calls.length, 4);
  await assert.rejects(() => adapter.write({ ...accepted, approval: approval(base, 'jira-write-four') }), error => error.code === 'ERR_PROVIDER_IDEMPOTENCY_REUSED');
});

test('keeps approval claimed on ambiguous transport failure and sanitizes the public error', async () => {
  let mutate = false;
  const approvals = registry();
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-comment-demo-42-ambiguous', payload: { body: 'Review' },
  };
  const receipt = approval(write, 'jira-write-ambiguous');
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      mutate = true;
      throw new Error('Bearer private-provider-secret');
    }),
  });
  await assert.rejects(() => adapter.write({ ...write, approval: receipt }), error => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.code, 'ERR_PROVIDER_MUTATION_AMBIGUOUS');
    assert.equal(JSON.stringify(error).includes('private-provider-secret'), false);
    return true;
  });
  assert.equal(mutate, true);
  await assert.rejects(() => adapter.write({ ...write, approval: receipt }), error => error.code === 'ERR_PROVIDER_IDEMPOTENCY_REUSED');
});

test('converts approval-policy boundary failures to typed provider errors', async () => {
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-comment-demo-42-policy', payload: { body: 'Review' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    governance: { ...governance(), approvalRegistry: Object.freeze({}) }, conditionalMutation: conditional(),
    transport: transport(async () => new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } })),
  });
  await assert.rejects(() => adapter.write({ ...write, approval: approval(write, 'jira-write-policy') }), error => error instanceof ProviderAdapterError && error.code === 'ERR_PROVIDER_APPROVAL_REQUIRED');
  await assert.rejects(() => adapter.write({
    ...write, idempotencyKey: 'jira-comment-demo-42-untrusted', approval: approval({ ...write, idempotencyKey: 'jira-comment-demo-42-untrusted' }, 'jira-write-untrusted'),
    approvalRegistry: registry(), expectedApproverId: 'attacker',
  }), error => error.code === 'ERR_PROVIDER_INVALID_REQUEST');
});

test('rolls back approval and idempotency claims after a definite remote rejection', async () => {
  let mutationAttempts = 0;
  const approvals = registry();
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3',
    expectedVersion: '"issue-v3"', idempotencyKey: 'jira-comment-demo-42-rollback', payload: { body: 'Review' },
  };
  const receipt = approval(write, 'jira-write-rollback');
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      mutationAttempts += 1;
      if (mutationAttempts === 1) return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
      return new Response(JSON.stringify({ id: '101' }), { status: 201 });
    }),
  });
  const request = { ...write, approval: receipt };
  await assert.rejects(() => adapter.write(request), error => error.code === 'ERR_PROVIDER_REMOTE');
  assert.equal((await adapter.write(request)).status, 'written');
  assert.equal(mutationAttempts, 2);
});

test('atomically reserves idempotency before preflight and binds approval to exact payload content', async () => {
  const approvals = registry();
  let preflights = 0;
  let mutations = 0;
  let releasePreflight;
  const barrier = new Promise(resolve => { releasePreflight = resolve; });
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: '"issue-v3"',
    idempotencyKey: 'jira-comment-demo-42-concurrent', payload: { body: 'Exact approved content' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') {
        preflights += 1;
        await barrier;
        return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      }
      mutations += 1;
      return new Response(JSON.stringify({ id: '101' }), { status: 201 });
    }),
  });
  const request = { ...write, approval: approval(write, 'jira-write-concurrent') };
  const first = adapter.write(request);
  const second = adapter.write(request);
  await assert.rejects(() => second, error => error.code === 'ERR_PROVIDER_IDEMPOTENCY_REUSED');
  releasePreflight();
  assert.equal((await first).status, 'written');
  assert.equal(preflights, 1);
  assert.equal(mutations, 1);

  const tampered = { ...write, idempotencyKey: 'jira-comment-demo-42-tampered', payload: { body: 'Tampered content' } };
  await assert.rejects(() => adapter.write({
    ...tampered,
    approval: approval({ ...tampered, payload: { body: 'Different approved content' } }, 'jira-write-tampered'),
  }), error => error.code === 'ERR_PROVIDER_APPROVAL_REQUIRED');
  assert.equal(mutations, 1);
});

test('rolls back a preflight failure but keeps a post-dispatch 5xx idempotency reservation ambiguous', async () => {
  const approvals = registry();
  let preflightAttempts = 0;
  let mutationAttempts = 0;
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: '"issue-v3"',
    idempotencyKey: 'jira-comment-demo-42-preflight-retry', payload: { body: 'Review' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(approvals), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') {
        preflightAttempts += 1;
        if (preflightAttempts === 1) return new Response('temporarily unavailable', { status: 503 });
        return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: '"issue-v3"' } });
      }
      mutationAttempts += 1;
      return new Response('temporarily unavailable', { status: 503 });
    }),
  });
  const request = { ...write, approval: approval(write, 'jira-write-preflight-retry') };
  await assert.rejects(() => adapter.write(request), error => error.code === 'ERR_PROVIDER_REMOTE');
  await assert.rejects(() => adapter.write(request), error => error.code === 'ERR_PROVIDER_MUTATION_AMBIGUOUS');
  assert.equal(preflightAttempts, 2);
  assert.equal(mutationAttempts, 1);
  await assert.rejects(() => adapter.write(request), error => error.code === 'ERR_PROVIDER_IDEMPOTENCY_REUSED');
  assert.equal(preflightAttempts, 2);
});

test('shares atomic idempotency across adapter instances and fails closed on conditional boundary drift', async () => {
  const approvals = registry();
  const sharedKeys = createProviderIdempotencyRegistry();
  let preflights = 0;
  let mutations = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: 'v3',
    idempotencyKey: 'jira-cross-instance-key-001', payload: { body: 'Exact bytes' },
  };
  const config = {
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    governance: governance(approvals, sharedKeys), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') {
        preflights += 1;
        await barrier;
        return new Response(JSON.stringify({ id: '42', key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: 'v3' } });
      }
      mutations += 1;
      return new Response(JSON.stringify({ id: '101' }), { status: 201 });
    }),
  };
  const firstAdapter = createJiraAdapter(config);
  const secondAdapter = createJiraAdapter(config);
  const request = { ...write, approval: approval(write, 'jira-cross-instance-approval') };
  const first = firstAdapter.write(request);
  await assert.rejects(() => secondAdapter.write(request), error => error.code === 'ERR_PROVIDER_IDEMPOTENCY_REUSED');
  release();
  await first;
  assert.equal(preflights, 1);
  assert.equal(mutations, 1);

  let dispatched = false;
  const driftWrite = { ...write, idempotencyKey: 'jira-boundary-drift-key-001' };
  const driftAdapter = createJiraAdapter({
    ...config, governance: governance(approvals, sharedKeys),
    conditionalMutation: conditional(async () => { throw new ProviderAdapterError('state-conflict', { provider: 'jira' }); }),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ id: '42', key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: 'v3' } });
      dispatched = true;
      return new Response('{}', { status: 201 });
    }),
  });
  await assert.rejects(() => driftAdapter.write({ ...driftWrite, approval: approval(driftWrite, 'jira-boundary-drift-approval') }), error => error.code === 'ERR_PROVIDER_STATE_CONFLICT');
  assert.equal(dispatched, false);
});

test('rejects malformed and mismatched Jira responses with a sanitized permanent remote error', async () => {
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ key: 'OTHER-1', fields: { status: null } }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'issue', id: 'DEMO-42' }), error => error instanceof ProviderAdapterError
    && error.code === 'ERR_PROVIDER_REMOTE' && error.retryClassification === 'permanent');
});

for (const scenario of [
  ['zero-dispatch', async () => ({ id: 'fabricated' }), false],
  ['multiple-dispatch', async ({ operation }) => { const first = operation.run(); try { await operation.run(); } catch {} return first; }, true],
  ['swallowed-rejection', async ({ operation }) => { try { await operation.run(); } catch {} return { id: 'fabricated' }; }, true],
  ['unawaited-dispatch', async ({ operation }) => { operation.run(); return { id: 'fabricated' }; }, true],
  ['detached-then', async ({ operation }) => { operation.run().then(() => {}); return { id: 'fabricated' }; }, true],
  ['deferred-dispatch', async ({ operation }) => { setTimeout(() => operation.run().catch(() => {}), 0); return { id: 'fabricated' }; }, false],
]) test(`conditional mutation rejects ${scenario[0]} executor behavior`, async () => {
  const [name, execute, dispatchExpected] = scenario;
  let mutations = 0;
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: 'v3',
    idempotencyKey: `jira-${name}-executor-key`, payload: { body: 'Exact comment' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(), conditionalMutation: conditional(execute),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: 'v3' } });
      mutations += 1;
      if (name === 'swallowed-rejection') return new Response('uncertain', { status: 503 });
      return new Response(JSON.stringify({ id: '101' }), { status: 201 });
    }),
  });
  await assert.rejects(() => adapter.write({ ...write, approval: approval(write, `jira-${name}-approval`) }), error => error.code === 'ERR_PROVIDER_MUTATION_AMBIGUOUS');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(mutations > 0, dispatchExpected);
});

test('conditional mutation rejects executor fabrication after a real dispatch', async () => {
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: 'v3',
    idempotencyKey: 'jira-fabricated-return-key', payload: { body: 'Exact comment' },
  };
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(),
    conditionalMutation: conditional(async ({ operation }) => { await operation.run(); return { id: 'fabricated' }; }),
    transport: transport(async (_url, init) => init.method === 'GET'
      ? new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: 'v3' } })
      : new Response(JSON.stringify({ id: '101' }), { status: 201 })),
  });
  await assert.rejects(() => adapter.write({ ...write, approval: approval(write, 'jira-fabricated-return-approval') }),
    error => error.code === 'ERR_PROVIDER_MUTATION_AMBIGUOUS');
});

test('Jira epic identity and paginated comments are validated and merged exactly', async () => {
  let calls = 0;
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async url => {
      calls += 1;
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/comment')) return new Response(JSON.stringify({
        id: '42', key: 'DEMO-42', fields: { summary: 'Epic', issuetype: { name: 'Epic' }, status: { id: '3', name: 'Open' } },
      }), { status: 200 });
      const start = parsed.searchParams.get('startAt');
      const comments = start === '0'
        ? [{ id: '100', body: 'one', author: { accountId: 'a' } }, { id: '101', body: 'two', author: { accountId: 'b' } }]
        : [{ id: '102', body: 'three', author: { accountId: 'c' } }];
      return new Response(JSON.stringify({ startAt: Number(start), maxResults: 2, total: 3, comments }), { status: 200 });
    }),
  });
  const result = await adapter.read({ kind: 'epic', id: 'DEMO-42' });
  assert.equal(calls, 3);
  assert.deepEqual(result.normalized.comments.map(comment => comment.id), ['100', '101', '102']);
});

test('Jira comment pagination rejects duplicate comment identities across pages', async () => {
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async url => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/comment')) return new Response(JSON.stringify({
        id: '42', key: 'DEMO-42', fields: {
          summary: 'Story', issuetype: { name: 'Story' }, status: { id: '3', name: 'Open' },
        },
      }));
      const startAt = Number(parsed.searchParams.get('startAt'));
      return new Response(JSON.stringify({
        startAt, maxResults: 1, total: 2,
        comments: [{ id: '100', body: `page-${startAt}`, author: { accountId: 'reviewer' } }],
      }));
    }),
  });
  await assert.rejects(() => adapter.read({ kind: 'issue', id: 'DEMO-42' }), error => error.code === 'ERR_PROVIDER_REMOTE');
});

test('Jira rejects a non-Epic epic response and an empty canonical write identifier', async () => {
  const readAdapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      id: '42', key: 'DEMO-42', fields: { summary: 'Story', issuetype: { name: 'Story' }, status: { id: '3' } },
    }), { status: 200 })),
  });
  await assert.rejects(() => readAdapter.read({ kind: 'epic', id: 'DEMO-42' }), error => error.code === 'ERR_PROVIDER_REMOTE');
  const write = {
    provider: 'jira', action: 'comment', resourceId: 'DEMO-42', expectedState: '3', expectedVersion: 'v3',
    idempotencyKey: 'jira-empty-write-id-key', payload: { body: 'Comment' },
  };
  const writeAdapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW, governance: governance(), conditionalMutation: conditional(),
    transport: transport(async (_url, init) => init.method === 'GET'
      ? new Response(JSON.stringify({ key: 'DEMO-42', fields: { status: { id: '3' } } }), { status: 200, headers: { etag: 'v3' } })
      : new Response(JSON.stringify({ id: '' }), { status: 201 })),
  });
  await assert.rejects(() => writeAdapter.write({ ...write, approval: approval(write, 'jira-empty-write-id-approval') }), error => error.code === 'ERR_PROVIDER_MUTATION_AMBIGUOUS');
});

test('Jira rejects noncanonical linked issue identities before normalization', async () => {
  const adapter = createJiraAdapter({
    baseUrl: 'https://jira.example.test', clock: () => NOW,
    transport: transport(async url => new URL(url).pathname.endsWith('/comment')
      ? new Response(JSON.stringify({ startAt: 0, maxResults: 100, total: 0, comments: [] }))
      : new Response(JSON.stringify({
        id: '42', key: 'DEMO-42', fields: {
          summary: 'Story', issuetype: { name: 'Story' }, status: { id: '3', name: 'Open' },
          issuelinks: [{ id: '10', type: { name: 'Blocks' }, outwardIssue: { key: '../OTHER' } }],
        },
      }))),
  });
  await assert.rejects(() => adapter.read({ kind: 'issue', id: 'DEMO-42' }), error => error.code === 'ERR_PROVIDER_REMOTE');
});

test('exported Jira normalizer snapshots nested hostile data once and bounds recursion', () => {
  let accesses = 0;
  const normalized = normalizeJira({
    key: 'DEMO-42',
    get fields() { accesses += 1; return { summary: 'Conference', description: 'AC1: works' }; },
  });
  assert.equal(accesses, 1);
  assert.ok(Object.isFrozen(normalized));
  let nested = { text: 'end' };
  for (let index = 0; index < 30; index += 1) nested = { content: [nested] };
  assert.throws(() => normalizeJira({ key: 'DEMO-42', fields: { description: nested } }), ProviderAdapterError);
});
