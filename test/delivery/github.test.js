import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
import { createGithubDeliveryExecutor } from '../../src/delivery/github.js';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  merged = 'c'.repeat(40),
  at = '2026-09-25T10:00:00.000Z';
const repository = {
  provider: 'github',
  host: 'github.com',
  namespace: 'team',
  name: 'repo',
  fullName: 'team/repo',
  url: 'https://github.com/team/repo',
};
const target = candidate({
  runId: 'run-one',
  repository,
  sourceBranch: 'feature',
  targetBranch: 'main',
  reviewNumber: 7,
  localVerification: {
    runId: 'run-one',
    headSha: head,
    evidenceDigest: 'd'.repeat(64),
    verifiedAt: at,
    status: 'passed',
  },
});
function fixture(change = () => {}) {
  const pull = {
    number: 7,
    state: 'open',
    merged: false,
    draft: false,
    html_url: repository.url + '/pull/7',
    head: { sha: head, ref: 'feature', repo: { full_name: 'team/repo' } },
    base: { sha: base, ref: 'main', repo: { full_name: 'team/repo' } },
  };
  const protection = {
    enforce_admins: { enabled: true },
    required_status_checks: { strict: true, contexts: ['ci'], checks: [{ context: 'ci', app_id: 123 }] },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    required_conversation_resolution: { enabled: false },
  };
  const checks = {
    total_count: 1,
    check_runs: [
      { id: 1, name: 'ci', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 123 } },
    ],
  };
  const reviews = [{ id: 1, state: 'APPROVED', user: { login: 'reviewer' }, commit_id: head }];
  const data = { pull, protection, checks, reviews, rules: [], statuses: [], calls: [], pulls: [pull] };
  change(data);
  const transport = createTrustedProviderTransport({
    resolve: async () => { await data.resolve?.(); return ['93.184.216.34']; },
    fetchPinned: async (url, options) => {
      const path = new URL(url).pathname.replace('/repos/team/repo', '');
      data.calls.push({ path, ...options });
      const overridden = await data.respond?.(path, options, data);
      if (overridden) return overridden;
      if (options.method === 'PUT') {
        pull.merged = true;
        pull.state = 'closed';
        pull.merge_commit_sha = merged;
        return Response.json({ merged: true, sha: merged });
      }
      let value =
        path === '/pulls/7'
          ? pull
          : path === '/pulls'
            ? data.pulls
            : path === '/branches/main/protection'
              ? protection
              : path === '/rules/branches/main'
                ? data.rules
                : path === '/branches/main'
                  ? { name: 'main', commit: { sha: base } }
                  : path === '/branches/feature'
                    ? { name: 'feature', commit: { sha: head } }
                    : path.endsWith('/check-runs')
                      ? checks
                      : path.endsWith('/statuses')
                        ? data.statuses
                        : path === '/pulls/7/reviews'
                          ? reviews
                          : path === '/collaborators/reviewer/permission'
                            ? { permission: 'write', user: { login: 'reviewer' } }
                            : path.startsWith('/compare/')
                              ? { status: 'ahead', merge_base_commit: { sha: base } }
                              : undefined;
      assert.notEqual(value, undefined, path);
      return Response.json(value);
    },
  });
  return {
    ...data,
    executor: createGithubDeliveryExecutor({ repository, transport, clock: () => data.now ?? at }),
  };
}
test('observes required policy and merges exact candidate with verified receipt', async () => {
  const f = fixture();
  const observed = await f.executor.observe(target);
  assert.equal(observed.checks.satisfied, true);
  assert.equal(observed.reviews.satisfied, true);
  const operation = {
    action: 'merge',
    candidate: target,
    payload: { reviewNumber: 7, mergeMethod: 'squash' },
    digest: 'e'.repeat(64),
    factsDigest: factsDigest(observed),
  };
  const receipt = await f.executor.dispatch(operation, { deadline: '2026-09-25T10:00:10.000Z' });
  assert.equal(receipt.commitSha, merged);
  const write = f.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(write.body), { sha: head, merge_method: 'squash' });
  assert.equal((await f.executor.reconcile(operation)).status, 'succeeded');
});
test('unsupported policy and missing required check fail closed', async () => {
  for (const change of [
    (d) => d.rules.push({ type: 'pull_request' }),
    (d) => (d.protection.enforce_admins.enabled = false),
    (d) => (d.protection.required_pull_request_reviews.require_code_owner_reviews = true),
  ]) {
    const f = fixture(change);
    assert.equal((await f.executor.observe(target)).checks.policy, 'unknown');
    assert.equal(
      f.calls.some((c) => c.method === 'PUT'),
      false
    );
  }
  const f = fixture((d) => (d.checks.check_runs[0].conclusion = 'failure'));
  assert.equal((await f.executor.observe(target)).checks.satisfied, false);
});
test('open pull is never terminal non-application evidence', async () => {
  const f = fixture();
  assert.deepEqual(
    await f.executor.reconcile({
      action: 'merge',
      candidate: target,
      payload: { reviewNumber: 7, mergeMethod: 'merge' },
      digest: 'e'.repeat(64),
    }),
    { status: 'unknown' }
  );
});
test('discovers one matching PR and rejects ambiguity and cross-repository heads', async () => {
  const f = fixture();
  const inferred = { ...target, reviewNumber: null };
  assert.equal((await f.executor.observe(inferred)).review.number, 7);
  const ambiguous = fixture((d) => d.pulls.push({ ...d.pull, number: 8 }));
  await assert.rejects(ambiguous.executor.observe(inferred), /ambiguous-review/);
  const foreign = fixture((d) => (d.pull.head.repo.full_name = 'other/repo'));
  await assert.rejects(foreign.executor.observe(target), /changed-facts/);
});
test('changed policy after approval stops before mutation', async () => {
  const f = fixture();
  const observed = await f.executor.observe(target);
  f.protection.required_pull_request_reviews.required_approving_review_count = 2;
  await assert.rejects(
    f.executor.dispatch(
      {
        action: 'merge',
        candidate: target,
        payload: { reviewNumber: 7, mergeMethod: 'squash' },
        digest: 'e'.repeat(64),
        factsDigest: factsDigest(observed),
      },
      { deadline: '2026-09-25T10:00:10.000Z' }
    ),
    /changed-facts/
  );
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false
  );
});
test('app mismatch, latest failure and stale review cannot satisfy required policy', async () => {
  for (const change of [
    (d) => (d.checks.check_runs[0].app.id = 456),
    (d) => {
      d.checks.total_count = 2;
      d.checks.check_runs.push({ ...d.checks.check_runs[0], id: 2, conclusion: 'failure' });
    },
    (d) => d.statuses.push({ id: 1, context: 'ci', state: 'failure' }),
  ])
    assert.equal((await fixture(change).executor.observe(target)).checks.satisfied, false);
  for (const change of [
    (d) => (d.reviews[0].commit_id = base),
    (d) => d.reviews.push({ ...d.reviews[0], id: 2, state: 'DISMISSED' }),
    (d) => d.reviews.push({ ...d.reviews[0], id: 2, state: 'CHANGES_REQUESTED' }),
  ])
    assert.equal((await fixture(change).executor.observe(target)).reviews.satisfied, false);
});
test('comments do not erase effective approval or changes requested', async () => {
  for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
    const f = fixture((d) => {
      d.reviews[0].state = state;
      d.reviews.push({ ...d.reviews[0], id: 2, state: 'COMMENTED' });
    });
    assert.equal((await f.executor.observe(target)).reviews.satisfied, state === 'APPROVED');
  }
});
test('dispatch rejects unsupported actions, wrong PR and extra payload keys without writes', async () => {
  const f = fixture();
  const facts = await f.executor.observe(target);
  const op = {
    action: 'merge',
    candidate: target,
    payload: { reviewNumber: 7, mergeMethod: 'merge' },
    digest: 'e'.repeat(64),
    factsDigest: factsDigest(facts),
  };
  for (const changed of [
    { ...op, action: 'deploy' },
    { ...op, payload: { ...op.payload, reviewNumber: 8 } },
    { ...op, payload: { ...op.payload, force: true } },
  ])
    await assert.rejects(f.executor.dispatch(changed, { deadline: '2026-09-25T10:00:10.000Z' }));
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false
  );
});
test('inaccessible policy stays unknown and changed source during observation is rejected', async () => {
  const unavailable = fixture(
    (d) =>
      (d.respond = async (path) =>
        path.endsWith('/protection') ? Response.json({ message: 'Forbidden' }, { status: 403 }) : null)
  );
  assert.equal((await unavailable.executor.observe(target)).checks.policy, 'unknown');
  let reads = 0;
  const drift = fixture(
    (d) =>
      (d.respond = async (path) =>
        path === '/branches/feature' && ++reads === 2
          ? Response.json({ name: 'feature', commit: { sha: base } })
          : null)
  );
  await assert.rejects(drift.executor.observe(target), /changed-facts/);
});
test('a transport failure after merge reconciles success without sending another write', async () => {
  let writes = 0;
  const f = fixture(
    (d) =>
      (d.respond = async (path, options) => {
        if (options.method === 'PUT') {
          writes++;
          d.pull.merged = true;
          d.pull.state = 'closed';
          d.pull.merge_commit_sha = merged;
          throw Error('lost response');
        }
        return null;
      })
  );
  const facts = await f.executor.observe(target);
  const op = {
    action: 'merge',
    candidate: target,
    payload: { reviewNumber: 7, mergeMethod: 'merge' },
    digest: 'e'.repeat(64),
    factsDigest: factsDigest(facts),
  };
  await assert.rejects(f.executor.dispatch(op, { deadline: '2026-09-25T10:00:10.000Z' }));
  assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
  assert.equal(writes, 1);
});
test('malformed merge response is not accepted and read failures reconcile unknown', async () => {
  const f = fixture(
    (d) =>
      (d.respond = async (path, options) =>
        options.method === 'PUT' ? Response.json({ merged: true, sha: 'bad' }) : null)
  );
  const facts = await f.executor.observe(target);
  await assert.rejects(
    f.executor.dispatch(
      {
        action: 'merge',
        candidate: target,
        payload: { reviewNumber: 7, mergeMethod: 'merge' },
        digest: 'e'.repeat(64),
        factsDigest: factsDigest(facts),
      },
      { deadline: '2026-09-25T10:00:10.000Z' }
    )
  );
  const missing = fixture(
    (d) => (d.respond = async () => Response.json({ message: 'missing' }, { status: 404 }))
  );
  assert.deepEqual(
    await missing.executor.reconcile({
      action: 'merge',
      candidate: target,
      payload: { reviewNumber: 7, mergeMethod: 'merge' },
      digest: 'e'.repeat(64),
    }),
    { status: 'unknown' }
  );
});

