import { captureRecord, createProviderWireBody } from '../adapters/contract.js';
import { createProviderHttpClient } from '../adapters/http.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { digest, ensure, exact, factsDigest, hash, plain, sha, timestamp, validateCandidate } from './contract.js';

export function reviewRequestPayload(candidate) {
  validateCandidate(candidate);
  return plain({
    title: `Rivet: ${candidate.runId}`,
    body: ['Rivet verified delivery candidate', '', `Run: ${candidate.runId}`,
      `Source branch: ${candidate.sourceBranch}`, `Target branch: ${candidate.targetBranch}`,
      `Verified commit: ${candidate.headSha}`, `Verification evidence: ${candidate.localVerification.evidenceDigest}`,
      '', 'Review the changes and repository checks before making a separate merge decision.'].join('\n'),
  });
}

export function reviewRequestContent(operation) {
  ensure(operation.action === 'review-request');
  digest(operation.digest);
  const payload = plain(operation.payload);
  exact(payload, ['title', 'body']);
  ensure(typeof payload.title === 'string' && payload.title.trim() === payload.title && payload.title.length >= 1
    && payload.title.length <= 256 && !/[\u0000-\u001f\u007f]/.test(payload.title));
  ensure(typeof payload.body === 'string' && payload.body.length >= 1 && payload.body.length <= 32000
    && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(payload.body)
    && !payload.body.includes('rivet-review-operation:'));
  return plain({ title: payload.title, body: `${payload.body}\n\n<!-- rivet-review-operation:${operation.digest} -->` });
}

