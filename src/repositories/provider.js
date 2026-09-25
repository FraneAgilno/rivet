import { boundedString, captureRecord, failProvider, immutableRedactedJson, providerTimestamp } from '../adapters/contract.js';
import { createGithubAdapter } from '../adapters/github.js';
import { createProviderHttpClient } from '../adapters/http.js';
import { parseRepositoryRemote } from './identity.js';

const ENDPOINTS = Object.freeze({ github: 'https://api.github.com', bitbucket: 'https://api.bitbucket.org/2.0', gitlab: 'https://gitlab.com/api/v4' });
const CAPABILITIES = Object.freeze({ read: Object.freeze(['repository', 'branch', 'review-request', 'checks', 'reviews']), write: Object.freeze([]) });
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;
function remote(condition, provider) { if (!condition) failProvider('remote', { provider, retryClassification: 'permanent' }); }
function record(value, provider) { remote(value !== null && typeof value === 'object' && !Array.isArray(value), provider); return value; }
function text(value, provider, maximum = 1024) { remote(typeof value === 'string' && value.length > 0 && value.length <= maximum, provider); return value; }
function sha(value, provider) { remote(typeof value === 'string' && SHA.test(value), provider); return value; }
function ref(value, provider) { remote(typeof value === 'string' && BRANCH.test(value) && !value.includes('..') && !value.includes('//'), provider); return value; }
function positive(value, provider) { remote(Number.isSafeInteger(value) && value > 0, provider); return value; }
function boundUrl(value, expected, provider) { remote(value === expected, provider); return value; }
function number(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) failProvider('invalid-request'); return value; }

