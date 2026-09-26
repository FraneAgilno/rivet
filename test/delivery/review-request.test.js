import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-26T10:00:00.000Z';
async function fixture(kind, liveClock = false, timeoutMs) {
  const repository = { provider: kind, host: `${kind}.com`, namespace: 'team', name: 'repo', fullName: 'team/repo', url: `https://${kind}.com/team/repo` };
  const target = candidate({ runId: 'run-one', repository, sourceBranch: 'feature/work', targetBranch: 'main', localVerification: { runId: 'run-one', headSha: head, evidenceDigest: 'd'.repeat(64), verifiedAt: at, status: 'passed' } });
  const data = { head, base, repositoryId: 10, reviews: [], calls: [], postCount: 0 };
  const root = kind === 'github' ? '/repos/team/repo' : '/api/v4/projects/team%2Frepo';
  const reviewPath = kind === 'github' ? '/pulls' : '/merge_requests';
  const transport = createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned: async (url, options) => {
    const u = new URL(url), path = u.pathname.slice(root.length);
    data.calls.push({ path, method: options.method, query: u.search, body: options.body });
    const custom = await data.respond?.(path, options);
    if (custom) return custom;
    if (options.method === 'POST') {
      data.postCount++;
      const payload = JSON.parse(options.body);
      const number = data.reviews.length + 1;
      const review = kind === 'github' ? {
        number, state: 'open', merged: false, draft: false, title: payload.title, body: payload.body,
        html_url: `${repository.url}/pull/${number}`,
        head: { sha: data.head, ref: target.sourceBranch, repo: { id: data.repositoryId, full_name: repository.fullName } },
        base: { sha: data.base, ref: target.targetBranch, repo: { id: data.repositoryId, full_name: repository.fullName } },
      } : {
        id: number + 100, iid: number, project_id: data.repositoryId, source_project_id: data.repositoryId, target_project_id: data.repositoryId,
        source_branch: target.sourceBranch, target_branch: target.targetBranch, sha: data.head,
        state: 'opened', draft: false, title: payload.title, description: payload.description,
        web_url: `${repository.url}/-/merge_requests/${number}`,
      };
      data.reviews.push(review);
      await data.afterPost?.(review);
      return Response.json(review, { status: 201 });
    }
    if (path === '') return Response.json(kind === 'github' ? { id: data.repositoryId, full_name: repository.fullName, html_url: repository.url, archived: false } : { id: data.repositoryId, path_with_namespace: repository.fullName, web_url: repository.url, archived: false });
    if (path.includes('/branches/')) {
      const name = decodeURIComponent(path.split('/branches/')[1]);
      return Response.json(kind === 'github' ? { name, commit: { sha: name === target.sourceBranch ? data.head : data.base } } : { name, commit: { id: name === target.sourceBranch ? data.head : data.base } });
    }
    if (path === reviewPath) return Response.json(data.reviews.map(row => { if (kind !== 'github') return row; const { merged, ...listed } = row; return listed; }));
    if (path.startsWith(`${reviewPath}/`)) {
      const number = Number(path.slice(reviewPath.length + 1));
      const review = data.reviews.find(r => (r.number ?? r.iid) === number);
      return Response.json(review ?? {}, { status: review ? 200 : 404 });
    }
    assert.fail(`Unexpected ${options.method} ${path}`);
  } });
  const factory = kind === 'github' ? (await import('../../src/delivery/github-review.js')).createGithubReviewExecutor
    : (await import('../../src/delivery/gitlab-review.js')).createGitlabReviewExecutor;
  const executor = factory({ repository, transport, ...(timeoutMs === undefined ? {} : { timeoutMs }), clock: () => liveClock ? new Date().toISOString() : at });
  const shared = await import('../../src/delivery/review-request.js');
  const operation = async () => ({ action: 'review-request', digest: 'e'.repeat(64), candidate: target, payload: shared.reviewRequestPayload(target), factsDigest: factsDigest(await executor.observe(target)) });
  return { data, target, executor, operation, shared };
}

