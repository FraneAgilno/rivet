import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderIdempotencyRegistry,
  createTrustedConditionalMutationCapability,
  providerWriteResource,
  ProviderAdapterError,
} from '../../src/adapters/contract.js';
import { createGithubAdapter } from '../../src/adapters/github.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';

const NOW = '2029-01-01T00:00:00.000Z';

function transport(fetchPinned) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

function conditional(execute = async ({ operation }) => operation.run()) {
  return createTrustedConditionalMutationCapability({ provider: 'github', actions: ['comment'], execute });
}

test('reads GitHub repository, branch, PR, check, review, and artifact metadata', async () => {
  const responses = new Map([
    ['/repos/agilno/conference-planner', { id: 1, full_name: 'agilno/conference-planner', default_branch: 'main', private: true, html_url: 'https://github.com/agilno/conference-planner' }],
    ['/repos/agilno/conference-planner/branches/main', { name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true }],
    ['/repos/agilno/conference-planner/pulls/7', { number: 7, state: 'open', head: { sha: 'b'.repeat(40) }, base: { ref: 'main', sha: 'c'.repeat(40) }, html_url: 'https://github.com/agilno/conference-planner/pull/7' }],
    ['/repos/agilno/conference-planner/commits/' + 'b'.repeat(40) + '/check-runs', { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success' }] }],
    ['/repos/agilno/conference-planner/pulls/7/reviews', [{ id: 10, state: 'APPROVED', user: { login: 'reviewer' } }]],
    ['/repos/agilno/conference-planner/actions/artifacts', { artifacts: [{ id: 11, name: 'qa-bundle', expired: false, archive_download_url: 'https://api.github.com/repos/agilno/conference-planner/actions/artifacts/11/zip' }] }],
  ]);
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async url => {
      const path = new URL(url).pathname;
      const body = responses.get(path);
      assert.notEqual(body, undefined, path);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  });
  const result = await adapter.read({
    kind: 'delivery', owner: 'agilno', repo: 'conference-planner', branch: 'main', pullNumber: 7, commitSha: 'b'.repeat(40),
  });
  assert.equal(result.normalized.repository.fullName, 'agilno/conference-planner');
  assert.equal(result.normalized.branch.commitSha, 'a'.repeat(40));
  assert.equal(result.normalized.pullRequest.number, 7);
  assert.equal(result.normalized.checks[0].conclusion, 'success');
  assert.equal(result.normalized.reviews[0].state, 'APPROVED');
  assert.equal(result.normalized.artifacts[0].name, 'qa-bundle');
});

test('creates an approved GitHub comment with conditional state and idempotency binding', async () => {
  const calls = [];
  const write = {
    provider: 'github', action: 'comment', resourceId: 'agilno/conference-planner#7', expectedState: 'open',
    expectedVersion: '"pr-v7"', idempotencyKey: 'github-comment-pr-7-001', payload: { body: 'QA evidence attached' },
  };
  const receipt = createApprovalReceipt({
    id: 'github-write-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'provider.write', resource: providerWriteResource(write), policyId: 'authority.external-write',
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    governance: {
      approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] }),
      idempotencyRegistry: createProviderIdempotencyRegistry(),
      expectedApproverId: 'human-owner', subjectId: 'worker-one', now: () => Date.parse(NOW),
    },
    conditionalMutation: conditional(),
    transport: transport(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') return new Response(JSON.stringify({ number: 7, state: 'open' }), { status: 200, headers: { etag: '"pr-v7"' } });
      return new Response(JSON.stringify({ id: 12, html_url: 'https://github.com/agilno/conference-planner/issues/7#issuecomment-12' }), { status: 201 });
    }),
  });
  const result = await adapter.write({ ...write, approval: receipt });
  assert.equal(result.status, 'written');
  assert.match(calls[0].url, /\/repos\/agilno\/conference-planner\/pulls\/7$/);
  assert.match(calls[1].url, /\/repos\/agilno\/conference-planner\/issues\/7\/comments$/);
  assert.equal(calls[1].init.headers['if-match'], '"pr-v7"');
  assert.equal(calls[1].init.headers['idempotency-key'], write.idempotencyKey);
});

test('rejects malformed or mismatched GitHub responses as typed remote failures', async () => {
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ id: 1, full_name: 'other/repo', default_branch: 42 }), { status: 200 })),
  });
  await assert.rejects(() => adapter.read({ kind: 'repo', owner: 'agilno', repo: 'conference-planner' }), error => error instanceof ProviderAdapterError
    && error.code === 'ERR_PROVIDER_REMOTE' && error.retryClassification === 'permanent');
});

