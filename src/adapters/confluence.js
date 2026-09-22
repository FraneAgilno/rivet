import {
  boundedString,
  captureRecord,
  createAdapter,
  createProviderWriteGovernance,
  createProviderWireBody,
  createSourceEnvelope,
  executeGovernedWrite,
  failProvider,
  immutableRedactedJson,
  providerTimestamp,
  sanitizeProviderLink,
  snapshotProviderJson,
} from './contract.js';
import { createProviderHttpClient } from './http.js';

const READ = Object.freeze(['page']);
const WRITE = Object.freeze(['page-update']);
const PAGE_ID = /^[1-9][0-9]{0,63}$/;

function canonicalParentIds(value) {
  const parents = value?.ancestors === undefined
    ? (value?.parentId === undefined ? [] : [{ id: value.parentId }])
    : value.ancestors;
  if (!Array.isArray(parents)) failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' });
  const ids = [];
  for (const parent of parents) {
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)
      || typeof parent.id !== 'string' || !PAGE_ID.test(parent.id)) {
      failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' });
    }
    ids.push(parent.id);
  }
  if (new Set(ids).size !== ids.length) failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' });
  return ids;
}

function validatePage(value, expectedId, full = false) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== expectedId
      || typeof value.status !== 'string' || !Number.isSafeInteger(value.version?.number)) throw new Error();
    if (full && (typeof value.title !== 'string' || !value.body || typeof value.body !== 'object'
      || (value.ancestors !== undefined && (!Array.isArray(value.ancestors)
        || value.ancestors.some(parent => !parent || typeof parent.id !== 'string' || !PAGE_ID.test(parent.id))
        || new Set(value.ancestors.map(parent => parent.id)).size !== value.ancestors.length)))) throw new Error();
    return value;
  } catch { failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' }); }
}

export function normalizeConfluence(raw) {
  const source = snapshotProviderJson(raw);
  const parentIds = canonicalParentIds(source);
  const links = {};
  for (const [key, value] of Object.entries(source?._links ?? {})) {
    if (typeof value !== 'string') failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' });
    try { links[key] = sanitizeProviderLink(value); } catch { failProvider('remote', { provider: 'confluence', retryClassification: 'permanent' }); }
  }
  return immutableRedactedJson({
    id: String(source?.id ?? ''), title: String(source?.title ?? ''), status: String(source?.status ?? ''),
    content: source?.body?.storage ?? source?.body ?? null,
    version: { number: Number(source?.version?.number ?? 0) },
    parentIds,
    links,
  });
}

export function createConfluenceAdapter(input) {
  const config = captureRecord(input, new Set([
    'transport', 'baseUrl', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'clock', 'governance',
  ]), ['transport', 'baseUrl'], 'invalid-config');
  const now = config.clock ?? (() => new Date().toISOString());
  if (typeof now !== 'function') failProvider('invalid-config', { provider: 'confluence' });
  const governance = config.governance === undefined ? null : createProviderWriteGovernance(config.governance, 'confluence');
  const http = createProviderHttpClient({
    provider: 'confluence', baseUrl: config.baseUrl, transport: config.transport,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
  });

  async function read(inputRead) {
    const request = captureRecord(inputRead, new Set(['kind', 'id', 'signal']), ['kind', 'id']);
    boundedString(request.kind, 16, /^page$/);
    const id = boundedString(request.id, 64, PAGE_ID);
    const response = await http.request({
      method: 'GET', path: `/wiki/api/v2/pages/${id}?body-format=storage&include-ancestors=true`,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    validatePage(response.data, id, true);
    return createSourceEnvelope({
      provider: 'confluence', sourceId: id, sourceUrl: http.urlFor(`/wiki/pages/viewpage.action?pageId=${id}`),
      fetchedAt: providerTimestamp(now, 'confluence'), fixtureSource: false, raw: response.data, normalized: normalizeConfluence(response.data),
      retryClassification: 'none', capabilities: { read: READ, write: WRITE },
    });
  }

  function write(inputWrite) {
    if (!governance) failProvider('approval-required', { provider: 'confluence' });
    return executeGovernedWrite(inputWrite, {
      provider: 'confluence', actions: new Set(WRITE), governance,
      async preflight(writeRequest) {
        const id = boundedString(writeRequest.resourceId, 64, PAGE_ID);
        const response = await http.request({ method: 'GET', path: `/wiki/api/v2/pages/${id}` });
        validatePage(response.data, id);
        return Object.freeze({
          state: String(response.data?.status ?? ''), version: String(response.data?.version?.number ?? ''),
          condition: response.headers.etag,
        });
      },
      prepare(writeRequest, state) {
        const id = boundedString(writeRequest.resourceId, 64, /^[1-9][0-9]*$/);
        const payload = captureRecord(writeRequest.payload, new Set(['title', 'body', 'version']), ['title', 'body', 'version']);
        const title = boundedString(payload.title, 512);
        const body = boundedString(payload.body, 250_000);
        if (!Number.isSafeInteger(payload.version) || payload.version !== Number(writeRequest.expectedVersion) + 1) failProvider('invalid-request', { provider: 'confluence' });
        return Object.freeze({
          method: 'PUT', path: `/wiki/api/v2/pages/${id}`,
          headers: {
            'idempotency-key': writeRequest.idempotencyKey,
            'if-match': state.condition ?? writeRequest.expectedVersion,
          },
          wireBody: createProviderWireBody(writeRequest),
        });
      },
      async mutate(_writeRequest, _state, prepared) {
        const data = (await http.request(prepared)).data;
        validatePage(data, _writeRequest.resourceId);
        if (String(data.version.number) !== String(_writeRequest.payload.version)) failProvider('remote', { provider: 'confluence' });
        return data;
      },
    });
  }

  return createAdapter({
    provider: 'confluence', fixtureSource: false, capabilities: { read: READ, write: WRITE }, read, write,
  });
}