export function createRepositoryProvider(input) {
  const config = captureRecord(input, new Set(['repository', 'transport', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'maxItems', 'clock']), ['repository', 'transport'], 'invalid-config');
  const supplied = captureRecord(config.repository, new Set(['provider', 'host', 'namespace', 'name', 'fullName', 'url', 'remoteName']), ['provider', 'host', 'namespace', 'name', 'fullName', 'url'], 'invalid-config');
  const repository = parseRepositoryRemote(supplied.url);
  for (const key of Object.keys(repository)) if (repository[key] !== supplied[key]) failProvider('invalid-config');
  const provider = repository.provider;
  const clock = config.clock ?? (() => new Date().toISOString());
  if (typeof clock !== 'function') failProvider('invalid-config', { provider });
  const limits = Object.fromEntries(['headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'maxItems'].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const http = createProviderHttpClient({ provider, transport: config.transport, baseUrl: ENDPOINTS[provider], ...limits, allowEncodedSlash: true });
  const github = provider === 'github' ? createGithubAdapter({ transport: config.transport, baseUrl: ENDPOINTS.github, ...limits, clock }) : null;
  const root = provider === 'github' ? `/repos/${repository.fullName}` : provider === 'bitbucket' ? `/repositories/${repository.fullName}` : `/projects/${encodeURIComponent(repository.fullName)}`;
  const reviewRoot = provider === 'github' ? 'pulls' : provider === 'bitbucket' ? 'pullrequests' : 'merge_requests';
  const maxPages = config.maxPages ?? 20, maxItems = config.maxItems ?? 10_000;
  const request = (path, signal) => http.request({ method: 'GET', path, ...(signal === undefined ? {} : { signal }) });

  async function bitbucketPages(path, signal) {
    const initial = new URL(http.urlFor(`${path}?pagelen=100`));
    const output = [], seen = new Set();
    let next = initial.href, declaredSize;
    for (let page = 0; page < maxPages; page += 1) {
      let url;
      try { url = new URL(next); } catch { failProvider('remote', { provider }); }
      remote(url.origin === initial.origin && url.pathname === initial.pathname && !url.username && !url.password && !url.hash, provider);
      remote([...url.searchParams.keys()].every(key => ['page', 'pagelen'].includes(key)) && url.searchParams.getAll('pagelen').length === 1
        && url.searchParams.get('pagelen') === '100' && url.searchParams.getAll('page').length <= 1
        && (!url.searchParams.has('page') || /^[1-9][0-9]{0,8}$/.test(url.searchParams.get('page'))), provider);
      remote(Number(url.searchParams.get('page') ?? 1) === page + 1, provider);
      remote(!seen.has(url.href), provider); seen.add(url.href);
      const response = await request(`${url.pathname.slice('/2.0'.length)}${url.search}`, signal);
      remote(Array.isArray(response.data?.values), provider);
      if (response.data.size !== undefined) {
        remote(Number.isSafeInteger(response.data.size) && response.data.size >= 0 && (declaredSize === undefined || declaredSize === response.data.size), provider);
        declaredSize = response.data.size;
        if (declaredSize > maxItems) failProvider('pagination-limit', { provider });
      }
      if (response.data.page !== undefined) remote(response.data.page === page + 1, provider);
      output.push(...response.data.values);
      if (declaredSize !== undefined) remote(output.length <= declaredSize, provider);
      if (output.length > maxItems) failProvider('pagination-limit', { provider });
      if (response.data.next === undefined || response.data.next === null) {
        if (declaredSize !== undefined) remote(output.length === declaredSize, provider);
        return output;
      }
      remote(typeof response.data.next === 'string' && response.data.next.length <= 4096 && response.data.values.length > 0, provider);
      next = response.data.next;
    }
    failProvider('pagination-limit', { provider });
  }

  async function repositoryInfo(signal) {
    if (github) {
      const value = (await github.read({ kind: 'repo', owner: repository.namespace, repo: repository.name, ...(signal === undefined ? {} : { signal }) })).normalized.repository;
      return { ...repository, id: value.id, defaultBranch: value.defaultBranch, private: value.private };
    }
    const value = (await request(root, signal)).data;
    if (provider === 'bitbucket') {
      remote(value?.full_name === repository.fullName && typeof value.is_private === 'boolean', provider);
      boundUrl(value.links?.html?.href, repository.url, provider);
      return { ...repository, id: text(value.uuid, provider), defaultBranch: value.mainbranch === null ? null : ref(value.mainbranch?.name, provider), private: value.is_private };
    }
    remote(value?.path_with_namespace === repository.fullName && ['private', 'internal', 'public'].includes(value.visibility), provider);
    boundUrl(value.web_url, repository.url, provider);
    return { ...repository, id: positive(value.id, provider), defaultBranch: value.default_branch === null ? null : ref(value.default_branch, provider), private: value.visibility !== 'public' };
  }

  async function branchInfo(branch, signal) {
    boundedString(branch, 255, BRANCH); if (branch.includes('..') || branch.includes('//')) failProvider('invalid-request');
    if (github) {
      const value = (await request(`${root}/branches/${encodeURIComponent(branch)}`, signal)).data;
      remote(value?.name === branch && typeof value.protected === 'boolean', provider);
      return { name: branch, commitSha: sha(value.commit?.sha, provider), protected: value.protected };
    }
    const value = (await request(`${root}/${provider === 'bitbucket' ? 'refs' : 'repository'}/branches/${encodeURIComponent(branch)}`, signal)).data;
    remote(value?.name === branch, provider);
    return { name: branch, commitSha: sha(provider === 'bitbucket' ? value.target?.hash : value.commit?.id, provider), protected: provider === 'bitbucket' ? null : typeof value.protected === 'boolean' ? value.protected : null };
  }

  async function reviewInfo(reviewNumber, signal) {
    const value = (await request(`${root}/${reviewRoot}/${number(reviewNumber)}`, signal)).data;
    let result;
    if (provider === 'github') {
      remote(value?.number === reviewNumber && ['open', 'closed'].includes(value.state) && typeof value.merged === 'boolean', provider);
      result = { number: reviewNumber, state: value.merged ? 'merged' : value.state, title: text(value.title, provider), headSha: sha(value.head?.sha, provider), headBranch: ref(value.head?.ref, provider), baseBranch: ref(value.base?.ref, provider), url: boundUrl(value.html_url, `${repository.url}/pull/${reviewNumber}`, provider) };
    } else if (provider === 'bitbucket') {
      remote(value?.id === reviewNumber && ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(value.state) && value.destination?.repository?.full_name === repository.fullName, provider);
      result = { number: reviewNumber, state: value.state === 'OPEN' ? 'open' : value.state === 'MERGED' ? 'merged' : 'closed', title: text(value.title, provider), headSha: sha(value.source?.commit?.hash, provider), headBranch: ref(value.source?.branch?.name, provider), baseBranch: ref(value.destination?.branch?.name, provider), url: boundUrl(value.links?.html?.href, `${repository.url}/pull-requests/${reviewNumber}`, provider) };
    } else {
      remote(value?.iid === reviewNumber && ['opened', 'closed', 'locked', 'merged'].includes(value.state), provider);
      result = { number: reviewNumber, state: value.state === 'opened' ? 'open' : value.state, title: text(value.title, provider), headSha: sha(value.sha, provider), headBranch: ref(value.source_branch, provider), baseBranch: ref(value.target_branch, provider), url: boundUrl(value.web_url, `${repository.url}/-/merge_requests/${reviewNumber}`, provider) };
    }
    return { result, raw: value };
  }

  async function checksInfo(commitSha, signal) {
    boundedString(commitSha, 40, SHA);
    const options = signal === undefined ? {} : { signal };
    let items;
    if (provider === 'github') {
      const checks = await http.paginate({ path: `${root}/commits/${commitSha}/check-runs?per_page=100`, itemsKey: 'check_runs', identityKey: 'id', totalKey: 'total_count', ...options });
      const statuses = await http.paginate({ path: `${root}/commits/${commitSha}/statuses?per_page=100`, identityKey: 'id', ...options });
      items = checks.map(value => {
        record(value, provider);
        positive(value.id, provider); sha(value.head_sha, provider);
        if (value.head_sha !== commitSha) failProvider('state-conflict', { provider });
        remote(['queued', 'in_progress', 'completed', 'pending', 'requested', 'waiting'].includes(value.status), provider);
        const conclusions = { success: 'success', failure: 'failure', timed_out: 'failure', cancelled: 'cancelled', skipped: 'skipped', neutral: 'neutral', action_required: 'blocked', stale: 'stale' };
        if (value.status === 'completed') remote(Object.hasOwn(conclusions, value.conclusion), provider);
        return { id: `check:${value.id}`, name: text(value.name, provider), commitSha, state: value.status === 'completed' ? conclusions[value.conclusion] : 'pending' };
      });
      items.push(...statuses.map(value => {
        record(value, provider);
        positive(value.id, provider);
        if (value.sha !== undefined && value.sha !== commitSha) failProvider('state-conflict', { provider });
        remote(['success', 'failure', 'error', 'pending'].includes(value.state), provider);
        return { id: `status:${value.id}`, name: text(value.context, provider), commitSha, state: value.state === 'error' ? 'failure' : value.state };
      }));
    } else if (provider === 'bitbucket') {
      const values = await bitbucketPages(`${root}/commit/${commitSha}/statuses`, signal);
      items = values.map(value => {
        record(value, provider);
        if (value.links?.commit?.href !== undefined && value.links.commit.href !== `${ENDPOINTS.bitbucket}${root}/commit/${commitSha}`) failProvider('state-conflict', { provider });
        const states = { SUCCESSFUL: 'success', FAILED: 'failure', INPROGRESS: 'pending', STOPPED: 'cancelled' };
        remote(Object.hasOwn(states, value.state), provider);
        return { id: text(value.key, provider), name: text(value.name || value.key, provider), commitSha, state: states[value.state] };
      });
    } else {
      const values = await http.paginate({ path: `${root}/repository/commits/${commitSha}/statuses?per_page=100`, identityKey: 'id', ...options });
      items = values.map(value => {
        record(value, provider);
        positive(value.id, provider); sha(value.sha, provider);
        if (value.sha !== commitSha) failProvider('state-conflict', { provider });
        const states = { pending: 'pending', running: 'pending', success: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped', created: 'pending', manual: 'blocked', scheduled: 'pending', preparing: 'pending', waiting_for_resource: 'pending' };
        remote(Object.hasOwn(states, value.status), provider);
        return { id: String(value.id), name: text(value.name, provider), commitSha, state: states[value.status] };
      });
    }
    remote(new Set(items.map(value => value.id)).size === items.length, provider);
    return { commitSha, items, requiredPolicy: 'unknown' };
  }

  async function reviewsInfo(reviewNumber, signal) {
    number(reviewNumber);
    let items;
    if (provider === 'github') {
      const values = await http.paginate({ path: `${root}/pulls/${reviewNumber}/reviews?per_page=100`, identityKey: 'id', ...(signal === undefined ? {} : {signal}) });
      items = values.map(value => {
        record(value, provider);
        positive(value.id, provider); remote(['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(value.state), provider);
        return { id: String(value.id), reviewer: text(value.user?.login, provider), state: value.state.toLowerCase(), commitSha: value.commit_id == null ? null : sha(value.commit_id, provider) };
      });
    } else if (provider === 'bitbucket') {
      const { raw } = await reviewInfo(reviewNumber, signal);
      remote(Array.isArray(raw.participants) && raw.participants.length <= maxItems, provider);
      items = raw.participants.map(value => {
        record(value, provider);
        remote(typeof value.approved === 'boolean', provider);
        return { reviewer: text(value.user?.uuid, provider), state: value.approved ? 'approved' : value.state === 'changes_requested' ? 'changes_requested' : 'unapproved', commitSha: null };
      });
    } else {
      const value = (await request(`${root}/merge_requests/${reviewNumber}/approvals`, signal)).data;
      remote(value?.iid === reviewNumber && Array.isArray(value.approved_by) && value.approved_by.length <= maxItems, provider);
      items = value.approved_by.map(entry => ({ reviewer: text(record(entry, provider).user?.username, provider), state: 'approved', commitSha: null }));
    }
    return { items, policy: 'unknown' };
  }

  async function read(inputRead) {
    const value = captureRecord(inputRead, new Set(['kind', 'branch', 'number', 'commitSha', 'signal']), ['kind']);
    if (!CAPABILITIES.read.includes(value.kind)) failProvider('invalid-request', { provider });
    let normalized;
    if (value.kind === 'repository') normalized = { repository: await repositoryInfo(value.signal) };
    else if (value.kind === 'branch') normalized = { branch: await branchInfo(value.branch, value.signal) };
    else if (value.kind === 'review-request') normalized = { reviewRequest: (await reviewInfo(value.number, value.signal)).result };
    else if (value.kind === 'checks') normalized = { checks: await checksInfo(value.commitSha, value.signal) };
    else normalized = { reviews: await reviewsInfo(value.number, value.signal) };
    return immutableRedactedJson({ repository, ...normalized, observedAt: providerTimestamp(clock, provider), capabilities: CAPABILITIES });
  }

  async function inspect(inputInspect) {
    const value = captureRecord(inputInspect, new Set(['number', 'signal']), ['number']);
    number(value.number);
    const info = await repositoryInfo(value.signal);
    const review = (await reviewInfo(value.number, value.signal)).result;
    const checks = await checksInfo(review.headSha, value.signal);
    const reviews = await reviewsInfo(value.number, value.signal);
    const latest = (await reviewInfo(value.number, value.signal)).result;
    if (latest.headSha !== review.headSha || latest.state !== review.state || latest.baseBranch !== review.baseBranch) failProvider('state-conflict', { provider });
    return immutableRedactedJson({ repository: info, reviewRequest: latest, checks, reviews, observedAt: providerTimestamp(clock, provider), consistency: 'head-rechecked', capabilities: CAPABILITIES });
  }
  return Object.freeze({ provider, repository, capabilities: CAPABILITIES, read, inspect, write() { failProvider('read-only', { provider }); } });
}
