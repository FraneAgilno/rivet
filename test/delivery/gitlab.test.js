import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
import { createGitlabDeliveryExecutor } from '../../src/delivery/gitlab.js';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  merged = 'c'.repeat(40);
const at = '2026-09-25T10:00:00.000Z',
  deadline = '2026-09-25T10:00:10.000Z';
const repository = {
  provider: 'gitlab',
  host: 'gitlab.com',
  namespace: 'team/sub',
  name: 'repo',
  fullName: 'team/sub/repo',
  url: 'https://gitlab.com/team/sub/repo',
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
  const project = {
    id: 42,
    path_with_namespace: repository.fullName,
    web_url: repository.url,
    archived: false,
    merge_method: 'merge',
    squash_option: 'default_off',
    merge_pipelines_enabled: false,
    merge_trains_enabled: false,
    only_allow_merge_if_pipeline_succeeds: true,
    allow_merge_on_skipped_pipeline: false,
    only_allow_merge_if_all_discussions_are_resolved: false,
    only_allow_merge_if_all_status_checks_passed: false,
    prevent_merge_without_jira_issue: false,
    compliance_frameworks: [],
  };
  const mr = {
    id: 70,
    iid: 7,
    project_id: 42,
    source_project_id: 42,
    target_project_id: 42,
    source_branch: 'feature',
    target_branch: 'main',
    state: 'opened',
    sha: head,
    diff_refs: { head_sha: head, base_sha: base, start_sha: base },
    web_url: repository.url + '/-/merge_requests/7',
    draft: false,
    user: { can_merge: true },
    detailed_merge_status: 'mergeable',
    head_pipeline: { id: 15, project_id: 42, sha: head, status: 'success' },
    merge_when_pipeline_succeeds: false,
    merge_after: null,
    squash: false,
    force_remove_source_branch: false,
  };
  const approvalConfig = {
    reset_approvals_on_push: true,
    selective_code_owner_removals: false,
    disable_overriding_approvers_per_merge_request: true,
  };
  const approvalSettings = {
    retain_approvals_on_push: { value: false, locked: true, inherited_from: 'group' },
    selective_code_owner_removals: { value: false, locked: false, inherited_from: null },
    allow_overrides_to_approver_list_per_merge_request: { value: false, locked: false, inherited_from: null },
  };
  const approvals = {
    approval_rules_overwritten: false,
    rules: [
      {
        id: 1,
        rule_type: 'regular',
        approvals_required: 1,
        approved: true,
        overridden: false,
        contains_hidden_groups: false,
        eligible_approvers: [{ id: 8 }],
        approved_by: [{ id: 8 }],
      },
    ],
  };
  const protections = [
    {
      id: 1,
      name: 'main',
      allow_force_push: false,
      code_owner_approval_required: false,
      merge_access_levels: [{ access_level: 40 }],
      push_access_levels: [{ access_level: 0 }],
    },
  ];
  const data = {
    project,
    mr,
    approvalConfig,
    approvalSettings,
    approvals,
    protections,
    calls: [],
    matches: [mr],
  };
  change(data);
  const transport = createTrustedProviderTransport({
    resolve: async () => {
      await data.resolve?.();
      return ['93.184.216.34'];
    },
    fetchPinned: async (url, options) => {
      const path = new URL(url).pathname.replace('/api/v4/projects/team%2Fsub%2Frepo', '');
      data.calls.push({ path, ...options });
      if (path === '/merge_request_approval_setting') return Response.json(approvalSettings);
      const override = await data.respond?.(path, options, data);
      if (override) return override;
      if (options.method === 'PUT') {
        mr.state = 'merged';
        mr.merge_commit_sha = merged;
        return Response.json(mr);
      }
      const value =
        path === ''
          ? project
          : path === '/merge_requests/7'
            ? mr
            : path === '/merge_requests'
              ? data.matches
              : path === '/approvals'
                ? approvalConfig
                : path === '/merge_requests/7/approval_state'
                  ? approvals
                  : path === '/protected_branches'
                    ? protections
                    : path === '/repository/branches/main'
                      ? { name: 'main', protected: true, commit: { id: base } }
                      : path === '/repository/branches/feature'
                        ? { name: 'feature', commit: { id: head } }
                        : path === '/repository/merge_base'
                          ? { id: base }
                          : undefined;
      assert.notEqual(value, undefined, path);
      return Response.json(value);
    },
  });
  data.executor = createGitlabDeliveryExecutor({
    repository,
    transport,
    clock: () => data.now ?? at,
  });
  return data;
}
function operation(facts) {
  return {
    action: 'merge',
    candidate: target,
    payload: { reviewNumber: 7, mergeMethod: 'merge' },
    digest: 'e'.repeat(64),
    factsDigest: factsDigest(facts),
  };
}
test('GitLab merges an exact head only after supported policy and verifies resulting commit', async () => {
  const f = fixture(),
    facts = await f.executor.observe(target);
  assert.equal(facts.checks.satisfied, true);
  assert.equal(facts.reviews.satisfied, true);
  const op = operation(facts),
    receipt = await f.executor.dispatch(op, { deadline });
  assert.equal(receipt.commitSha, merged);
  assert.deepEqual(JSON.parse(f.calls.find((c) => c.method === 'PUT').body), {
    sha: head,
    squash: false,
    auto_merge: false,
    should_remove_source_branch: false,
  });
  assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
});
test('GitLab unsupported or unreadable policy cannot authorize merge', async () => {
  for (const change of [
    (d) => (d.project.merge_trains_enabled = true),
    (d) => delete d.project.merge_pipelines_enabled,
    (d) => (d.project.squash_option = 'always'),
    (d) => (d.project.only_allow_merge_if_all_status_checks_passed = true),
    (d) => (d.approvalConfig.reset_approvals_on_push = false),
    (d) => (d.approvalConfig.selective_code_owner_removals = true),
    (d) => (d.approvalSettings.retain_approvals_on_push.value = true),
    (d) => delete d.approvalSettings.selective_code_owner_removals,
    (d) => (d.approvals.rules[0].contains_hidden_groups = true),
    (d) => (d.approvals.approval_rules_overwritten = true),
    (d) => (d.approvals.rules[0].rule_type = 'code_owner'),
    (d) => (d.protections[0].name = '*'),
    (d) => (d.protections[0].allow_force_push = true),
    (d) => (d.respond = async (p) => (p === '/approvals' ? Response.json({}, { status: 403 }) : null)),
  ]) {
    const f = fixture(change);
    const facts = await f.executor.observe(target);
    assert.equal(facts.checks.policy, 'unknown');
    assert.equal(facts.reviews.policy, 'unknown');
    assert.equal(
      f.calls.some((c) => c.method === 'PUT'),
      false,
    );
  }
});
test('GitLab failed, stale, or missing pipeline and unapproved rules block readiness', async () => {
  for (const change of [
    (d) => (d.mr.head_pipeline.status = 'failed'),
    (d) => (d.mr.head_pipeline.sha = base),
    (d) => (d.mr.head_pipeline = null),
    (d) => (d.mr.user.can_merge = false),
    (d) => (d.mr.detailed_merge_status = 'approvals_syncing'),
    (d) => (d.mr.draft = true),
  ])
    assert.equal((await fixture(change).executor.observe(target)).checks.satisfied, false);
  for (const change of [
    (d) => (d.approvals.rules[0].approved = false),
    (d) => (d.approvals.rules[0].approved_by = []),
    (d) => (d.approvals.rules[0].approved_by = [{ id: 99 }]),
  ])
    assert.equal((await fixture(change).executor.observe(target)).reviews.satisfied, false);
});
test('GitLab rejects ambiguous discovery and changed repository, branch or head', async () => {
  const f = fixture();
  assert.equal((await f.executor.observe({ ...target, reviewNumber: null })).review.number, 7);
  await assert.rejects(
    fixture((d) => d.matches.push({ ...d.mr, id: 80, iid: 8 })).executor.observe({
      ...target,
      reviewNumber: null,
    }),
    /ambiguous-review/,
  );
  for (const change of [
    (d) => (d.mr.source_project_id = 99),
    (d) => (d.mr.sha = base),
    (d) => (d.mr.target_branch = 'other'),
    (d) => (d.project.path_with_namespace = 'other/repo'),
  ])
    await assert.rejects(fixture(change).executor.observe(target), /changed-facts/);
});
test('GitLab rechecks facts before dispatch and rejects unsupported method before reads', async () => {
  const f = fixture(),
    op = operation(await f.executor.observe(target));
  f.approvals.rules[0].approved = false;
  await assert.rejects(f.executor.dispatch(op, { deadline }), /changed-facts/);
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false,
  );
  const fresh = fixture();
  await assert.rejects(
    fresh.executor.dispatch({ ...op, payload: { reviewNumber: 7, mergeMethod: 'squash' } }, { deadline }),
  );
  assert.equal(fresh.calls.length, 0);
});
test('GitLab detects branch and policy drift during observation', async () => {
  for (const endpoint of ['/repository/branches/main', '/approvals']) {
    let count = 0;
    const f = fixture(
      (d) =>
        (d.respond = async (p) =>
          p === endpoint && ++count === 2
            ? Response.json(
                endpoint.endsWith('main')
                  ? { name: 'main', protected: true, commit: { id: head } }
                  : { ...d.approvalConfig, reset_approvals_on_push: false },
              )
            : null),
    );
    await assert.rejects(f.executor.observe(target), /changed-facts/);
  }
});
test('GitLab open or unreadable MR remains unknown and a lost merge response reconciles without retry', async () => {
  const f = fixture(),
    op = operation(await f.executor.observe(target));
  assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
  f.respond = async (p, o) => {
    if (o.method === 'PUT') {
      f.mr.state = 'merged';
      f.mr.merge_commit_sha = merged;
      throw Error('lost response');
    }
  };
  await assert.rejects(f.executor.dispatch(op, { deadline }));
  assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
  f.mr.sha = base;
  assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
});
test('GitLab dispatch deadline expires during observation before the merge write', async () => {
  const f = fixture(),
    op = operation(await f.executor.observe(target));
  f.respond = async () => {
    f.now = deadline;
  };
  await assert.rejects(f.executor.dispatch(op, { deadline }), /dispatch-expired/);
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false,
  );
});
test('GitLab dispatch aborts delayed DNS before transport can receive a write', async () => {
  let delay = false,
    reads = 0;
  const f = fixture((d) => {
    d.resolve = async () => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, 60));
    };
    d.respond = async (path) => {
      if (path === '/merge_requests/7/approval_state' && ++reads === 4) delay = true;
    };
  });
  const op = operation(await f.executor.observe(target));
  await assert.rejects(f.executor.dispatch(op, { deadline: '2026-09-25T10:00:00.015Z' }));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(
    f.calls.some((c) => c.method === 'PUT'),
    false,
  );
});
test('GitLab cannot accept a write response without matching persisted merge evidence', async () => {
  const f = fixture(),
    op = operation(await f.executor.observe(target));
  f.respond = async (p, o) =>
    o.method === 'PUT' ? Response.json({ ...f.mr, state: 'merged', merge_commit_sha: merged }) : null;
  await assert.rejects(f.executor.dispatch(op, { deadline }), /unverified-effect/);
  assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
});
test('GitLab rejects stale target ancestry, unavailable merge permission and direct push bypass', async () => {
  const behind = fixture(
    (d) => (d.respond = async (p) => (p === '/repository/merge_base' ? Response.json({ id: head }) : null)),
  );
  assert.equal((await behind.executor.observe(target)).checks.satisfied, false);
  const pushes = fixture((d) => (d.protections[0].push_access_levels = [{ access_level: 40 }]));
  assert.equal((await pushes.executor.observe(target)).checks.policy, 'unknown');
  const missing = fixture((d) => delete d.mr.user);
  assert.equal((await missing.executor.observe(target)).checks.satisfied, false);
});