for (const kind of ['github', 'gitlab']) {
  test(`${kind} creates one exact marked review and verifies readback without reading merge policy`, async () => {
    const f = await fixture(kind), op = await f.operation();
    assert.deepEqual(f.executor.capabilities, [{ action: 'review-request', conditionalHead: false, verifiesCreatedReview: true, reconcile: true }]);
    const receipt = await f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' });
    assert.equal(receipt.headSha, head);
    assert.equal(receipt.commitSha, null);
    assert.equal(f.data.postCount, 1);
    const wire = JSON.parse(f.data.calls.find(call => call.method === 'POST').body);
    assert.equal(wire.title, op.payload.title);
    assert.equal(wire.body ?? wire.description, f.shared.reviewRequestContent(op).body);
    assert.match(wire.body ?? wire.description, /rivet-review-operation:[a-f0-9]{64}/);
    assert.equal(f.data.calls.some(call => /protection|approval|pipeline|check/.test(call.path)), false);
    assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
    assert.equal(f.data.postCount, 1);
  });
  test(`${kind} branch drift or changed content after POST leaves the write unconfirmed`, async () => {
    for (const change of ['head', 'base', 'body', 'url', 'repository', 'source-repository']) {
      const f = await fixture(kind), op = await f.operation();
      f.data.afterPost = review => {
        if (change === 'source-repository') { if (kind === 'github') review.head.repo.id = 20; else review.source_project_id = 20; }
        if (change === 'repository') f.data.repositoryId = 20;
        if (change === 'head') f.data.head = 'c'.repeat(40);
        if (change === 'base') f.data.base = 'c'.repeat(40);
        if (change === 'body') review[kind === 'github' ? 'body' : 'description'] = 'changed';
        if (change === 'url') review[kind === 'github' ? 'html_url' : 'web_url'] += '?other=1';
      };
      await assert.rejects(f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' }));
      assert.equal(f.data.postCount, 1);
      assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
    }
  });
  test(`${kind} reconciliation never writes or treats marker absence or ambiguity as permission to retry`, async () => {
    const f = await fixture(kind), op = await f.operation();
    assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
    assert.equal(f.data.postCount, 0);
    await f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' });
    f.data.reviews[0].state = kind === 'github' ? 'closed' : 'closed';
    assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
    const other = structuredClone(f.data.reviews[0]);
    if (kind === 'github') { other.number = 2; other.html_url = other.html_url.replace('/1', '/2'); }
    else { other.id = 102; other.iid = 2; other.web_url = other.web_url.replace('/1', '/2'); }
    f.data.reviews.push(other);
    assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
    assert.equal(f.data.postCount, 1);
  });
}

test('only explicit verified review creation can omit conditional-head support', async () => {
  const { createTrustedDeliveryExecutor } = await import('../../src/delivery/service.js');
  const methods = { provider: 'github', observe() {}, dispatch() {}, reconcile() {} };
  for (const action of ['merge', 'deploy', 'tracker-update']) {
    assert.throws(() => createTrustedDeliveryExecutor({ ...methods, capabilities: [{ action, conditionalHead: false, verifiesCreatedReview: true, reconcile: true }] }));
  }
  assert.throws(() => createTrustedDeliveryExecutor({ ...methods, capabilities: [{ action: 'review-request', conditionalHead: false, reconcile: true }] }));
  assert.throws(() => createTrustedDeliveryExecutor({ ...methods, capabilities: [{ action: 'review-request', conditionalHead: false, verifiesCreatedReview: true, reconcile: false }] }));
  assert.doesNotThrow(() => createTrustedDeliveryExecutor({ ...methods, capabilities: [{ action: 'review-request', conditionalHead: false, verifiesCreatedReview: true, reconcile: true }] }));
  assert.doesNotThrow(() => createTrustedDeliveryExecutor({ ...methods, capabilities: [{ action: 'merge', conditionalHead: true, reconcile: true }] }));
});

async function commandFixture(t, kind) {
  const f = await fixture(kind, true);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { resolveStatePaths } = await import('../../src/state/paths.js');
  const { createDeliveryStore } = await import('../../src/delivery/store.js');
  const { createDeliveryService } = await import('../../src/delivery/service.js');
  const { createApprovalRegistry } = await import('../../src/policy/approvals.js');
  const { createAuthorityEnvelope } = await import('../../src/policy/authority.js');
  const root = await mkdtemp(join(tmpdir(), 'rivet-review-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const store = createDeliveryStore(await resolveStatePaths(root, 'review-one'));
  const { headSha, reviewNumber, ...initial } = f.target;
  const service = createDeliveryService({ store, executor: f.executor, providerId: 'repository', subjectId: 'delivery-cli', expectedApproverId: 'terminal-human',
    authority: createAuthorityEnvelope({ actorId: 'delivery-cli', principal: 'agent', actions: [], ownedPaths: [], providers: [], commands: [] }),
    approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'terminal-human', principal: 'human' }] }),
    });
  await service.initialize({ ...initial, localVerification: { ...initial.localVerification, verifiedAt: new Date(Date.now() - 1000).toISOString() } });
  const config = { project: { id: 'demo' }, providers: { providers: [{ id: 'repository', kind: 'git-ci', mode: 'read-write-with-approval', transport: 'direct-api', capabilities: ['repository-read', 'review-request'], projectIds: ['demo'], resourceIds: ['team/repo'], endpoint: kind === 'github' ? 'https://api.github.com' : 'https://gitlab.com/api/v4', credentials: { tokenEnv: 'RIVET_TEST_TOKEN' } }] } };
  const calls = { local: 0, confirm: 0, factory: 0 }, messages = [];
  const input = { action: 'review', store, config, flags: {}, validateLocal: async () => { calls.local++; }, dependencies: {
    env: { RIVET_TEST_TOKEN: 'dummy-fixture-value' }, terminalIsInteractive: () => true,
    output: { log: value => messages.push(value) }, confirmDelivery: async state => { calls.confirm++; assert.equal(state.proposal.action, 'review-request'); return true; },
    delivery: { reviewExecutorFactory: () => { calls.factory++; return f.executor; } },
  } };
  return { ...f, input, calls, messages, store };
}

