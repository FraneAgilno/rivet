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

// GitHub atomically conditions merge on the head SHA only. Target ref and policy
// are rechecked, but concurrent administrative changes are outside this guarantee.
export function createGithubDeliveryExecutor(inputConfig) {
  const input = captureRecord(
    inputConfig,
    new Set(['repository', 'transport', 'headers', 'clock', 'timeoutMs']),
    ['repository', 'transport'],
    'invalid-config'
  );
  const supplied = plain(input.repository);
  const repository = parseRepositoryRemote(supplied.url);
  ensure(repository.provider === 'github' && hash(repository) === hash(supplied));
  const clock = input.clock ?? (() => new Date().toISOString());
  ensure(typeof clock === 'function');
  const http = createProviderHttpClient({
    provider: 'github',
    baseUrl: 'https://api.github.com',
    transport: input.transport,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    allowEncodedSlash: true,
  });
  const root = `/repos/${repository.fullName}`;
  const get = async (path) => (await http.request({ method: 'GET', path: root + path })).data;
  const pages = (path, options = {}) => http.paginate({ path: root + path, ...options });
  function target(value) {
    validateCandidate(value);
    ensure(hash(value.repository) === hash(repository), 'provider-mismatch');
  }
  function number(value) {
    ensure(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000);
    return value;
  }
  function pull(value, candidate, expected) {
    ensure(
      value?.number === expected &&
        ['open', 'closed'].includes(value.state) &&
        typeof value.merged === 'boolean' &&
        typeof value.draft === 'boolean',
      'changed-facts'
    );
    ensure(
      value.head?.sha === candidate.headSha &&
        value.head?.ref === candidate.sourceBranch &&
        value.head?.repo?.full_name === repository.fullName &&
        value.base?.ref === candidate.targetBranch &&
        value.base?.repo?.full_name === repository.fullName &&
        value.html_url === `${repository.url}/pull/${expected}`,
      'changed-facts'
    );
    sha(value.base.sha);
    return {
      number: expected,
      state: value.merged ? 'merged' : value.state,
      url: value.html_url,
      headSha: value.head.sha,
      baseSha: value.base.sha,
      draft: value.draft,
      commitSha: value.merged ? sha(value.merge_commit_sha) : null,
    };
  }
  async function locate(candidate, selected) {
    let n = selected ?? candidate.reviewNumber;
    if (n === null || n === undefined) {
      const matches = await pages(
        `/pulls?state=open&head=${encodeURIComponent(repository.namespace + ':' + candidate.sourceBranch)}&base=${encodeURIComponent(candidate.targetBranch)}&per_page=100`,
        { identityKey: 'number' }
      );
      ensure(matches.length === 1, 'ambiguous-review');
      n = number(matches[0].number);
    }
    number(n);
    if (candidate.reviewNumber !== null) ensure(candidate.reviewNumber === n, 'changed-facts');
    return pull(await get(`/pulls/${n}`), candidate, n);
  }
  async function policy(candidate) {
    const branch = encodeURIComponent(candidate.targetBranch);
    const protection = await get(`/branches/${branch}/protection`);
    const rules = await pages(`/rules/branches/${branch}?per_page=100`);
    return { protection, rules };
  }
  function supported({ protection: p, rules }) {
    const known = new Set([
      'url',
      'required_status_checks',
      'enforce_admins',
      'required_pull_request_reviews',
      'restrictions',
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'required_conversation_resolution',
      'lock_branch',
      'allow_fork_syncing',
      'required_signatures',
    ]);
    if (p && Object.keys(p).some((key) => !known.has(key))) return false;
    if (
      !p ||
      !Array.isArray(rules) ||
      rules.length !== 0 ||
      p.enforce_admins?.enabled !== true ||
      p.required_conversation_resolution?.enabled === true ||
      p.lock_branch?.enabled === true
    )
      return false;
    const c = p.required_status_checks,
      r = p.required_pull_request_reviews;
    if (
      !c ||
      c.strict !== true ||
      !Array.isArray(c.checks) ||
      !Array.isArray(c.contexts) ||
      c.checks.length === 0 ||
      !r ||
      r.require_code_owner_reviews !== false ||
      r.require_last_push_approval !== false ||
      r.dismiss_stale_reviews !== true ||
      !Number.isSafeInteger(r.required_approving_review_count) ||
      r.required_approving_review_count < 0
    )
      return false;
    const bypass = r.bypass_pull_request_allowances;
    if (
      bypass &&
      !['users', 'teams', 'apps'].every((key) => Array.isArray(bypass[key]) && bypass[key].length === 0)
    )
      return false;
    if (
      !c.checks.every(
        (item) =>
          typeof item.context === 'string' &&
          item.context.length > 0 &&
          (item.app_id === null || (Number.isSafeInteger(item.app_id) && item.app_id >= -1))
      )
    )
      return false;
    return c.contexts.every((context) => c.checks.some((item) => item.context === context));
  }
  async function observe(candidate) {
    target(candidate);
    const first = await locate(candidate);
    const source = await get(`/branches/${encodeURIComponent(candidate.sourceBranch)}`);
    const base = await get(`/branches/${encodeURIComponent(candidate.targetBranch)}`);
    ensure(
      source.name === candidate.sourceBranch &&
        source.commit?.sha === candidate.headSha &&
        base.name === candidate.targetBranch,
      'changed-facts'
    );
    const baseSha = sha(base.commit?.sha);
    ensure(first.baseSha === baseSha, 'changed-facts');
    let policies,
      checks = { policy: 'unknown', satisfied: null, evidenceDigest: hash({ unavailable: true }) },
      reviews = { ...checks };
    try {
      policies = await policy(candidate);
    } catch {
      policies = null;
    }
    if (policies && supported(policies)) {
      const comparison = await get(`/compare/${baseSha}...${candidate.headSha}`);
      const runs = await pages(`/commits/${candidate.headSha}/check-runs?per_page=100`, {
        itemsKey: 'check_runs',
        identityKey: 'id',
        totalKey: 'total_count',
      });
      const statuses = await pages(`/commits/${candidate.headSha}/statuses?per_page=100`, {
        identityKey: 'id',
      });
      for (const run of runs)
        ensure(
          Number.isSafeInteger(run.id) &&
            run.id > 0 &&
            run.head_sha === candidate.headSha &&
            typeof run.name === 'string' &&
            typeof run.status === 'string',
          'invalid-provider-evidence'
        );
      for (const status of statuses)
        ensure(
          Number.isSafeInteger(status.id) &&
            status.id > 0 &&
            typeof status.context === 'string' &&
            ['success', 'failure', 'error', 'pending'].includes(status.state),
          'invalid-provider-evidence'
        );
      const latest = (items) => items.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
      const checkPass = policies.protection.required_status_checks.checks.every((required) => {
        const appBound = required.app_id !== null && required.app_id !== -1;
        const matchingRuns = runs.filter(
          (item) => item.name === required.context && (!appBound || item.app?.id === required.app_id)
        );
        const status = latest(statuses.filter((item) => item.context === required.context));
        const runPass =
          matchingRuns.length > 0 &&
          matchingRuns.every(
            (run) => run.status === 'completed' && ['success', 'neutral', 'skipped'].includes(run.conclusion)
          );
        // A context reported by both APIs must pass both. Legacy statuses cannot
        // establish an app-bound requirement without the matching check run.
        return appBound
          ? Boolean(runPass && (!status || status.state === 'success'))
          : Boolean(
              (matchingRuns.length > 0 || status) &&
                (matchingRuns.length === 0 || runPass) &&
                (!status || status.state === 'success')
            );
      });
      const reviewItems = await pages(`/pulls/${first.number}/reviews?per_page=100`, { identityKey: 'id' });
      const effective = new Map();
      for (const item of reviewItems) {
        ensure(
          Number.isSafeInteger(item.id) &&
            item.id > 0 &&
            typeof item.user?.login === 'string' &&
            /^[A-Za-z0-9-]{1,100}$/.test(item.user.login) &&
            ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state),
          'invalid-provider-evidence'
        );
        if (['PENDING', 'COMMENTED'].includes(item.state)) continue;
        const prior = effective.get(item.user.login);
        if (!prior || item.id > prior.id) effective.set(item.user.login, item);
      }
      let approvals = 0,
        blocked = false;
      const eligibility = [];
      for (const [login, item] of [...effective].sort(([a], [b]) => a.localeCompare(b))) {
        if (item.state === 'CHANGES_REQUESTED') blocked = true;
        if (item.state !== 'APPROVED' || item.commit_id !== candidate.headSha) continue;
        const permission = await get(`/collaborators/${encodeURIComponent(login)}/permission`);
        ensure(
          permission.user?.login === login && typeof permission.permission === 'string',
          'invalid-provider-evidence'
        );
        eligibility.push({ login, permission: permission.permission });
        if (['admin', 'write', 'maintain'].includes(permission.permission)) approvals++;
      }
      const consistent =
        comparison.merge_base_commit?.sha === baseSha && ['ahead', 'identical'].includes(comparison.status);
      checks = {
        policy: 'known',
        satisfied: !first.draft && first.state === 'open' && consistent && checkPass,
        evidenceDigest: hash({
          policies,
          runs,
          statuses,
          comparison: { status: comparison.status, base: comparison.merge_base_commit?.sha },
        }),
      };
      reviews = {
        policy: 'known',
        satisfied:
          !blocked &&
          approvals >= policies.protection.required_pull_request_reviews.required_approving_review_count,
        evidenceDigest: hash({ policies, reviewItems, eligibility }),
      };
    }
    const final = await locate(candidate, first.number);
    const finalSource = await get(`/branches/${encodeURIComponent(candidate.sourceBranch)}`),
      finalBase = await get(`/branches/${encodeURIComponent(candidate.targetBranch)}`);
    ensure(
      hash(first) === hash(final) &&
        finalSource.name === candidate.sourceBranch &&
        finalBase.name === candidate.targetBranch &&
        finalSource.commit?.sha === candidate.headSha &&
        finalBase.commit?.sha === baseSha,
      'changed-facts'
    );
    if (policies) ensure(hash(await policy(candidate)) === hash(policies), 'changed-facts');
    return plain({
      repositoryUrl: repository.url,
      sourceBranch: candidate.sourceBranch,
      targetBranch: candidate.targetBranch,
      headSha: candidate.headSha,
      baseSha,
      review: { number: first.number, state: first.state, url: first.url, headSha: candidate.headSha },
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
    ensure(['merge', 'squash', 'rebase'].includes(op.payload.mergeMethod));
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
    const op = operation(input);
    const deadlineContext = plain(context);
    exact(deadlineContext, ['deadline']);
    const deadline = Date.parse(timestamp(deadlineContext.deadline));
    const timely = () => ensure(Date.parse(timestamp(clock())) < deadline, 'dispatch-expired');
    timely();
    const facts = await observe(op.candidate);
    ensure(
      ready(facts) &&
        facts.review.number === op.payload.reviewNumber &&
        factsDigest(facts) === op.factsDigest,
      'changed-facts'
    );
    const wireBody = createProviderWireBody({
      provider: 'github',
      action: 'merge',
      resourceId: `${repository.fullName}#${op.payload.reviewNumber}`,
      expectedState: 'open',
      expectedVersion: op.candidate.headSha,
      idempotencyKey: op.digest,
      payload: { sha: op.candidate.headSha, merge_method: op.payload.mergeMethod },
    });
    timely();
    const controller = new AbortController();
    const remaining = deadline - Date.parse(timestamp(clock()));
    ensure(remaining > 0, 'dispatch-expired');
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = (await http.request({
        method: 'PUT',
        path: `${root}/pulls/${op.payload.reviewNumber}/merge`,
        wireBody,
        signal: controller.signal,
      })).data;
    } finally {
      clearTimeout(timer);
    }
    ensure(response?.merged === true, 'unverified-effect');
    sha(response.sha);
    const result = await locate(op.candidate, op.payload.reviewNumber);
    ensure(result.state === 'merged' && result.commitSha === response.sha, 'unverified-effect');
    return receipt(op, result);
  }
  async function reconcile(input) {
    try {
      const op = operation(input),
        result = await locate(op.candidate, op.payload.reviewNumber);
      return result.state === 'merged'
        ? { status: 'succeeded', receipt: receipt(op, result) }
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
  return createTrustedDeliveryExecutor({
    provider: 'github',
    capabilities: [{ action: 'merge', conditionalHead: true, reconcile: true }],
    observe,
    dispatch,
    reconcile,
  });
}