test('a newer passing run cannot hide a failed suite or app under one required name', async () => {
  for (const appBound of [true, false]) {
    const f = fixture((d) => {
      if (!appBound) d.protection.required_status_checks.checks[0].app_id = null;
      d.checks.check_runs[0].conclusion = 'failure';
      d.checks.check_runs.push({
        ...d.checks.check_runs[0],
        id: 2,
        conclusion: 'success',
        app: { id: appBound ? 123 : 456 },
      });
      d.checks.total_count = 2;
    });
    assert.equal((await f.executor.observe(target)).checks.satisfied, false);
  }
});
test('dispatch expiry before and during observation prevents PUT; reconciliation needs no deadline', async () => {
  const f = fixture((d) => (d.now = at));
  const observed = await f.executor.observe(target);
  const op = {
    action: 'merge',
    candidate: target,
    payload: { reviewNumber: 7, mergeMethod: 'merge' },
    digest: 'e'.repeat(64),
    factsDigest: factsDigest(observed),
  };
  await assert.rejects(f.executor.dispatch(op, { deadline: at }), /dispatch-expired/);
  assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
  const late = fixture(
    (d) =>
      (d.respond = async (path) => {
        if (path.endsWith('/reviews')) d.now = '2026-09-25T10:00:20.000Z';
        return null;
      })
  );
  await assert.rejects(
    late.executor.dispatch(op, { deadline: '2026-09-25T10:00:10.000Z' }),
    /dispatch-expired/
  );
  assert.equal(
    late.calls.some((c) => c.method === 'PUT'),
    false
  );
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false
  );
});

test('dispatch deadline aborts delayed DNS before mutation reaches transport', async () => {
  let delay = false, ruleReads = 0;
  const f = fixture(d => {
    d.resolve = async () => { if (delay) await new Promise(resolve => setTimeout(resolve, 60)); };
    d.respond = async path => {
      if (path === '/rules/branches/main' && ++ruleReads === 4) delay = true;
      return null;
    };
  });
  const facts = await f.executor.observe(target);
  const op = {action:'merge', candidate:target, payload:{reviewNumber:7,mergeMethod:'merge'}, digest:'e'.repeat(64), factsDigest:factsDigest(facts)};
  await assert.rejects(f.executor.dispatch(op, {deadline:'2026-09-25T10:00:00.015Z'}));
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});