test('GitHub child comments require trusted atomic parent-state compare-and-mutate', async () => {
  const write = {
    provider: 'github', action: 'comment', resourceId: 'agilno/conference-planner#7', expectedState: 'open',
    expectedVersion: 'pr-v7', idempotencyKey: 'github-comment-boundary-001', payload: { body: 'Exact comment' },
  };
  const receipt = createApprovalReceipt({
    id: 'github-boundary-approval', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'provider.write', resource: providerWriteResource(write), policyId: 'authority.external-write',
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
  let childDispatched = false;
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    governance: {
      approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] }),
      idempotencyRegistry: createProviderIdempotencyRegistry(), expectedApproverId: 'human-owner', subjectId: 'worker-one', now: () => Date.parse(NOW),
    },
    conditionalMutation: conditional(async () => { throw new ProviderAdapterError('state-conflict', { provider: 'github' }); }),
    transport: transport(async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ number: 7, state: 'open' }), { status: 200, headers: { etag: 'pr-v7' } });
      childDispatched = true;
      return new Response('{}', { status: 201 });
    }),
  });
  await assert.rejects(() => adapter.write({ ...write, approval: receipt }), error => error.code === 'ERR_PROVIDER_STATE_CONFLICT');
  assert.equal(childDispatched, false);
});

test('rejects unsafe repository identifiers before network access', async () => {
  let called = false;
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async () => { called = true; return new Response('{}'); }),
  });
  await assert.rejects(() => adapter.read({ kind: 'repo', owner: '..', repo: 'conference-planner' }));
  await assert.rejects(() => adapter.read({ kind: 'repo', owner: 'agilno', repo: 'x'.repeat(101) }));
  assert.equal(called, false);
});

test('paginates GitHub checks reviews and artifacts with loop-safe sanitized links', async () => {
  const canary = 'private-pagination-canary';
  const counts = new Map();
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async url => {
      assert.equal(url.includes(canary), false);
      const parsed = new URL(url);
      const key = parsed.pathname;
      const page = (counts.get(key) ?? 0) + 1;
      counts.set(key, page);
      const next = page === 1 ? { link: `<${parsed.origin}${parsed.pathname}?page=2&per_page=100>; rel="next"` } : {};
      if (key.endsWith('/check-runs')) return new Response(JSON.stringify({ check_runs: [{ id: page, name: `check-${page}`, status: 'completed', conclusion: 'success' }] }), { status: 200, headers: next });
      if (key.endsWith('/reviews')) return new Response(JSON.stringify([{ id: page, state: 'APPROVED', user: { login: `reviewer-${page}` } }]), { status: 200, headers: next });
      if (key.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: page, name: `artifact-${page}`, expired: false, archive_download_url: `https://api.github.com/repos/agilno/conference-planner/actions/artifacts/${page}/zip?token=${canary}` }] }), { status: 200, headers: next });
      if (key.endsWith('/branches/main')) return new Response(JSON.stringify({ name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true }), { status: 200 });
      if (key.endsWith('/pulls/7')) return new Response(JSON.stringify({ number: 7, state: 'open', head: { sha: 'b'.repeat(40) }, base: { ref: 'main', sha: 'c'.repeat(40) }, html_url: 'https://github.com/agilno/conference-planner/pull/7' }), { status: 200 });
      if (key === '/repos/agilno/conference-planner') return new Response(JSON.stringify({ id: 1, full_name: 'agilno/conference-planner', default_branch: 'main', private: true, html_url: 'https://github.com/agilno/conference-planner' }), { status: 200 });
      throw new Error('unexpected path');
    }),
  });
  const result = await adapter.read({ kind: 'delivery', owner: 'agilno', repo: 'conference-planner', branch: 'main', pullNumber: 7, commitSha: 'b'.repeat(40) });
  assert.equal(result.normalized.checks.length, 2);
  assert.equal(result.normalized.reviews.length, 2);
  assert.equal(result.normalized.artifacts.length, 2);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

for (const [name, response, request] of [
  ['branch SHA', { name: 'main', commit: { sha: 'not-a-sha' }, protected: true }, { kind: 'branch', owner: 'agilno', repo: 'conference-planner', branch: 'main' }],
  ['pull shape', { number: 7, state: 'merged', head: { sha: null }, base: { ref: 42 } }, { kind: 'pull', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }],
  ['check entry', { check_runs: [null] }, { kind: 'checks', owner: 'agilno', repo: 'conference-planner', commitSha: 'b'.repeat(40) }],
  ['review entry', [null], { kind: 'reviews', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }],
  ['artifact entry', { artifacts: [null] }, { kind: 'artifacts', owner: 'agilno', repo: 'conference-planner' }],
  ['repository URL', { id: 1, full_name: 'agilno/conference-planner', default_branch: 'main', private: false, html_url: 'https://evil.example/agilno/conference-planner' }, { kind: 'repo', owner: 'agilno', repo: 'conference-planner' }],
  ['pull URL', { number: 7, state: 'open', head: { sha: 'b'.repeat(40) }, base: { ref: 'main', sha: 'c'.repeat(40) }, html_url: 'https://github.com/other/repo/pull/7' }, { kind: 'pull', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }],
  ['artifact URL', { artifacts: [{ id: 11, name: 'bundle', expired: false, archive_download_url: 'https://api.github.com/repos/other/repo/actions/artifacts/11/zip' }] }, { kind: 'artifacts', owner: 'agilno', repo: 'conference-planner' }],
  ['check URL', { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://evil.example/runs/9' }] }, { kind: 'checks', owner: 'agilno', repo: 'conference-planner', commitSha: 'b'.repeat(40) }],
  ['review URL', [{ id: 10, state: 'APPROVED', user: { login: 'reviewer' }, html_url: 'https://evil.example/review/10' }], { kind: 'reviews', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }],
]) test(`rejects malformed GitHub ${name} as a sanitized permanent remote error`, async () => {
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify(response), { status: 200 })),
  });
  await assert.rejects(() => adapter.read(request), error => error instanceof ProviderAdapterError
    && error.code === 'ERR_PROVIDER_REMOTE' && error.retryClassification === 'permanent');
});

