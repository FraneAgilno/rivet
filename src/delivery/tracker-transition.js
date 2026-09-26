import { captureRecord, createProviderReadBody, createProviderWireBody } from '../adapters/contract.js';
import { createProviderHttpClient } from '../adapters/http.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { digest, ensure, exact, factsDigest, hash, id, plain, sha, timestamp, validateCandidate, validateReceipt } from './contract.js';

const KEY = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMBER = /^[1-9][0-9]{0,19}$/;
const ISSUE_QUERY = 'query RivetTrackerStatus($id: String!) { issue(id: $id) { id identifier url updatedAt team { id key } state { id name type team { id key } } } }';
const STATES_QUERY = 'query RivetTrackerStates($filter: WorkflowStateFilter, $cursor: String) { workflowStates(first: 100, after: $cursor, filter: $filter) { nodes { id name type team { id key } } pageInfo { hasNextPage endCursor } } }';
function label(value) { ensure(typeof value === 'string' && value.length >= 1 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'invalid-provider-evidence'); return value; }
function revision(value) { ensure(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)), 'invalid-provider-evidence'); return value; }

/** Discover destinations and bind a human choice. Status reads never create journal entries. */
export async function createTrackerTransition(inputConfig) {
  const input = captureRecord(inputConfig, new Set(['repository', 'target', 'mergeReceipt', 'providerId', 'baseUrl', 'headers', 'transport', 'clock', 'timeoutMs', 'persistedPayload']), ['repository', 'target', 'mergeReceipt', 'providerId', 'baseUrl', 'transport'], 'invalid-config');
  const supplied = plain(input.repository), repository = parseRepositoryRemote(supplied.url);
  ensure(hash(repository) === hash(supplied));
  const target = plain(input.target); exact(target, ['kind', 'issueKey', 'issueUrl', 'requestDigest']);
  ensure(['jira', 'linear'].includes(target.kind) && typeof target.issueKey === 'string' && KEY.test(target.issueKey));
  digest(target.requestDigest); id(input.providerId);
  const jira = target.kind === 'jira';
  let url; try { url = new URL(target.issueUrl); } catch { ensure(false); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === target.issueUrl);
  ensure(jira ? /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(input.baseUrl)
    && target.issueUrl === `${input.baseUrl}/browse/${target.issueKey}`
    : input.baseUrl === 'https://api.linear.app' && url.origin === 'https://linear.app'
      && new RegExp(`^/[^/]+/issue/${target.issueKey}(?:/[^/]+)?/?$`).test(url.pathname));
  const merged = plain(input.mergeReceipt);
  validateReceipt(merged, { action: 'merge', digest: digest(merged.operationDigest), candidate: { headSha: sha(merged.headSha) } });
  const prefix = `${repository.url}/${repository.provider === 'github' ? 'pull' : repository.provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/`;
  const reviewNumber = Number(merged.resourceUrl.slice(prefix.length));
  ensure(Number.isSafeInteger(reviewNumber) && reviewNumber > 0 && merged.resourceUrl === prefix + reviewNumber);
  const clock = input.clock ?? (() => new Date().toISOString()); ensure(typeof clock === 'function');
  const http = createProviderHttpClient({ provider: target.kind, baseUrl: input.baseUrl, transport: input.transport,
    ...(input.headers === undefined ? {} : { headers: input.headers }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
  const internal = value => { ensure(typeof value === 'string' && (jira ? NUMBER : UUID).test(value), 'invalid-provider-evidence'); return value; };
  function owner(value) { internal(value?.id); ensure(value.key === target.issueKey.split('-')[0], 'changed-facts'); return plain({ id: value.id, key: value.key }); }
  function state(value, expectedOwner) {
    internal(value?.id);
    if (!jira) ensure(hash(owner(value.team)) === hash(expectedOwner), 'changed-facts');
    return plain({ id: value.id, name: label(value.name), type: label(jira ? value.statusCategory?.key : value.type) });
  }
  async function graphql(query, variables) {
    const result = (await http.request({ method: 'POST', path: '/graphql', wireBody: createProviderReadBody({ provider: 'linear', payload: { query, variables } }) })).data;
    ensure(result && !Object.hasOwn(result, 'errors') && result.data && typeof result.data === 'object', 'invalid-provider-evidence');
    return result.data;
  }
  async function issue(selected, expected) {
    const raw = jira ? (await http.request({ method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(selected)}?fields=updated,project,status` })).data
      : (await graphql(ISSUE_QUERY, { id: selected })).issue;
    internal(raw?.id);
    ensure((jira ? raw.key : raw.identifier) === target.issueKey && (jira || raw.url === target.issueUrl), 'changed-facts');
    const identity = owner(jira ? raw.fields?.project : raw.team);
    if (expected) ensure(raw.id === expected.id && hash(identity) === hash(expected.owner), 'changed-facts');
    return plain({ id: raw.id, key: target.issueKey, owner: identity,
      revision: revision(jira ? raw.fields.updated : raw.updatedAt), state: state(jira ? raw.fields.status : raw.state, identity) });
  }
  async function destinations(current) {
    if (jira) {
      const raw = (await http.request({ method: 'GET', path: `/rest/api/3/issue/${current.id}/transitions?expand=transitions.fields` })).data;
      ensure(Array.isArray(raw?.transitions) && raw.transitions.length <= 100, 'invalid-provider-evidence');
      const result = raw.transitions.map(value => {
        internal(value.id); label(value.name);
        ensure(typeof value.hasScreen === 'boolean' && value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields), 'invalid-provider-evidence');
        const fields = Object.values(value.fields);
        ensure(fields.length <= 100 && fields.every(field => field && typeof field.required === 'boolean'), 'invalid-provider-evidence');
        const eligible = !value.hasScreen && fields.every(field => !field.required);
        return plain({ id: value.id, name: value.name, state: state(value.to, current.owner), eligible,
          reason: eligible ? null : 'requires-fields-or-screen', metadataDigest: hash({ to: value.to, fields: value.fields, hasScreen: value.hasScreen }) });
      });
      ensure(new Set(result.map(value => value.id)).size === result.length, 'invalid-provider-evidence');
      return result;
    }
    const result = [], ids = new Set(), cursors = new Set(); let cursor = null;
    for (let page = 0; page < 10; page++) {
      const connection = (await graphql(STATES_QUERY, { filter: { team: { id: { eq: current.owner.id } } }, cursor })).workflowStates;
      ensure(Array.isArray(connection?.nodes) && connection.nodes.length <= 100 && typeof connection.pageInfo?.hasNextPage === 'boolean', 'invalid-provider-evidence');
      for (const value of connection.nodes) {
        const normalized = state(value, current.owner);
        ensure(!ids.has(normalized.id), 'invalid-provider-evidence'); ids.add(normalized.id);
        result.push(plain({ id: normalized.id, name: normalized.name, state: normalized, eligible: true, reason: null, metadataDigest: hash({ state: normalized, owner: current.owner }) }));
      }
      if (!connection.pageInfo.hasNextPage) return result;
      cursor = connection.pageInfo.endCursor;
      ensure(connection.nodes.length > 0 && typeof cursor === 'string' && /^[A-Za-z0-9._~+=/-]{1,512}$/.test(cursor) && !cursors.has(cursor), 'invalid-provider-evidence'); cursors.add(cursor);
    }
    ensure(false, 'invalid-provider-evidence');
  }
  const binding = { ...target, providerId: input.providerId, endpoint: input.baseUrl, mergeCommit: merged.commitSha, reviewUrl: merged.resourceUrl, assurance: 'precheck-readback' };
  function validSaved(payload) {
    exact(payload, [...Object.keys(binding), 'issue', 'destination']);
    const { issue: savedIssue, destination, ...rest } = payload;
    ensure(hash(rest) === hash(binding), 'changed-facts');
    exact(savedIssue, ['id', 'key', 'owner', 'revision', 'state']); internal(savedIssue.id); owner(savedIssue.owner); revision(savedIssue.revision);
    ensure(savedIssue.key === target.issueKey); exact(savedIssue.state, ['id', 'name', 'type']); internal(savedIssue.state.id); label(savedIssue.state.name); label(savedIssue.state.type);
    exact(destination, ['id', 'name', 'state', 'eligible', 'reason', 'metadataDigest']); internal(destination.id); label(destination.name); digest(destination.metadataDigest);
    exact(destination.state, ['id', 'name', 'type']); internal(destination.state.id); label(destination.state.name); label(destination.state.type);
    ensure(destination.eligible === true && destination.reason === null);
    if (!jira) ensure(destination.id === destination.state.id);
  }
  function prepare(payload) {
    validSaved(payload);
    function candidate(value) { validateCandidate(value); ensure(hash(value.repository) === hash(repository) && value.headSha === merged.headSha && (value.reviewNumber === null || value.reviewNumber === reviewNumber), 'changed-facts'); }
    async function observe(value) {
      candidate(value);
      const current = await issue(payload.issue.id, payload.issue);
      const choices = await destinations(current);
      const selected = choices.find(choice => choice.id === payload.destination.id);
      ensure(hash(current) === hash(payload.issue) && selected && hash(selected) === hash(payload.destination), 'changed-facts');
      const evidenceDigest = hash({ current, selected, binding });
      return plain({ repositoryUrl: repository.url, sourceBranch: value.sourceBranch, targetBranch: value.targetBranch, headSha: value.headSha, baseSha: merged.commitSha,
        review: { number: reviewNumber, state: 'merged', url: merged.resourceUrl, headSha: value.headSha },
        checks: { headSha: value.headSha, policy: 'unknown', satisfied: null, evidenceDigest },
        reviews: { headSha: value.headSha, policy: 'unknown', satisfied: null, evidenceDigest }, observedAt: timestamp(clock()) });
    }
    function operation(value) { const op = plain(value); candidate(op.candidate); digest(op.digest); ensure(op.action === 'tracker-transition' && hash(op.payload) === hash(payload) && hash(op.mergeReceipt) === hash(merged), 'changed-facts'); return op; }
    async function reconcile(value) {
      try {
        const op = operation(value), current = await issue(payload.issue.id, payload.issue);
        ensure(hash(current.state) === hash(payload.destination.state), 'unverified-effect');
        return { status: 'succeeded', receipt: plain({ status: 'succeeded', operationDigest: op.digest, headSha: op.candidate.headSha, commitSha: merged.commitSha,
          resourceUrl: target.issueUrl, evidenceDigest: hash({ payload, observed: current, assurance: 'desired-state-observed-not-exclusive-causation' }) }) };
      } catch { return { status: 'unknown' }; }
    }
    async function dispatch(value, context) {
      const op = operation(value), ctx = plain(context); exact(ctx, ['deadline']);
      const deadline = Date.parse(timestamp(ctx.deadline)), timely = () => ensure(Date.parse(timestamp(clock())) < deadline, 'dispatch-expired');
      timely(); ensure(hash(payload.issue.state) !== hash(payload.destination.state), 'already-desired');
      ensure(factsDigest(await observe(op.candidate)) === op.factsDigest, 'changed-facts');
      const wireBody = createProviderWireBody({ provider: target.kind, action: 'tracker-transition', resourceId: payload.issue.id,
        expectedState: payload.issue.state.id, expectedVersion: payload.issue.revision, idempotencyKey: op.digest,
        payload: jira ? { transitionId: payload.destination.id } : { issueId: payload.issue.id, stateId: payload.destination.state.id } });
      timely(); const remaining = deadline - Date.parse(timestamp(clock())); ensure(remaining > 0, 'dispatch-expired');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await http.request({ method: 'POST', path: jira ? `/rest/api/3/issue/${payload.issue.id}/transitions` : '/graphql', wireBody, signal: controller.signal });
        ensure(jira ? response.status === 204 : response.data && !Object.hasOwn(response.data, 'errors') && response.data.data?.issueUpdate?.success === true && response.data.data.issueUpdate.issue?.id === payload.issue.id, 'unverified-effect');
      } finally { clearTimeout(timer); }
      const outcome = await reconcile(op); ensure(outcome.status === 'succeeded', 'unverified-effect'); return outcome.receipt;
    }
    const executor = createTrustedDeliveryExecutor({ provider: repository.provider,
      capabilities: [{ action: 'tracker-transition', conditionalHead: false, verifiesDesiredState: true, reconcile: true }], observe, dispatch, reconcile });
    return Object.freeze({ executor, payload, alreadyDesired: hash(payload.issue.state) === hash(payload.destination.state),
      preview: `${target.issueKey}: ${payload.issue.state.name} -> ${payload.destination.state.name} (${payload.destination.name})` });
  }
  if (input.persistedPayload !== undefined) {
    const payload = plain(input.persistedPayload); validSaved(payload); await issue(payload.issue.id, payload.issue); return prepare(payload);
  }
  const current = await issue(target.issueKey), available = await destinations(current);
  const status = plain({ target, current: current.state, issueRevision: current.revision, destinations: available });
  return Object.freeze({ status, async select(destinationId) {
    const destination = available.find(value => value.id === destinationId);
    ensure(destination?.eligible === true, 'unsupported-transition');
    return prepare(plain({ ...binding, issue: current, destination }));
  } });
}