test('review command prepares exact interactive content without checks-read and rechecks local/configuration', async t => {
  const { runRemoteDelivery } = await import('../../src/commands/delivery-remote.js');
  const f = await commandFixture(t, 'github');
  const result = await runRemoteDelivery(f.input);
  assert.equal(result.stage, 'review-requested');
  assert.equal(f.calls.local, 2);
  assert.equal(f.calls.confirm, 1);
  assert.equal(f.data.postCount, 1);
  assert.match(f.messages.join('\n'), /not atomic/i);
  assert.match(f.messages.join('\n'), /rivet-review-operation:/);
  assert.equal((await runRemoteDelivery(f.input)).stage, 'review-requested');
  assert.equal(f.data.postCount, 1);
});

for (const kind of ['github', 'gitlab']) {
  test(`${kind} requires an already published exact source and refuses preexisting reviews`, async () => {
    const missing = await fixture(kind);
    missing.data.respond = path => path.includes('/branches/') ? Response.json({}, { status: 404 }) : null;
    await assert.rejects(missing.executor.observe(missing.target), { code: 'ERR_DELIVERY_BRANCH_NOT_PUBLISHED' });
    assert.equal(missing.data.postCount, 0);
    const f = await fixture(kind), op = await f.operation();
    await f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' });
    assert.equal((await f.executor.observe(f.target)).review.number, 1);
    await assert.rejects(f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' }));
    assert.equal(f.data.postCount, 1);
  });
  test(`${kind} uncertain creation is durable and reconciliation finds the marked effect without duplicate writes`, async t => {
    const { runRemoteDelivery } = await import('../../src/commands/delivery-remote.js');
    const f = await commandFixture(t, kind);
    f.data.afterPost = () => { throw new Error('connection ended after remote creation'); };
    const result = await runRemoteDelivery(f.input);
    assert.equal(result.operations[0].state, 'indeterminate');
    assert.equal(f.data.postCount, 1);
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.data.postCount, 1);
    f.input.dependencies.delivery.executorFactory = () => assert.fail('recovery must not select merge executor');
    const reconciled = await runRemoteDelivery({ ...f.input, action: 'reconcile' });
    assert.equal(reconciled.stage, 'review-requested');
    assert.equal(reconciled.operations[0].state, 'succeeded');
    assert.equal(reconciled.operations.length, 1);
    assert.equal(f.data.postCount, 1);
  });
}

test('review CLI declines unattended/unapproved writes and rejects configuration or local drift before POST', async t => {
  const { runRemoteDelivery } = await import('../../src/commands/delivery-remote.js');
  for (const mode of ['unattended', 'declined', 'config', 'local']) {
    const f = await commandFixture(t, 'github');
    if (mode === 'unattended') f.input.dependencies.terminalIsInteractive = () => false;
    if (mode === 'declined') f.input.dependencies.confirmDelivery = async () => false;
    if (mode === 'config') f.input.reloadConfig = async () => ({ ...f.input.config, project: { id: 'other-project' } });
    if (mode === 'local') f.input.validateLocal = async () => { if (++f.calls.local > 1) throw new Error('local revision changed'); };
    await assert.rejects(runRemoteDelivery(f.input));
    assert.equal(f.data.postCount, 0, mode);
    assert.equal((await f.store.read()).operations.length, 0, mode);
  }
});

test('review content validation rejects control characters excessive size and preexisting operation markers before any POST', async () => {
  const f = await fixture('github'), op = await f.operation();
  for (const payload of [
    { ...op.payload, title: 'review\nother' },
    { ...op.payload, title: 'x'.repeat(257) },
    { ...op.payload, body: 'x'.repeat(32001) },
    { ...op.payload, body: 'rivet-review-operation:forged' },
    { ...op.payload, body: 'text\u001b[2J' },
    { ...op.payload, extra: 'unapproved' },
  ]) await assert.rejects(f.executor.dispatch({ ...op, payload }, { deadline: '2026-09-26T10:01:00.000Z' }));
  assert.equal(f.data.postCount, 0);
});

for (const kind of ['github', 'gitlab']) test(`${kind} a timed-out create remains unknown and never retries POST during reconciliation`, async () => {
  const f = await fixture(kind, false, 20), op = await f.operation();
  f.data.respond = (_path, options) => options.method === 'POST' ? new Promise(() => {}) : null;
  await assert.rejects(f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' }));
  assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
  assert.equal(f.data.calls.filter(call => call.method === 'POST').length, 1);
});

for (const kind of ['github', 'gitlab']) test(`${kind} accepts repository IDs above one billion while preserving identity verification`, async () => {
  const f = await fixture(kind);
  f.data.repositoryId = 1380996664;
  const op = await f.operation();
  const receipt = await f.executor.dispatch(op, { deadline: '2026-09-26T10:01:00.000Z' });
  assert.equal(receipt.status, 'succeeded');
  assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
  assert.equal(f.data.postCount, 1);
});
