import { createProviderHttpClient } from '../adapters/http.js';
import { captureRecord, createProviderWireBody } from '../adapters/contract.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { digest, ensure, exact, factsDigest, hash, id, plain, sha, timestamp, validateCandidate, validateReceipt } from './contract.js';

export function deploymentPayload(config) {
  const value = plain(config);
  exact(value, ['providerId', 'workflow', 'environment', 'productionEnvironment']);
  id(value.providerId);
  ensure(typeof value.workflow === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.ya?ml$/.test(value.workflow));
  ensure(typeof value.environment === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.environment));
  ensure(typeof value.productionEnvironment === 'boolean');
  return plain({ workflow: value.workflow, environment: value.environment, productionEnvironment: value.productionEnvironment });
}

// The configured project workflow is trusted to perform deployment and verify its
// result. GitHub run success proves that workflow's result, not generic app health.
export function createGithubDeploymentExecutor(inputConfig) {
  const input = captureRecord(inputConfig,
    new Set(['repository', 'deployment', 'mergeReceipt', 'transport', 'headers', 'clock', 'timeoutMs']),
    ['repository', 'deployment', 'mergeReceipt', 'transport'], 'invalid-config');
  const supplied = plain(input.repository), repository = parseRepositoryRemote(supplied.url);
  ensure(repository.provider === 'github' && hash(repository) === hash(supplied));
  const payload = deploymentPayload(input.deployment), merged = plain(input.mergeReceipt);
  validateReceipt(merged, {action: 'merge', digest: digest(merged.operationDigest), candidate: {headSha: sha(merged.headSha)}});
  const prPrefix = `${repository.url}/pull/`;
  ensure(merged.resourceUrl.startsWith(prPrefix));
  const pullNumber = Number(merged.resourceUrl.slice(prPrefix.length));
  ensure(Number.isSafeInteger(pullNumber) && pullNumber > 0 && pullNumber <= 1_000_000_000
    && merged.resourceUrl === `${prPrefix}${pullNumber}`);
  const clock = input.clock ?? (() => new Date().toISOString());
  ensure(typeof clock === 'function');
  const http = createProviderHttpClient({provider: 'github', baseUrl: 'https://api.github.com', transport: input.transport,
    ...(input.headers === undefined ? {} : {headers: input.headers}),
    ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs})});
  const root = `/repos/${repository.fullName}`;
  const get = async path => (await http.request({method: 'GET', path: root + path})).data;
  const pages = path => http.paginate({path: root + path, identityKey: 'id'});
  function target(candidate) {
    validateCandidate(candidate);
    ensure(hash(candidate.repository) === hash(repository) && candidate.headSha === merged.headSha, 'changed-facts');
    ensure(candidate.reviewNumber === null || candidate.reviewNumber === pullNumber, 'changed-facts');
  }
  async function workflow() {
    const value = await get(`/actions/workflows/${encodeURIComponent(payload.workflow)}`);
    ensure(Number.isSafeInteger(value?.id) && value.id > 0 && value.state === 'active'
      && value.path === `.github/workflows/${payload.workflow}`, 'changed-facts');
    const file = await get(`/contents/.github/workflows/${encodeURIComponent(payload.workflow)}?ref=${merged.commitSha}`);
    ensure(file?.type === 'file' && file.path === value.path, 'changed-facts');
    return {id: value.id, path: value.path, blobSha: sha(file.sha), state: value.state};
  }
  async function observe(candidate) {
    target(candidate);
    const pull = await get(`/pulls/${pullNumber}`);
    ensure(pull?.number === pullNumber && pull.state === 'closed' && pull.merged === true
      && pull.merge_commit_sha === merged.commitSha && pull.html_url === merged.resourceUrl
      && pull.head?.sha === candidate.headSha && pull.head?.ref === candidate.sourceBranch
      && pull.head?.repo?.full_name === repository.fullName && pull.base?.ref === candidate.targetBranch
      && pull.base?.repo?.full_name === repository.fullName, 'changed-facts');
    const configured = await workflow();
    const evidence = hash({workflow: configured, payload, mergeReceipt: merged});
    return plain({repositoryUrl: repository.url, sourceBranch: candidate.sourceBranch, targetBranch: candidate.targetBranch,
      headSha: candidate.headSha, baseSha: sha(pull.base.sha),
      review: {number: pullNumber, state: 'merged', url: merged.resourceUrl, headSha: candidate.headSha},
      checks: {headSha: candidate.headSha, policy: 'unknown', satisfied: null, evidenceDigest: evidence},
      reviews: {headSha: candidate.headSha, policy: 'unknown', satisfied: null, evidenceDigest: evidence},
      observedAt: timestamp(clock())});
  }
  function operation(input) {
    const op = plain(input);
    target(op.candidate);
    digest(op.digest);
    ensure(op.action === 'deploy' && hash(op.payload) === hash(payload) && hash(op.mergeReceipt) === hash(merged), 'changed-facts');
    return op;
  }
  async function reconcile(input) {
    try {
      const op = operation(input), configured = await workflow();
      const matches = (await pages(`/deployments?sha=${merged.commitSha}&task=rivet-deploy&environment=${encodeURIComponent(payload.environment)}&per_page=100`))
        .filter(item => item?.payload?.rivetOperation === op.digest);
      ensure(matches.length === 1, 'unverified-effect');
      const deployment = matches[0];
      ensure(Number.isSafeInteger(deployment.id) && deployment.id > 0 && deployment.sha === merged.commitSha
        && deployment.ref === merged.commitSha && deployment.task === 'rivet-deploy'
        && deployment.environment === payload.environment && deployment.production_environment === payload.productionEnvironment
        && deployment.transient_environment === false && deployment.repository_url === `https://api.github.com${root}`
        && deployment.payload.workflow === payload.workflow, 'unverified-effect');
      exact(deployment.payload, ['rivetOperation', 'workflow']);
      const statuses = await pages(`/deployments/${deployment.id}/statuses?per_page=100`);
      ensure(statuses.length > 0 && statuses.every(item => Number.isSafeInteger(item.id) && item.id > 0), 'unverified-effect');
      const latest = statuses.reduce((a,b) => a.id > b.id ? a : b);
      ensure(latest.state === 'success' && latest.environment === payload.environment, 'unverified-effect');
      const runPrefix = `${repository.url}/actions/runs/`, runId = Number(String(latest.log_url).slice(runPrefix.length));
      ensure(Number.isSafeInteger(runId) && runId > 0 && latest.log_url === `${runPrefix}${runId}`, 'unverified-effect');
      const run = await get(`/actions/runs/${runId}`);
      ensure(run?.id === runId && run.status === 'completed' && run.conclusion === 'success'
        && run.head_sha === merged.commitSha && run.workflow_id === configured.id && run.event === 'deployment'
        && run.repository?.full_name === repository.fullName && run.display_title === `rivet-deploy:${op.digest}`
        && run.html_url === latest.log_url, 'unverified-effect');
      return {status: 'succeeded', receipt: plain({status: 'succeeded', operationDigest: op.digest,
        headSha: op.candidate.headSha, commitSha: merged.commitSha, resourceUrl: run.html_url,
        evidenceDigest: hash({deployment, latest, run, workflow: configured})})};
    } catch {
      return {status: 'unknown'};
    }
  }
  async function dispatch(input, context) {
    const op = operation(input), ctx = plain(context);
    exact(ctx, ['deadline']);
    const deadline = Date.parse(timestamp(ctx.deadline));
    const timely = () => ensure(Date.parse(timestamp(clock())) < deadline, 'dispatch-expired');
    timely();
    ensure(factsDigest(await observe(op.candidate)) === op.factsDigest, 'changed-facts');
    const wireBody = createProviderWireBody({provider: 'github', action: 'deploy', resourceId: repository.fullName,
      expectedState: 'merged', expectedVersion: merged.commitSha, idempotencyKey: op.digest,
      payload: {ref: merged.commitSha, auto_merge: false, task: 'rivet-deploy', environment: payload.environment,
        production_environment: payload.productionEnvironment, transient_environment: false,
        payload: {rivetOperation: op.digest, workflow: payload.workflow}}});
    timely();
    const controller = new AbortController(), remaining = deadline - Date.parse(timestamp(clock()));
    ensure(remaining > 0, 'dispatch-expired');
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      await http.request({method: 'POST', path: `${root}/deployments`, wireBody, signal: controller.signal});
    } finally { clearTimeout(timer); }
    const result = await reconcile(op);
    ensure(result.status === 'succeeded', 'unverified-effect');
    return result.receipt;
  }
  return createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'deploy',conditionalHead:true,reconcile:true}],observe,dispatch,reconcile});
}