// These APIs accept branch names, not an atomic expected-head condition. The
// executor advertises that limitation and verifies the created review afterward.
export function createReviewRequestExecutor(kind, inputConfig) {
  ensure(['github', 'gitlab'].includes(kind));
  const input = captureRecord(inputConfig, new Set(['repository', 'transport', 'headers', 'clock', 'timeoutMs']), ['repository', 'transport'], 'invalid-config');
  const supplied = plain(input.repository), repository = parseRepositoryRemote(supplied.url);
  ensure(repository.provider === kind && hash(repository) === hash(supplied));
  const github = kind === 'github';
  const clock = input.clock ?? (() => new Date().toISOString());
  ensure(typeof clock === 'function');
  const http = createProviderHttpClient({ provider: kind, baseUrl: github ? 'https://api.github.com' : 'https://gitlab.com/api/v4',
    transport: input.transport, ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), allowEncodedSlash: true });
  const root = github ? `/repos/${repository.fullName}` : `/projects/${encodeURIComponent(repository.fullName)}`;
  const reviewsPath = github ? '/pulls' : '/merge_requests';
  const get = async path => (await http.request({ method: 'GET', path: root + path })).data;
  function number(value) { ensure(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000, 'changed-facts'); return value; }
  function repositoryId(value) { ensure(Number.isSafeInteger(value) && value > 0, 'changed-facts'); return value; }
  function target(value) { validateCandidate(value); ensure(hash(value.repository) === hash(repository), 'provider-mismatch'); }
  function identity(value) {
    ensure((github ? value.full_name : value.path_with_namespace) === repository.fullName
      && (github ? value.html_url : value.web_url) === repository.url && value.archived === false, 'changed-facts');
    return { id: repositoryId(value.id), fullName: repository.fullName, url: repository.url };
  }
  function review(value, candidate, project) {
    const n = number(github ? value.number : value.iid);
    ensure((github ? ['open', 'closed'] : ['opened', 'closed', 'merged']).includes(value.state)
      && typeof value.draft === 'boolean', 'changed-facts');
    const url = github ? value.html_url : value.web_url;
    ensure(url === `${repository.url}/${github ? 'pull' : '-/merge_requests'}/${n}`, 'changed-facts');
    if (github) {
      ensure(typeof value.merged === 'boolean'
        && value.head?.repo?.id === project.id && value.base?.repo?.id === project.id
        && value.head?.repo?.full_name === repository.fullName && value.base?.repo?.full_name === repository.fullName
        && value.head?.ref === candidate.sourceBranch && value.base?.ref === candidate.targetBranch
        && value.head?.sha === candidate.headSha, 'changed-facts');
      sha(value.base.sha);
    } else ensure(value.project_id === project.id && value.source_project_id === project.id && value.target_project_id === project.id
      && value.source_branch === candidate.sourceBranch && value.target_branch === candidate.targetBranch
      && value.sha === candidate.headSha, 'changed-facts');
    ensure(typeof value.title === 'string' && typeof (github ? value.body : value.description) === 'string', 'changed-facts');
    return plain({ number: n, state: github ? (value.merged ? 'merged' : value.state) : value.state === 'opened' ? 'open' : value.state,
      draft: value.draft, url, headSha: candidate.headSha, title: value.title, body: github ? value.body : value.description });
  }
  async function branches(candidate) {
    const project = identity(await get(''));
    const branch = async name => {
      let value;
      try { value = await get(`${github ? '' : '/repository'}/branches/${encodeURIComponent(name)}`); }
      catch (error) {
        if (error?.status === 404) {
          const failure = new Error('Publish the verified source branch and ensure the target branch exists before requesting review.');
          failure.code = 'ERR_DELIVERY_BRANCH_NOT_PUBLISHED'; failure.safeMessage = failure.message; throw failure;
        }
        throw error;
      }
      ensure(value.name === name, 'changed-facts');
      return sha(github ? value.commit?.sha : value.commit?.id);
    };
    const headSha = await branch(candidate.sourceBranch), baseSha = await branch(candidate.targetBranch);
    ensure(headSha === candidate.headSha, 'changed-facts');
    return { project, headSha, baseSha };
  }
  async function listed(candidate) {
    const query = github
      ? `state=all&head=${encodeURIComponent(repository.namespace + ':' + candidate.sourceBranch)}&base=${encodeURIComponent(candidate.targetBranch)}`
      : `state=all&source_branch=${encodeURIComponent(candidate.sourceBranch)}&target_branch=${encodeURIComponent(candidate.targetBranch)}`;
    return http.paginate({ path: `${root}${reviewsPath}?${query}&per_page=100`, identityKey: github ? 'number' : 'id' });
  }
  async function observe(candidate) {
    target(candidate);
    const before = await branches(candidate), rows = await listed(candidate);
    ensure(rows.length <= 1, 'ambiguous-review');
    let existing = null;
    if (rows.length) {
      const selected = number(github ? rows[0].number : rows[0].iid);
      existing = review(await get(`${reviewsPath}/${selected}`), candidate, before.project);
      ensure(existing.number === selected, 'changed-facts');
      if (candidate.reviewNumber !== null) ensure(existing.number === candidate.reviewNumber, 'changed-facts');
    } else ensure(candidate.reviewNumber === null, 'changed-facts');
    ensure(hash(await branches(candidate)) === hash(before), 'changed-facts');
    return facts(candidate, before, existing);
  }
  function facts(candidate, before, existing) {
    const unknown = { headSha: candidate.headSha, policy: 'unknown', satisfied: null, evidenceDigest: hash({ before, existing }) };
    return plain({ repositoryUrl: repository.url, sourceBranch: candidate.sourceBranch, targetBranch: candidate.targetBranch,
      headSha: candidate.headSha, baseSha: before.baseSha,
      review: existing ? { number: existing.number, state: existing.state, url: existing.url, headSha: candidate.headSha } : null,
      checks: unknown, reviews: unknown, observedAt: timestamp(clock()) });
  }
  function operation(value) {
    const op = plain(value); target(op.candidate); digest(op.digest); digest(op.factsDigest);
    ensure(op.action === 'review-request' && op.candidate.reviewNumber === null, 'unsupported-action');
    reviewRequestContent(op);
    return op;
  }
  function verified(value, op, project) {
    const result = review(value, op.candidate, project), expected = reviewRequestContent(op);
    ensure(!result.draft && result.title === expected.title && result.body === expected.body, 'unverified-effect');
    return result;
  }
  function receipt(op, result) {
    return plain({ status: 'succeeded', operationDigest: op.digest, headSha: op.candidate.headSha,
      evidenceDigest: hash(result), resourceUrl: result.url, commitSha: null });
  }
  async function findMarked(op, project) {
    const marker = `<!-- rivet-review-operation:${op.digest} -->`;
    const matches = (await listed(op.candidate)).filter(row => (github ? row.body : row.description)?.includes(marker));
    ensure(matches.length === 1, 'ambiguous-review');
    const selected = number(github ? matches[0].number : matches[0].iid);
    const result = verified(await get(`${reviewsPath}/${selected}`), op, project);
    ensure(result.number === selected, 'changed-facts');
    return result;
  }
  async function dispatch(value, context) {
    const op = operation(value), limits = plain(context); exact(limits, ['deadline']);
    const deadline = Date.parse(timestamp(limits.deadline));
    const timely = () => ensure(Date.parse(timestamp(clock())) < deadline, 'dispatch-expired');
    timely();
    const facts = await observe(op.candidate);
    ensure(facts.review === null && factsDigest(facts) === op.factsDigest, 'changed-facts');
    const content = reviewRequestContent(op);
    const payload = github ? { title: content.title, body: content.body, head: op.candidate.sourceBranch, base: op.candidate.targetBranch, draft: false, maintainer_can_modify: false }
      : { title: content.title, description: content.body, source_branch: op.candidate.sourceBranch, target_branch: op.candidate.targetBranch, remove_source_branch: false, squash: false };
    const wireBody = createProviderWireBody({ provider: kind, action: 'review-request', resourceId: repository.fullName,
      expectedState: 'absent', expectedVersion: op.candidate.headSha, idempotencyKey: op.digest, payload });
    timely();
    const controller = new AbortController(), remaining = deadline - Date.parse(timestamp(clock()));
    ensure(remaining > 0, 'dispatch-expired');
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try { response = await http.request({ method: 'POST', path: root + reviewsPath, wireBody, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    ensure(response.status === 201, 'unverified-effect');
    const after = await branches(op.candidate);
    ensure(hash({ before: after, existing: null }) === facts.checks.evidenceDigest, 'changed-facts');
    const sent = verified(response.data, op, after.project);
    ensure(sent.state === 'open', 'unverified-effect');
    const result = await findMarked(op, after.project);
    ensure(hash(sent) === hash(result) && hash(await branches(op.candidate)) === hash(after), 'changed-facts');
    return receipt(op, result);
  }
  async function reconcile(value) {
    try {
      const op = operation(value), before = await branches(op.candidate);
      ensure(factsDigest(facts(op.candidate, before, null)) === op.factsDigest, 'changed-facts');
      const result = await findMarked(op, before.project);
      ensure(hash(await branches(op.candidate)) === hash(before), 'changed-facts');
      return { status: 'succeeded', receipt: receipt(op, result) };
    } catch { return { status: 'unknown' }; }
  }
  return createTrustedDeliveryExecutor({ provider: kind,
    capabilities: [{ action: 'review-request', conditionalHead: false, verifiesCreatedReview: true, reconcile: true }], observe, dispatch, reconcile });
}
