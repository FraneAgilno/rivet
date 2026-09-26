import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { containsSecretMaterial, immutableJson } from '../clients/contract.js';

const INPUT_KEYS = new Set([
  'source', 'title', 'description', 'acceptanceCriteria', 'contextRefs', 'capturedAt',
]);
const OPTIONAL_KEYS = ['context', 'criteriaProvenance'];
const REQUEST_KEYS = new Set(['schemaVersion', ...INPUT_KEYS, 'digest']);
const SOURCE_KEYS = new Set(['kind', 'ref', 'revision', 'url']);
const SOURCE_KINDS = new Set(['inline', 'markdown', 'jira', 'linear', 'host-observation']);
const TICKET = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_IPV4 = /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168|224|240)(?:\.|$)/;

export class WorkRequestError extends Error {
  constructor() {
    super('Work request is invalid.');
    this.name = 'WorkRequestError';
    this.code = 'ERR_INVALID_WORK_REQUEST';
    this.safeMessage = this.message;
  }
}

function fail() { throw new WorkRequestError(); }

function captureRecord(input, allowed, required = allowed) {
  let array;
  let prototype;
  let keys;
  try {
    array = Array.isArray(input);
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch { fail(); }
  if (!input || typeof input !== 'object' || array
    || (prototype !== Object.prototype && prototype !== null)
    || keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail();
  const output = Object.create(null);
  for (const key of keys) {
    let descriptor;
    let value;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
      value = input[key];
    } catch { fail(); }
    if (!descriptor?.enumerable) fail();
    output[key] = value;
  }
  if ([...required].some(key => !Object.hasOwn(output, key))) fail();
  return output;
}

function string(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.normalize('NFKC') !== value || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || containsSecretMaterial(value)) fail();
  return value;
}

function list(value, { maximum, itemMaximum }) {
  let array;
  let prototype;
  let length;
  let keys;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    keys = Reflect.ownKeys(value);
  } catch { fail(); }
  if (!array || prototype !== Array.prototype || !Number.isSafeInteger(length)
    || length < 0 || length > maximum || keys.length !== length + 1) fail();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output.push(string(descriptor.value, itemMaximum));
  }
  if (new Set(output).size !== output.length) fail();
  return Object.freeze(output);
}

// User additions remain explicit, bounded data, never inferred tracker content.
export function userAcceptanceCriteria(input) {
  const values = list(input, { maximum: 256, itemMaximum: 4096 });
  if (!values.length || Buffer.byteLength(JSON.stringify(values), 'utf8') > 64 * 1024
    || values.some(value => !value.trim() || /[\u0000-\u001f\u007f]/.test(value))) fail();
  return values;
}

export function parseAcceptanceCriteriaText(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 64 * 1024
    || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(input)) fail();
  const normalized = input.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) fail();
  return userAcceptanceCriteria(normalized.split('\n').map(value => value.trim()));
}

function criteriaProvenance(input, output) {
  const value = captureRecord(input, new Set(['sourceAcceptanceCriteria', 'userAcceptanceCriteria']));
  if (!['jira', 'linear'].includes(output.source.kind)) fail();
  const sourceAcceptanceCriteria = list(value.sourceAcceptanceCriteria, { maximum: 256, itemMaximum: 4096 });
  const additions = userAcceptanceCriteria(value.userAcceptanceCriteria);
  if (JSON.stringify([...new Set([...sourceAcceptanceCriteria, ...additions])]) !== JSON.stringify(output.acceptanceCriteria)) fail();
  return Object.freeze({ sourceAcceptanceCriteria, userAcceptanceCriteria: additions });
}

function safeRelativePath(value) {
  const normalized = string(value, 512).replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('/') || normalized.endsWith('/')
    || normalized.includes('//') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')) fail();
  return normalized;
}

