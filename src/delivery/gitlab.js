import { createProviderHttpClient } from '../adapters/http.js';
import { captureRecord, createProviderWireBody } from '../adapters/contract.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import {
  ensure,
  exact,
  factsDigest,
  hash,
  plain,
  ready,
  sha,
  timestamp,
  validateCandidate,
} from './contract.js';

// GitLab conditions this operation on the source SHA. Target and policy are
// rechecked, but concurrent administrator changes are not an atomic condition.
export function createGitlabDeliveryExecutor(inputConfig) {
  const input = captureRecord(
    inputConfig,
    new Set(['repository', 'transport', 'headers', 'clock', 'timeoutMs']),
    ['repository', 'transport'],
    'invalid-config',
  );
  const supplied = plain(input.repository),
    repository = parseRepositoryRemote(supplied.url);
  ensure(repository.provider === 'gitlab' && hash(repository) === hash(supplied));
  const clock = input.clock ?? (() => new Date().toISOString());
  ensure(typeof clock === 'function');
  const http = createProviderHttpClient({
    provider: 'gitlab',
    baseUrl: 'https://gitlab.com/api/v4',
    transport: input.transport,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    allowEncodedSlash: true,
  });
  const root = `/projects/${encodeURIComponent(repository.fullName)}`;
  const get = async (path) => (await http.request({ method: 'GET', path: root + path })).data;
  const pages = (path) => http.paginate({ path: root + path, identityKey: 'id' });
  const number = (value) => {
    ensure(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000);
    return value;
  };
  function target(value) {
    validateCandidate(value);
    ensure(hash(value.repository) === hash(repository), 'provider-mismatch');
  }
  function project(value) {
    number(value?.id);
    ensure(
      value.path_with_namespace === repository.fullName && value.web_url === repository.url,
      'changed-facts',
    );
    const fields = [
      'id',
      'archived',
      'merge_method',
      'squash_option',
      'merge_pipelines_enabled',
      'merge_trains_enabled',
      'only_allow_merge_if_pipeline_succeeds',
      'allow_merge_on_skipped_pipeline',
      'only_allow_merge_if_all_discussions_are_resolved',
      'only_allow_merge_if_all_status_checks_passed',
      'prevent_merge_without_jira_issue',
      'compliance_frameworks',
    ];
    return Object.fromEntries(fields.map((key) => [key, value[key] ?? null]));
  }
  function mergeRequest(value, candidate, expected, projectId) {
    ensure(
      value?.iid === expected &&
        value.project_id === projectId &&
        value.source_project_id === projectId &&
        value.target_project_id === projectId &&
        value.sha === candidate.headSha &&
        value.source_branch === candidate.sourceBranch &&
        value.target_branch === candidate.targetBranch &&
        value.web_url === `${repository.url}/-/merge_requests/${expected}`,
      'changed-facts',
    );
    ensure(
      ['opened', 'closed', 'merged', 'locked'].includes(value.state) && typeof value.draft === 'boolean',
      'invalid-provider-evidence',
    );
    // Merged results need only the recorded MR identity and merge commit; branches
    // may already be deleted and mergeability/approval endpoints need not survive.
    if (value.state === 'merged')
      return {
        number: expected,
        state: 'merged',
        url: value.web_url,
        headSha: value.sha,
        commitSha: sha(value.merge_commit_sha),
      };
    ensure(value.diff_refs?.head_sha === candidate.headSha, 'changed-facts');
    return {
      number: expected,
      state: value.state === 'opened' ? 'open' : 'closed',
      url: value.web_url,
      headSha: value.sha,
      commitSha: null,
      draft: value.draft,
      canMerge: value.user?.can_merge === true,
      status: value.detailed_merge_status ?? null,
      pipeline: value.head_pipeline ?? null,
      autoMerge: value.merge_when_pipeline_succeeds ?? null,
      mergeAfter: value.merge_after ?? null,
      squash: value.squash ?? null,
      forceRemoveSourceBranch: value.force_remove_source_branch ?? null,
    };
  }
  async function locate(candidate, projectId, selected) {
    let n = selected ?? candidate.reviewNumber;
    if (n === null || n === undefined) {
      const matches = await pages(
        `/merge_requests?scope=all&state=opened&source_branch=${encodeURIComponent(candidate.sourceBranch)}&target_branch=${encodeURIComponent(candidate.targetBranch)}&per_page=100`,
      );
      ensure(matches.length === 1, 'ambiguous-review');
      n = number(matches[0].iid);
    }
    number(n);
    if (candidate.reviewNumber !== null) ensure(candidate.reviewNumber === n, 'changed-facts');
    return mergeRequest(await get(`/merge_requests/${n}`), candidate, n, projectId);
  }
  async function policy(p, n) {
    return {
      project: p,
      protections: await pages('/protected_branches?per_page=100'),
      config: await get('/approvals'),
      settings: await get('/merge_request_approval_setting'),
      approvals: await get(`/merge_requests/${n}/approval_state`),
    };
  }
  function supported(policies, candidate) {
    const { project: p, protections, config: c, settings: s, approvals: a } = policies;
    if (
      p.archived !== false ||
      p.merge_method !== 'merge' ||
      !['never', 'default_off'].includes(p.squash_option) ||
      p.only_allow_merge_if_pipeline_succeeds !== true ||
      ![
        'merge_pipelines_enabled',
        'merge_trains_enabled',
        'allow_merge_on_skipped_pipeline',
        'only_allow_merge_if_all_discussions_are_resolved',
        'only_allow_merge_if_all_status_checks_passed',
        'prevent_merge_without_jira_issue',
      ].every((key) => p[key] === false) ||
      !Array.isArray(p.compliance_frameworks) ||
      p.compliance_frameworks.length !== 0
    )
      return false;
    // Wildcard and inherited overlapping protection resolution is a separate lane.
    if (
      !Array.isArray(protections) ||
      protections.some((rule) => typeof rule.name !== 'string' || rule.name.includes('*'))
    )
      return false;
    const matching = protections.filter((rule) => rule.name === candidate.targetBranch);
    if (matching.length !== 1) return false;
    const protection = matching[0];
    if (
      protection.allow_force_push !== false ||
      protection.code_owner_approval_required !== false ||
      !Array.isArray(protection.merge_access_levels) ||
      !protection.merge_access_levels.length ||
      !Array.isArray(protection.push_access_levels) ||
      !protection.push_access_levels.length
    )
      return false;
    // Direct pushes could bypass this review lane. Unknown/custom access is blocked.
    if (
      !protection.push_access_levels.every(
        (v) => v.access_level === 0 && !v.user_id && !v.group_id && !v.deploy_key_id && !v.member_role_id,
      ) ||
      !protection.merge_access_levels.every((v) => [30, 40].includes(v.access_level) && !v.member_role_id)
    )
      return false;
    if (
      c?.reset_approvals_on_push !== true ||
      c.selective_code_owner_removals !== false ||
      ![
        'retain_approvals_on_push',
        'selective_code_owner_removals',
        'allow_overrides_to_approver_list_per_merge_request',
      ].every((key) => s?.[key]?.value === false) ||
      c.disable_overriding_approvers_per_merge_request !== true ||
      a?.approval_rules_overwritten !== false ||
      !Array.isArray(a.rules)
    )
      return false;
    const ids = new Set();
    return a.rules.every((r) => {
      if (!Number.isSafeInteger(r.id) || r.id <= 0 || ids.has(r.id)) return false;
      ids.add(r.id);
      return (
        r.rule_type === 'regular' &&
        r.contains_hidden_groups === false &&
        r.overridden === false &&
        Number.isSafeInteger(r.approvals_required) &&
        r.approvals_required >= 0 &&
        typeof r.approved === 'boolean' &&
        Array.isArray(r.eligible_approvers) &&
        Array.isArray(r.approved_by) &&
        [...r.eligible_approvers, ...r.approved_by].every((u) => Number.isSafeInteger(u.id) && u.id > 0)
      );
    });
  }
  async function observe(candidate) {
    target(candidate);
    const p = project(await get('')),
      first = await locate(candidate, p.id);
    const source = await get(`/repository/branches/${encodeURIComponent(candidate.sourceBranch)}`),
      base = await get(`/repository/branches/${encodeURIComponent(candidate.targetBranch)}`);
    ensure(
      source.name === candidate.sourceBranch &&
        source.commit?.id === candidate.headSha &&
        base.name === candidate.targetBranch,
      'changed-facts',
    );
    const baseSha = sha(base.commit?.id);
    let policies = null,
      checks = { policy: 'unknown', satisfied: null, evidenceDigest: hash({ unavailable: true }) },
      reviews = { ...checks };
    try {
      policies = await policy(p, first.number);
    } catch {
      policies = null;
    }
    if (policies && supported(policies, candidate)) {
      const ancestor = await get(`/repository/merge_base?refs[]=${baseSha}&refs[]=${candidate.headSha}`);
      const pipeline = first.pipeline;
      const canMerge =
        first.state === 'open' &&
        !first.draft &&
        first.canMerge &&
        first.status === 'mergeable' &&
        first.autoMerge === false &&
        first.mergeAfter === null &&
        first.squash === false &&
        first.forceRemoveSourceBranch === false;
      checks = {
        policy: 'known',
        satisfied: Boolean(
          canMerge &&
            base.protected === true &&
            ancestor.id === baseSha &&
            pipeline &&
            Number.isSafeInteger(pipeline.id) &&
            pipeline.id > 0 &&
            pipeline.project_id === p.id &&
            pipeline.sha === candidate.headSha &&
            pipeline.status === 'success',
        ),
        evidenceDigest: hash({ policies, first, ancestor, protected: base.protected ?? null }),
      };
      reviews = {
        policy: 'known',
        satisfied: policies.approvals.rules.every(
          (r) =>
            r.approved &&
            new Set(
              r.approved_by.filter((u) => r.eligible_approvers.some((e) => e.id === u.id)).map((u) => u.id),
            ).size >= r.approvals_required,
        ),
        evidenceDigest: hash({ policies, first }),
      };
    }
    const final = await locate(candidate, p.id, first.number),
      finalSource = await get(`/repository/branches/${encodeURIComponent(candidate.sourceBranch)}`),
      finalBase = await get(`/repository/branches/${encodeURIComponent(candidate.targetBranch)}`),
      finalProject = project(await get(''));
    ensure(
      hash(first) === hash(final) &&
        hash(p) === hash(finalProject) &&
        finalSource.name === candidate.sourceBranch &&
        finalSource.commit?.id === candidate.headSha &&
        finalBase.name === candidate.targetBranch &&
        finalBase.commit?.id === baseSha &&
        finalBase.protected === base.protected,
      'changed-facts',
    );
    if (policies) ensure(hash(await policy(finalProject, first.number)) === hash(policies), 'changed-facts');
    return plain({
      repositoryUrl: repository.url,
      sourceBranch: candidate.sourceBranch,
      targetBranch: candidate.targetBranch,
      headSha: candidate.headSha,
      baseSha,
      review: {
        number: first.number,
        state: first.state,
        url: first.url,
        headSha: candidate.headSha,
      },
      checks: { headSha: candidate.headSha, ...checks },
      reviews: { headSha: candidate.headSha, ...reviews },
      observedAt: timestamp(clock()),
    });
  }
  function operation(input) {
    const op = plain(input);
    target(op.candidate);
    ensure(op.action === 'merge');
    exact(op.payload, ['reviewNumber', 'mergeMethod']);
    number(op.payload.reviewNumber);
    ensure(op.payload.mergeMethod === 'merge');
    return op;
  }
  function receipt(op, result) {
    return plain({
      status: 'succeeded',
      operationDigest: op.digest,
      headSha: op.candidate.headSha,
      evidenceDigest: hash(result),
      resourceUrl: result.url,
      commitSha: result.commitSha,
    });
  }
  async function dispatch(input, context) {
    const op = operation(input),
      deadlineContext = plain(context);
    exact(deadlineContext, ['deadline']);
    const deadline = Date.parse(timestamp(deadlineContext.deadline));
    const timely = () => ensure(Date.parse(timestamp(clock())) < deadline, 'dispatch-expired');
    timely();
    const facts = await observe(op.candidate);
    ensure(
      ready(facts) &&
        facts.review.number === op.payload.reviewNumber &&
        factsDigest(facts) === op.factsDigest,
      'changed-facts',
    );
    const wireBody = createProviderWireBody({
      provider: 'gitlab',
      action: 'merge',
      resourceId: `${repository.fullName}#${op.payload.reviewNumber}`,
      expectedState: 'open',
      expectedVersion: op.candidate.headSha,
      idempotencyKey: op.digest,
      payload: {
        sha: op.candidate.headSha,
        squash: false,
        auto_merge: false,
        should_remove_source_branch: false,
      },
    });
    timely();
    const controller = new AbortController(),
      remaining = deadline - Date.parse(timestamp(clock()));
    ensure(remaining > 0, 'dispatch-expired');
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = (
        await http.request({
          method: 'PUT',
          path: `${root}/merge_requests/${op.payload.reviewNumber}/merge`,
          wireBody,
          signal: controller.signal,
        })
      ).data;
    } finally {
      clearTimeout(timer);
    }
    const p = project(await get('')),
      sent = mergeRequest(response, op.candidate, op.payload.reviewNumber, p.id);
    ensure(sent.state === 'merged', 'unverified-effect');
    const result = await locate(op.candidate, p.id, op.payload.reviewNumber);
    ensure(result.state === 'merged' && result.commitSha === sent.commitSha, 'unverified-effect');
    return receipt(op, result);
  }
  async function reconcile(input) {
    try {
      const op = operation(input),
        p = project(await get('')),
        result = await locate(op.candidate, p.id, op.payload.reviewNumber);
      return result.state === 'merged'
        ? { status: 'succeeded', receipt: receipt(op, result) }
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
  return createTrustedDeliveryExecutor({
    provider: 'gitlab',
    capabilities: [{ action: 'merge', conditionalHead: true, reconcile: true }],
    observe,
    dispatch,
    reconcile,
  });
}