test('GitHub pagination rejects cross-repository and signed next links before a second request', async () => {
  for (const link of [
    '<https://api.github.com/repos/other/repo/pulls/7/reviews?page=2>; rel="next"',
    '<https://api.github.com/repos/agilno/conference-planner/pulls/7/reviews?page=2&X-Amz-Signature=private>; rel="next"',
  ]) {
    let calls = 0;
    const adapter = createGithubAdapter({
      baseUrl: 'https://api.github.com', clock: () => NOW,
      transport: transport(async () => {
        calls += 1;
        return new Response(JSON.stringify([{ id: 1, state: 'APPROVED', user: { login: 'reviewer' } }]), { headers: { link } });
      }),
    });
    await assert.rejects(() => adapter.read({ kind: 'reviews', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }), ProviderAdapterError);
    assert.equal(calls, 1, link);
  }
});

test('GitHub pagination fails closed instead of truncating configured item bounds', async () => {
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', maxItems: 1, clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({ check_runs: [
      { id: 1, name: 'one', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'two', status: 'completed', conclusion: 'success' },
    ] }))),
  });
  await assert.rejects(() => adapter.read({ kind: 'checks', owner: 'agilno', repo: 'conference-planner', commitSha: 'b'.repeat(40) }),
    error => error.code === 'ERR_PROVIDER_PAGINATION_LIMIT');
});

test('GitHub pagination rejects duplicate provider identities across pages', async () => {
  for (const [kind, request, pageBody] of [
    ['checks', { kind: 'checks', owner: 'agilno', repo: 'conference-planner', commitSha: 'b'.repeat(40) }, () => ({
      total_count: 2, check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success' }],
    })],
    ['reviews', { kind: 'reviews', owner: 'agilno', repo: 'conference-planner', pullNumber: 7 }, () => ([
      { id: 10, state: 'APPROVED', user: { login: 'reviewer' } },
    ])],
    ['artifacts', { kind: 'artifacts', owner: 'agilno', repo: 'conference-planner' }, () => ({
      total_count: 2, artifacts: [{
        id: 11, name: 'bundle', expired: false,
        archive_download_url: 'https://api.github.com/repos/agilno/conference-planner/actions/artifacts/11/zip',
      }],
    })],
  ]) {
    let calls = 0;
    const adapter = createGithubAdapter({
      baseUrl: 'https://api.github.com', clock: () => NOW,
      transport: transport(async url => {
        calls += 1;
        const parsed = new URL(url);
        return new Response(JSON.stringify(pageBody()), {
          headers: calls === 1 ? { link: `<${parsed.origin}${parsed.pathname}?page=2&per_page=100>; rel="next"` } : {},
        });
      }),
    });
    await assert.rejects(() => adapter.read(request), error => error.code === 'ERR_PROVIDER_REMOTE', kind);
    assert.equal(calls, 2, kind);
  }
});

test('GitHub pagination rejects an incomplete declared provider total', async () => {
  const adapter = createGithubAdapter({
    baseUrl: 'https://api.github.com', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      total_count: 2, check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success' }],
    }))),
  });
  await assert.rejects(() => adapter.read({
    kind: 'checks', owner: 'agilno', repo: 'conference-planner', commitSha: 'b'.repeat(40),
  }), error => error.code === 'ERR_PROVIDER_REMOTE');
});

test('GitHub Enterprise source envelopes use the validated derived web origin', async () => {
  const adapter = createGithubAdapter({
    baseUrl: 'https://ghe.example.test/api/v3', clock: () => NOW,
    transport: transport(async () => new Response(JSON.stringify({
      id: 1, full_name: 'agilno/conference-planner', default_branch: 'main', private: true,
      html_url: 'https://ghe.example.test/agilno/conference-planner',
      url: 'https://ghe.example.test/api/v3/repos/agilno/conference-planner',
    }))),
  });
  const result = await adapter.read({ kind: 'repo', owner: 'agilno', repo: 'conference-planner' });
  assert.equal(result.source.url, 'https://ghe.example.test/agilno/conference-planner');
});
