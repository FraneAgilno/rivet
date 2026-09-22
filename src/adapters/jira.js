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
  immutableRedactedJson,
  providerTimestamp,
  snapshotProviderJson,
  validateTrustedConditionalMutationCapability,
} from './contract.js';
import { createProviderHttpClient } from './http.js';

const READ = Object.freeze(['epic', 'issue']);
const WRITE = Object.freeze(['comment', 'status']);
const ID = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;

function remoteFailure() { failProvider('remote', { provider: 'jira', retryClassification: 'permanent' }); }

function validateIssue(value, expectedId, full = false, expectedKind) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.key !== expectedId
      || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)
      || !value.fields.status || typeof value.fields.status.id !== 'string') remoteFailure();
    if (full && (typeof value.id !== 'string' || !/^[1-9][0-9]*$/.test(value.id)
      || typeof value.fields.summary !== 'string' || typeof value.fields.issuetype?.name !== 'string'
      || typeof value.fields.status.name !== 'string'
      || (value.fields.issuelinks !== undefined && !Array.isArray(value.fields.issuelinks))
      || (value.fields.comment !== undefined && (!value.fields.comment || typeof value.fields.comment !== 'object'
        || !Array.isArray(value.fields.comment.comments))))) remoteFailure();
    if (full && value.fields.issuelinks?.some(link => {
      const keys = [link?.outwardIssue?.key, link?.inwardIssue?.key].filter(key => typeof key === 'string');
      return !link || typeof link !== 'object' || Array.isArray(link)
        || typeof link.id !== 'string' || !/^[1-9][0-9]*$/.test(link.id) || typeof link.type?.name !== 'string'
        || keys.length !== 1 || !ID.test(keys[0]);
    })) remoteFailure();
    if (expectedKind === 'epic' && value.fields.issuetype.name !== 'Epic') remoteFailure();
    return value;
  } catch (error) { if (error instanceof Error && error.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function validateComments(value) {
  try {
    if (!Array.isArray(value)) remoteFailure();
    for (const comment of value) {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)
        || typeof comment.id !== 'string' || !/^[1-9][0-9]*$/.test(comment.id)
        || (typeof comment.body !== 'string' && (!comment.body || typeof comment.body !== 'object' || Array.isArray(comment.body)))
        || !comment.author || typeof comment.author !== 'object' || Array.isArray(comment.author)
        || (typeof comment.author.displayName !== 'string' && typeof comment.author.accountId !== 'string')) remoteFailure();
    }
    return value;
  } catch (error) { if (error instanceof Error && error.code === 'ERR_PROVIDER_REMOTE') throw error; remoteFailure(); }
}

function textFromDocument(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.content)) return value.content.map(textFromDocument).filter(Boolean).join('\n');
  return '';
}

export function normalizeJira(raw) {
  const source = snapshotProviderJson(raw);
  const fields = source?.fields ?? {};
  const description = textFromDocument(fields.description);
  const namedCriteria = Object.entries(source?.names ?? {})
    .filter(([, name]) => /acceptance criteria/i.test(String(name)))
    .flatMap(([key]) => textFromDocument(fields[key]).split(/\r?\n/));
  const acceptanceCriteria = [...description.split(/\r?\n/), ...namedCriteria].map(line => line.trim())
    .filter(line => /^(?:AC\s*\d*|acceptance criteria)\s*[:.-]/i.test(line));
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks.map(link => ({
    id: String(link?.id ?? ''), type: String(link?.type?.name ?? ''),
    issueId: String(link?.outwardIssue?.key ?? link?.inwardIssue?.key ?? ''),
  })) : [];
  const comments = Array.isArray(fields.comment?.comments) ? fields.comment.comments.map(comment => ({
    id: String(comment?.id ?? ''), body: comment?.body ?? null,
    author: String(comment?.author?.displayName ?? comment?.author?.accountId ?? ''),
  })) : [];
  return immutableRedactedJson({
    id: String(source?.key ?? source?.id ?? ''), internalId: String(source?.id ?? ''),
    kind: String(fields.issuetype?.name ?? ''), summary: String(fields.summary ?? ''),
    epicId: String(fields.parent?.key ?? fields.epic?.key ?? ''),
    status: { id: String(fields.status?.id ?? ''), name: String(fields.status?.name ?? '') },
    description, acceptanceCriteria, links, comments, revision: String(fields.updated ?? ''),
  });
}

