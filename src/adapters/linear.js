import { markdownAcceptanceCriteria } from '../work-request/local.js';
import {
  boundedString,
  captureRecord,
  createAdapter,
  createProviderReadBody,
  createSourceEnvelope,
  failProvider,
  immutableRedactedJson,
  providerTimestamp,
  readOnlyWrite,
  snapshotProviderJson,
} from './contract.js';
import { createProviderHttpClient } from './http.js';

const READ = Object.freeze(['issue']);
const WRITE = Object.freeze([]);
const ID = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
const SAFE_REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const QUERY = `query AgilnoFeatureIssue($identifier: String!) {
  issue(id: $identifier) {
      id identifier title description updatedAt url
      state { id name }
      team { id key }
      labels(first: 100) { nodes { id name } pageInfo { hasNextPage endCursor } }
      relations(first: 100) { nodes { id type relatedIssue { identifier } } pageInfo { hasNextPage endCursor } }
      comments(first: 100) { nodes { id body user { id name } } pageInfo { hasNextPage endCursor } }
  }
}`;

function remoteFailure() { failProvider('remote', { provider: 'linear', retryClassification: 'permanent' }); }

function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) remoteFailure();
  return value;
}

function safeId(value) {
  if (typeof value !== 'string' || !SAFE_REMOTE_ID.test(value)) remoteFailure();
  return value;
}

function connection(value, maximum) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.pageInfo || typeof value.pageInfo !== 'object' || Array.isArray(value.pageInfo)
    || value.pageInfo.hasNextPage !== false) remoteFailure();
  return array(value.nodes, maximum);
}

function validateIssue(raw, expectedId) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.identifier !== expectedId || typeof raw.title !== 'string'
      || (raw.description !== null && typeof raw.description !== 'string')
      || typeof raw.updatedAt !== 'string' || typeof raw.url !== 'string'
      || !raw.state || typeof raw.state !== 'object' || Array.isArray(raw.state)
      || typeof raw.state.name !== 'string'
      || !raw.team || typeof raw.team !== 'object' || Array.isArray(raw.team)
      || typeof raw.team.key !== 'string') remoteFailure();
    safeId(raw.id); safeId(raw.state.id); safeId(raw.team.id);
    for (const label of connection(raw.labels, 100)) {
      if (!label || typeof label !== 'object' || Array.isArray(label) || typeof label.name !== 'string') remoteFailure();
      safeId(label.id);
    }
    for (const relation of connection(raw.relations, 100)) {
      if (!relation || typeof relation !== 'object' || Array.isArray(relation)
        || typeof relation.type !== 'string' || !relation.relatedIssue || typeof relation.relatedIssue !== 'object'
        || Array.isArray(relation.relatedIssue) || !ID.test(relation.relatedIssue.identifier)) remoteFailure();
      safeId(relation.id);
    }
    for (const comment of connection(raw.comments, 100)) {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment) || typeof comment.body !== 'string'
        || !comment.user || typeof comment.user !== 'object' || Array.isArray(comment.user)
        || typeof comment.user.name !== 'string') remoteFailure();
      safeId(comment.id); safeId(comment.user.id);
    }
    return raw;
  } catch (error) {
    if (error instanceof Error && error.code === 'ERR_PROVIDER_REMOTE') throw error;
    remoteFailure();
  }
}

export function normalizeLinear(raw) {
  const source = snapshotProviderJson(raw);
  validateIssue(source, source.identifier);
  const description = source.description ?? '';
  const labeledCriteria = description.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^(?:AC\s*\d*|acceptance criteria)\s*[:.-]/i.test(line));
  return immutableRedactedJson({
    id: source.identifier,
    internalId: source.id,
    kind: 'Issue',
    summary: source.title,
    description,
    acceptanceCriteria: labeledCriteria.length ? labeledCriteria : markdownAcceptanceCriteria(description),
    status: { id: source.state.id, name: source.state.name },
    team: { id: source.team.id, key: source.team.key },
    labels: source.labels.nodes.map(label => ({ id: label.id, name: label.name })),
    links: source.relations.nodes.map(relation => ({ id: relation.id, type: relation.type, issueId: relation.relatedIssue.identifier })),
    comments: source.comments.nodes.map(comment => ({ id: comment.id, body: comment.body, author: comment.user.name })),
    revision: source.updatedAt,
    url: source.url,
  });
}

function clock(configured) {
  const read = configured ?? (() => new Date().toISOString());
  if (typeof read !== 'function') failProvider('invalid-config', { provider: 'linear' });
  return () => {
    let value;
    try { value = read(); } catch { failProvider('invalid-config', { provider: 'linear' }); }
    return value;
  };
}

export function createLinearAdapter(input) {
  const config = captureRecord(input, new Set([
    'transport', 'baseUrl', 'headers', 'timeoutMs', 'maxResponseBytes', 'clock',
  ]), ['transport', 'baseUrl'], 'invalid-config');
  const now = clock(config.clock);
  const http = createProviderHttpClient({
    provider: 'linear',
    baseUrl: config.baseUrl,
    transport: config.transport,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
  });

  async function read(inputRead) {
    const request = captureRecord(inputRead, new Set(['kind', 'id', 'signal']), ['kind', 'id']);
    const kind = boundedString(request.kind, 16, /^issue$/);
    const id = boundedString(request.id, 64, ID);
    const wireBody = createProviderReadBody({
      provider: 'linear',
      payload: { query: QUERY, variables: { identifier: id } },
    });
    const response = await http.request({
      method: 'POST',
      path: '/graphql',
      wireBody,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const rawResponse = snapshotProviderJson(response.data);
    if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)
      || Object.hasOwn(rawResponse, 'errors') || !rawResponse.data || typeof rawResponse.data !== 'object'
      || !rawResponse.data.issue || typeof rawResponse.data.issue !== 'object') remoteFailure();
    const raw = validateIssue(rawResponse.data.issue, id);
    const normalized = normalizeLinear(raw);
    return createSourceEnvelope({
      provider: 'linear',
      sourceId: id,
      sourceUrl: normalized.url,
      fetchedAt: providerTimestamp(now, 'linear'),
      fixtureSource: false,
      raw,
      normalized: { ...normalized, requestedKind: kind },
      retryClassification: 'none',
      capabilities: { read: READ, write: WRITE },
    });
  }

  return createAdapter({
    provider: 'linear',
    fixtureSource: false,
    capabilities: { read: READ, write: WRITE },
    read,
    write: readOnlyWrite('linear'),
  });
}
