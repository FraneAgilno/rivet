import {
  boundedString,
  captureRecord,
  createAdapter,
  createProviderWriteGovernance,
  createProviderWireBody,
  createSourceEnvelope,
  executeGovernedWrite,
  executeTrustedConditionalMutation,
  failProvider,
  providerTimestamp,
  sanitizeReferenceUrl,
  validateTrustedConditionalMutationCapability,
} from './contract.js';
import { createProviderHttpClient } from './http.js';

const READ = Object.freeze(['repo', 'branch', 'pull', 'checks', 'reviews', 'artifacts', 'delivery']);
const WRITE = Object.freeze(['pr', 'comment']);
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA = /^[a-f0-9]{40}$/;

function identity(ownerInput, repoInput) {
  return {
    owner: boundedString(ownerInput, 100, NAME),
    repo: boundedString(repoInput, 100, NAME),
  };
}

function repoPath(owner, repo) { return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`; }

function remoteFailure() { failProvider('remote', { provider: 'github', retryClassification: 'permanent' }); }

function boundRemoteUrl(value, origin, pathname, fragmentPattern) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== origin || url.pathname !== pathname
      || (fragmentPattern ? !fragmentPattern.test(url.hash) : Boolean(url.hash))) remoteFailure();
    url.hash = '';
    return sanitizeReferenceUrl(url.href);
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validId(value) { return Number.isSafeInteger(value) && value > 0; }

function validRef(value) { return typeof value === 'string' && REF.test(value) && !value.includes('..') && !value.includes('//'); }

function validateRepository(value, expected, context) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)
      || value.full_name !== expected || !validRef(value.default_branch)
      || typeof value.private !== 'boolean' || typeof value.html_url !== 'string') remoteFailure();
    boundRemoteUrl(value.html_url, context.webOrigin, `/${expected}`);
    if (value.url !== undefined) boundRemoteUrl(value.url, context.apiOrigin, `${context.apiPrefix}/repos/${expected}`);
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validateBranch(value, expected) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== expected
      || !value.commit || typeof value.commit !== 'object' || Array.isArray(value.commit)
      || typeof value.commit.sha !== 'string' || !SHA.test(value.commit.sha) || typeof value.protected !== 'boolean') remoteFailure();
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validatePull(value, number, context, full = true) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.number !== number
      || !['open', 'closed'].includes(value.state)) remoteFailure();
    if (full && (!value.head || typeof value.head !== 'object' || Array.isArray(value.head) || !SHA.test(value.head.sha)
      || !value.base || typeof value.base !== 'object' || Array.isArray(value.base) || !validRef(value.base.ref)
      || !SHA.test(value.base.sha) || typeof value.html_url !== 'string')) remoteFailure();
    if (full) boundRemoteUrl(value.html_url, context.webOrigin, `/${context.owner}/${context.repo}/pull/${number}`);
    if (value.url !== undefined) boundRemoteUrl(value.url, context.apiOrigin,
      `${context.apiPrefix}/repos/${context.owner}/${context.repo}/pulls/${number}`);
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validateChecks(value, context) {
  try {
    if (!Array.isArray(value)) remoteFailure();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id)
        || typeof item.name !== 'string' || item.name.length === 0
        || !['queued', 'in_progress', 'completed', 'pending', 'requested', 'waiting'].includes(item.status)
        || (item.conclusion !== null && !['action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out'].includes(item.conclusion))) remoteFailure();
      if (item.html_url !== undefined) boundRemoteUrl(item.html_url, context.webOrigin, `/${context.owner}/${context.repo}/runs/${item.id}`);
      if (item.url !== undefined) boundRemoteUrl(item.url, context.apiOrigin,
        `${context.apiPrefix}/repos/${context.owner}/${context.repo}/check-runs/${item.id}`);
    }
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validateReviews(value, context) {
  try {
    if (!Array.isArray(value)) remoteFailure();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id)
        || !['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state)
        || !item.user || typeof item.user !== 'object' || Array.isArray(item.user)
        || typeof item.user.login !== 'string' || item.user.login.length === 0) remoteFailure();
      if (item.html_url !== undefined) boundRemoteUrl(item.html_url, context.webOrigin,
        `/${context.owner}/${context.repo}/pull/${context.pullNumber}`, new RegExp(`^#pullrequestreview-${item.id}$`));
      if (item.url !== undefined) boundRemoteUrl(item.url, context.apiOrigin,
        `${context.apiPrefix}/repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}/reviews/${item.id}`);
    }
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validateArtifacts(value, context) {
  try {
    if (!Array.isArray(value)) remoteFailure();
    for (const item of value) if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id)
      || typeof item.name !== 'string' || item.name.length === 0 || typeof item.expired !== 'boolean'
      || typeof item.archive_download_url !== 'string') remoteFailure();
    else {
      const url = new URL(item.archive_download_url);
      const prefix = `${context.apiPrefix}/repos/${context.owner}/${context.repo}/actions/artifacts/${item.id}/`;
      if (!url.pathname.startsWith(prefix) || !/^(?:zip|tarball)$/.test(url.pathname.slice(prefix.length))) remoteFailure();
      boundRemoteUrl(item.archive_download_url, context.apiOrigin, url.pathname);
      if (item.url !== undefined) boundRemoteUrl(item.url, context.apiOrigin,
        `${context.apiPrefix}/repos/${context.owner}/${context.repo}/actions/artifacts/${item.id}`);
    }
    return value;
  } catch (error) { if (error?.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function normalizeRepository(value) {
  return {
    id: value?.id ?? null, fullName: String(value?.full_name ?? ''), defaultBranch: String(value?.default_branch ?? ''),
    private: value.private, url: sanitizeReferenceUrl(value.html_url),
  };
}

function normalizeBranch(value) {
  return { name: String(value?.name ?? ''), commitSha: String(value?.commit?.sha ?? ''), protected: value?.protected === true };
}

function normalizePull(value) {
  return {
    number: value.number, state: value.state, title: String(value.title ?? ''),
    headSha: value.head.sha, baseBranch: value.base.ref, baseSha: value.base.sha, url: sanitizeReferenceUrl(value.html_url),
  };
}

export function createGithubAdapter(input) {
  const config = captureRecord(input, new Set([
    'transport', 'baseUrl', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'maxItems', 'clock', 'governance', 'conditionalMutation',
  ]), ['transport', 'baseUrl'], 'invalid-config');
  const now = config.clock ?? (() => new Date().toISOString());
  if (typeof now !== 'function') failProvider('invalid-config', { provider: 'github' });
  const http = createProviderHttpClient({
    provider: 'github', baseUrl: config.baseUrl, transport: config.transport,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
    ...(config.maxItems === undefined ? {} : { maxItems: config.maxItems }),
  });
  const governance = config.governance === undefined ? null : createProviderWriteGovernance(config.governance, 'github');
  const conditionalMutation = config.conditionalMutation;
  if (governance && !validateTrustedConditionalMutationCapability(conditionalMutation, 'github', ['comment'])) failProvider('invalid-config', { provider: 'github' });
  const apiOrigin = new URL(http.baseUrl).origin;
  const apiPrefix = new URL(http.baseUrl).pathname.replace(/\/$/, '');
  const webOrigin = new URL(apiOrigin).hostname === 'api.github.com' ? 'https://github.com' : apiOrigin;

  async function read(inputRead) {
    const request = captureRecord(inputRead, new Set([
      'kind', 'owner', 'repo', 'branch', 'pullNumber', 'commitSha', 'signal',
    ]), ['kind', 'owner', 'repo']);
    const kind = boundedString(request.kind, 16, /^(?:repo|branch|pull|checks|reviews|artifacts|delivery)$/);
    const { owner, repo } = identity(request.owner, request.repo);
    const context = { owner, repo, apiOrigin, apiPrefix, webOrigin, pullNumber: request.pullNumber };
    const root = repoPath(owner, repo);
    const signal = request.signal === undefined ? {} : { signal: request.signal };
    const raw = {};
    if (kind === 'repo' || kind === 'delivery') {
      raw.repository = (await http.request({ method: 'GET', path: root, ...signal })).data;
      validateRepository(raw.repository, `${owner}/${repo}`, context);
    }
    if (kind === 'branch' || kind === 'delivery') {
      const branch = boundedString(request.branch, 255, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
      if (branch.includes('..') || branch.includes('//')) failProvider('invalid-request', { provider: 'github' });
      raw.branch = (await http.request({ method: 'GET', path: `${root}/branches/${encodeURIComponent(branch)}`, ...signal })).data;
      validateBranch(raw.branch, branch);
    }
    if (['pull', 'reviews', 'delivery'].includes(kind)) {
      if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber < 1 || request.pullNumber > 1_000_000_000) failProvider('invalid-request', { provider: 'github' });
      if (kind === 'pull' || kind === 'delivery') {
        raw.pull = (await http.request({ method: 'GET', path: `${root}/pulls/${request.pullNumber}`, ...signal })).data;
        validatePull(raw.pull, request.pullNumber, context);
      }
      if (kind === 'reviews' || kind === 'delivery') {
        raw.reviews = await http.paginate({
          path: `${root}/pulls/${request.pullNumber}/reviews?per_page=100`, identityKey: 'id', ...signal,
        });
        validateReviews(raw.reviews, context);
      }
    }
    if (kind === 'checks' || kind === 'delivery') {
      const sha = boundedString(request.commitSha, 40, SHA);
      const checkRuns = await http.paginate({
        path: `${root}/commits/${sha}/check-runs?per_page=100`, itemsKey: 'check_runs', identityKey: 'id', totalKey: 'total_count', ...signal,
      });
      validateChecks(checkRuns, context);
      raw.checks = { check_runs: checkRuns };
    }
    if (kind === 'artifacts' || kind === 'delivery') {
      const artifacts = await http.paginate({
        path: `${root}/actions/artifacts?per_page=100`, itemsKey: 'artifacts', identityKey: 'id', totalKey: 'total_count', ...signal,
      });
      validateArtifacts(artifacts, context);
      raw.artifacts = { artifacts };
    }
    const normalized = {
      ...(raw.repository ? { repository: normalizeRepository(raw.repository) } : {}),
      ...(raw.branch ? { branch: normalizeBranch(raw.branch) } : {}),
      ...(raw.pull ? { pullRequest: normalizePull(raw.pull) } : {}),
      ...(raw.checks ? { checks: (raw.checks.check_runs ?? []).map(item => ({
        id: item.id, name: item.name, status: item.status, conclusion: item.conclusion,
      })) } : {}),
      ...(raw.reviews ? { reviews: raw.reviews.map(item => ({
        id: item.id, state: item.state, reviewer: item.user.login,
      })) } : {}),
      ...(raw.artifacts ? { artifacts: (raw.artifacts.artifacts ?? []).map(item => ({
        id: item.id, name: item.name, expired: item.expired, url: sanitizeReferenceUrl(item.archive_download_url),
      })) } : {}),
    };
    return createSourceEnvelope({
      provider: 'github', sourceId: `${owner}/${repo}`, sourceUrl: `${webOrigin}/${owner}/${repo}`,
      fetchedAt: providerTimestamp(now, 'github'), fixtureSource: false, raw, normalized,
      retryClassification: 'none', capabilities: { read: READ, write: WRITE },
    });
  }

  function parseResource(value) {
    const match = /^([^/#]+)\/([^/#]+)#([1-9][0-9]*)$/.exec(value);
    if (!match) failProvider('invalid-request', { provider: 'github' });
    const names = identity(match[1], match[2]);
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number > 1_000_000_000) failProvider('invalid-request', { provider: 'github' });
    return { ...names, number, root: repoPath(names.owner, names.repo) };
  }

  function write(inputWrite) {
    if (!governance) failProvider('approval-required', { provider: 'github' });
    return executeGovernedWrite(inputWrite, {
      provider: 'github', actions: new Set(WRITE), governance,
      async preflight(writeRequest) {
        const resource = parseResource(writeRequest.resourceId);
        const response = await http.request({ method: 'GET', path: `${resource.root}/pulls/${resource.number}` });
        if (!response.headers.etag) failProvider('state-conflict', { provider: 'github' });
        try { validatePull(response.data, resource.number, { ...resource, apiOrigin, apiPrefix, webOrigin }, false); } catch { failProvider('state-conflict', { provider: 'github' }); }
        return Object.freeze({
          state: String(response.data?.state ?? ''), version: response.headers.etag,
          condition: response.headers.etag, resource,
        });
      },
      prepare(writeRequest, state) {
        const commonHeaders = {
          'idempotency-key': writeRequest.idempotencyKey,
          'if-match': state.condition,
        };
        if (writeRequest.action === 'comment') {
          const payload = captureRecord(writeRequest.payload, new Set(['body']), ['body']);
          return Object.freeze({
            method: 'POST', path: `${state.resource.root}/issues/${state.resource.number}/comments`, headers: commonHeaders,
            wireBody: createProviderWireBody(writeRequest),
          });
        }
        const payload = captureRecord(writeRequest.payload, new Set(['title', 'body', 'state']), []);
        const body = {};
        if (payload.title !== undefined) body.title = boundedString(payload.title, 512);
        if (payload.body !== undefined) body.body = boundedString(payload.body, 65_536);
        if (payload.state !== undefined) body.state = boundedString(payload.state, 16, /^(?:open|closed)$/);
        if (Object.keys(body).length === 0) failProvider('invalid-request', { provider: 'github' });
        return Object.freeze({
          method: 'PATCH', path: `${state.resource.root}/pulls/${state.resource.number}`, headers: commonHeaders, wireBody: createProviderWireBody(writeRequest),
        });
      },
      async mutate(writeRequest, _state, prepared) {
        if (writeRequest.action === 'comment') {
          return executeTrustedConditionalMutation(conditionalMutation, {
            provider: 'github', action: writeRequest.action, resourceId: writeRequest.resourceId,
            expectedState: writeRequest.expectedState, expectedVersion: writeRequest.expectedVersion,
            idempotencyKey: writeRequest.idempotencyKey, wireBody: prepared.wireBody,
            dispatch: async () => {
              const data = (await http.request(prepared)).data;
              if (!data || !validId(data.id)) remoteFailure();
              if (data.html_url !== undefined) boundRemoteUrl(data.html_url, webOrigin,
                `/${_state.resource.owner}/${_state.resource.repo}/issues/${_state.resource.number}`,
                new RegExp(`^#issuecomment-${data.id}$`));
              return data;
            },
          });
        }
        const data = (await http.request(prepared)).data;
        validatePull(data, _state.resource.number, { ..._state.resource, apiOrigin, apiPrefix, webOrigin }, false);
        if (data.html_url !== undefined) boundRemoteUrl(data.html_url, webOrigin,
          `/${_state.resource.owner}/${_state.resource.repo}/pull/${_state.resource.number}`);
        return data;
      },
    });
  }

  return createAdapter({
    provider: 'github', fixtureSource: false, capabilities: { read: READ, write: WRITE }, read, write,
  });
}
