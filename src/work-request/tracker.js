import { validateAdapter } from '../adapters/contract.js';
import { createWorkRequest, WorkRequestError } from './contract.js';

const PROVIDERS = new Set(['jira', 'linear']);
const TICKET = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function fail() { throw new WorkRequestError(); }

function captureInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 4 || keys.some(key => typeof key !== 'string'
      || !['provider', 'ticketId', 'adapter', 'signal'].includes(key))) fail();
    if (!['provider', 'ticketId', 'adapter'].every(key => keys.includes(key))) fail();
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) fail();
      result[key] = input[key];
    }
    return result;
  } catch (error) {
    if (error instanceof WorkRequestError) throw error;
    fail();
  }
}

function providerName(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) fail();
  return value;
}

function ticketId(value) {
  if (typeof value !== 'string' || !TICKET.test(value)) fail();
  return value;
}

function trackerRevision(value, digest) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) fail();
  if (value === undefined || value === null || value === '') return `sha256:${digest}`;
  if (typeof value !== 'string' || value.length > 160 || value.includes('#')) fail();
  return `${value}#sha256:${digest}`;
}

function linkedContextRefs(provider, normalized) {
  const refs = [];
  if (provider === 'jira' && normalized.epicId) refs.push(`${provider}:${ticketId(normalized.epicId)}`);
  if (!Array.isArray(normalized.links) || Object.getPrototypeOf(normalized.links) !== Array.prototype
    || normalized.links.length > 256) fail();
  for (const link of normalized.links) {
    if (!link || typeof link !== 'object' || Array.isArray(link)) fail();
    refs.push(`${provider}:${ticketId(link.issueId)}`);
  }
  return [...new Set(refs)];
}

function requestFromEnvelope(provider, expectedId, envelope) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.provider !== provider || envelope.source?.id !== expectedId
      || envelope.normalized?.id !== expectedId || typeof envelope.source?.url !== 'string') fail();
    const normalized = envelope.normalized;
    return createWorkRequest({
      source: {
        kind: provider,
        ref: expectedId,
        revision: trackerRevision(normalized.revision, envelope.digest),
        url: envelope.source.url,
      },
      title: normalized.summary,
      description: normalized.description,
      acceptanceCriteria: normalized.acceptanceCriteria,
      contextRefs: linkedContextRefs(provider, normalized),
      capturedAt: envelope.fetchedAt,
    });
  } catch (error) {
    if (error instanceof WorkRequestError) throw error;
    fail();
  }
}

export async function resolveTrackerWorkRequest(input) {
  const request = captureInput(input);
  const provider = providerName(request.provider);
  const id = ticketId(request.ticketId);
  if (!validateAdapter(request.adapter) || request.adapter.provider !== provider
    || !request.adapter.capabilities.read.includes('issue')) fail();
  const envelope = await request.adapter.read({
    kind: 'issue',
    id,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return requestFromEnvelope(provider, id, envelope);
}