function safeUrl(value, host = false) {
  string(value, 2048);
  let parsed;
  try { parsed = new URL(value); } catch { fail(); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (!host && parsed.search) || parsed.hash
    || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (isIP(hostname) === 4 && PRIVATE_IPV4.test(hostname))
    || (isIP(hostname) === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')))) fail();
  if (host && [...parsed.searchParams].some(([key, item]) => !['node-id', 'pageId'].includes(key) || !/^[A-Za-z0-9:_-]{1,128}$/.test(item))) fail();
  return parsed.toString();
}

function timestamp(value) {
  string(value, 64);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) fail();
  return value;
}

function source(input) {
  const value = captureRecord(input, SOURCE_KEYS, new Set(['kind', 'ref']));
  const kind = string(value.kind, 16);
  if (!SOURCE_KINDS.has(kind)) fail();
  let ref = string(value.ref, 512);
  if (kind === 'inline' && ref !== 'inline') fail();
  if (kind === 'markdown') ref = safeRelativePath(ref);
  if ((kind === 'jira' || kind === 'linear') && !TICKET.test(ref)) fail();
  let revision;
  if (value.revision !== undefined) {
    revision = string(value.revision, 256);
    if (kind === 'markdown' && !SHA256_REVISION.test(revision)) fail();
  }
  const result = {
    kind,
    ref,
    ...(revision === undefined ? {} : { revision }),
    ...(value.url === undefined ? {} : { url: safeUrl(value.url, kind === 'host-observation') }),
  };
  if ((kind === 'inline' || kind === 'markdown') && result.url !== undefined) fail();
  return Object.freeze(result);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function context(input) {
  let value;
  try { value = immutableJson(input); } catch { fail(); }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) fail();
  captureRecord(value, new Set(['sources', 'userAcceptanceCriteria']));
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 16) fail();
  const identities = new Set();
  for (const item of value.sources) {
    captureRecord(item, new Set(['provider', 'providerId', 'projectId', 'resourceId', 'url', 'revision',
      'capturedAt', 'transport', 'assurance', 'tool', 'content', 'contentDigest']));
    if (!['jira', 'linear', 'figma', 'confluence', 'generic'].includes(item.provider)
      || item.transport !== 'harness-mcp' || item.assurance !== 'harness-observed') fail();
    for (const key of ['providerId', 'projectId', 'resourceId', 'revision', 'tool']) string(item[key], 200);
    safeUrl(item.url, true);
    timestamp(item.capturedAt);
    if (!item.content || typeof item.content !== 'object' || Array.isArray(item.content)
      || containsSecretMaterial(JSON.stringify(item.content))) fail();
    const digest = createHash('sha256').update(canonical(item.content)).digest('hex');
    if (item.contentDigest !== digest) fail();
    const identity = `${item.providerId}:${item.resourceId}`;
    if (identities.has(identity)) fail();
    identities.add(identity);
  }
  list(value.userAcceptanceCriteria, { maximum: 256, itemMaximum: 4096 });
  return value;
}

function capturedInput(input, request = false) {
  const required = request ? REQUEST_KEYS : INPUT_KEYS;
  const value = captureRecord(input, new Set([...required, ...OPTIONAL_KEYS]), required);
  if (request && value.schemaVersion !== 1) fail();
  const acceptanceCriteria = list(value.acceptanceCriteria, { maximum: 256, itemMaximum: 4096 });
  if (acceptanceCriteria.length === 0) fail();
  const contextRefs = list(value.contextRefs, { maximum: 256, itemMaximum: 2048 });
  const output = {
    schemaVersion: 1,
    source: source(value.source),
    title: string(value.title, 500),
    description: string(value.description, 131072),
    acceptanceCriteria,
    contextRefs,
    capturedAt: timestamp(value.capturedAt),
  };
  if (value.context !== undefined) output.context = context(value.context);
  if (value.criteriaProvenance !== undefined) output.criteriaProvenance = criteriaProvenance(value.criteriaProvenance, output);
  if (output.source.kind === 'host-observation') {
    const primary = output.context?.sources[0];
    if (!primary || output.source.ref !== `${primary.providerId}:${primary.resourceId}`
      || output.source.revision !== `sha256:${primary.contentDigest}` || output.source.url !== primary.url) fail();
  }
  if (request) output.digest = string(value.digest, 64);
  return output;
}

function digestPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    source: value.source,
    title: value.title,
    description: value.description,
    acceptanceCriteria: value.acceptanceCriteria,
    contextRefs: value.contextRefs,
    capturedAt: value.capturedAt,
    ...(value.context === undefined ? {} : { context: value.context }),
    ...(value.criteriaProvenance === undefined ? {} : { criteriaProvenance: value.criteriaProvenance }),
  };
}

export function workRequestDigest(input) {
  const value = capturedInput(input, Object.hasOwn(input ?? {}, 'digest'));
  return createHash('sha256').update(canonical(digestPayload(value))).digest('hex');
}

export function createWorkRequest(input) {
  const value = capturedInput(input);
  return Object.freeze({ ...value, digest: createHash('sha256').update(canonical(value)).digest('hex') });
}

export function validateWorkRequest(input) {
  const value = capturedInput(input, true);
  if (!/^[a-f0-9]{64}$/.test(value.digest)
    || createHash('sha256').update(canonical(digestPayload(value))).digest('hex') !== value.digest) fail();
  return input;
}