function clock(configured) {
  const read = configured ?? (() => new Date().toISOString());
  if (typeof read !== 'function') failProvider('invalid-config', { provider: 'jira' });
  return () => {
    let value;
    try { value = read(); } catch { failProvider('invalid-config', { provider: 'jira' }); }
    return value;
  };
}

export function createJiraAdapter(input) {
  const config = captureRecord(input, new Set([
    'transport', 'baseUrl', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'maxItems', 'clock', 'governance', 'conditionalMutation',
  ]), ['transport', 'baseUrl'], 'invalid-config');
  const now = clock(config.clock);
  const governance = config.governance === undefined ? null : createProviderWriteGovernance(config.governance, 'jira');
  const conditionalMutation = config.conditionalMutation;
  if (governance && !validateTrustedConditionalMutationCapability(conditionalMutation, 'jira', WRITE)) failProvider('invalid-config', { provider: 'jira' });
  const http = createProviderHttpClient({
    provider: 'jira', baseUrl: config.baseUrl, transport: config.transport,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
    ...(config.maxItems === undefined ? {} : { maxItems: config.maxItems }),
  });

  async function read(inputRead) {
    const request = captureRecord(inputRead, new Set(['kind', 'id', 'signal']), ['kind', 'id']);
    const kind = boundedString(request.kind, 16, /^(?:epic|issue)$/);
    const id = boundedString(request.id, 64, ID);
    const response = await http.request({
      method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(id)}?fields=*all&expand=names`,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    validateIssue(response.data, id, true, kind);
    const comments = await http.paginate({
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/comment?startAt=0&maxResults=100`,
      itemsKey: 'comments', identityKey: 'id', mode: 'jira-offset', ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    validateComments(comments);
    const raw = immutableRedactedJson({
      ...response.data,
      fields: { ...response.data.fields, comment: { comments } },
    });
    return createSourceEnvelope({
      provider: 'jira', sourceId: id, sourceUrl: http.urlFor(`/browse/${encodeURIComponent(id)}`),
      fetchedAt: providerTimestamp(now, 'jira'), fixtureSource: false, raw,
      normalized: { ...normalizeJira(raw), requestedKind: kind },
      retryClassification: 'none', capabilities: { read: READ, write: WRITE },
    });
  }

  function write(inputWrite) {
    if (!governance) failProvider('approval-required', { provider: 'jira' });
    return executeGovernedWrite(inputWrite, {
      provider: 'jira', actions: new Set(WRITE), governance,
      async preflight(writeRequest) {
        const id = boundedString(writeRequest.resourceId, 64, ID);
        const response = await http.request({ method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(id)}?fields=status` });
        validateIssue(response.data, id);
        return Object.freeze({
          state: String(response.data?.fields?.status?.id ?? ''),
          version: String(response.headers.etag ?? response.data?.version ?? ''),
        });
      },
      prepare(writeRequest) {
        const id = boundedString(writeRequest.resourceId, 64, ID);
        if (writeRequest.action === 'comment') {
          const payload = captureRecord(writeRequest.payload, new Set(['body']), ['body']);
          const body = typeof payload.body === 'string'
            ? boundedString(payload.body, 32_768)
            : payload.body;
          return Object.freeze({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(id)}/comment`, wireBody: createProviderWireBody(writeRequest) });
        }
        const payload = captureRecord(writeRequest.payload, new Set(['transitionId']), ['transitionId']);
        const transitionId = boundedString(payload.transitionId, 64, /^[A-Za-z0-9._-]+$/);
        return Object.freeze({
          method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
          wireBody: createProviderWireBody(writeRequest),
        });
      },
      async mutate(writeRequest, _state, prepared) {
        return executeTrustedConditionalMutation(conditionalMutation, {
          provider: 'jira', action: writeRequest.action, resourceId: writeRequest.resourceId,
          expectedState: writeRequest.expectedState, expectedVersion: writeRequest.expectedVersion,
          idempotencyKey: writeRequest.idempotencyKey, wireBody: prepared.wireBody,
          dispatch: async () => {
            const data = (await http.request({ ...prepared, headers: { 'idempotency-key': writeRequest.idempotencyKey } })).data;
            if (writeRequest.action === 'comment' && (!data || typeof data.id !== 'string' || !/^[1-9][0-9]*$/.test(data.id))) remoteFailure();
            if (writeRequest.action === 'status' && data !== null) remoteFailure();
            return data;
          },
        });
      },
    });
  }

  return createAdapter({
    provider: 'jira', fixtureSource: false, capabilities: { read: READ, write: WRITE }, read, write,
  });
}
