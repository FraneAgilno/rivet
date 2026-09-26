import { createHash } from 'node:crypto';

import { claimApproval } from '../policy/approvals.js';
import { redactSecrets } from '../state/redact.js';

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const adapters = new WeakSet();
const governances = new WeakSet();
const idempotencyRegistries = new WeakMap();
const wireBodies = new WeakSet();
const conditionalCapabilities = new WeakMap();
const conditionalOperationResults = new WeakMap();

const MESSAGES = Object.freeze({
  'invalid-config': 'Provider adapter configuration is invalid.',
  'invalid-request': 'Provider request is invalid.',
  'invalid-envelope': 'Provider source envelope is invalid.',
  'invalid-adapter': 'Provider adapter contract is invalid.',
  'read-only': 'Provider adapter is read-only.',
  'remote': 'Provider rejected the request.',
  'transport': 'Provider transport failed.',
  timeout: 'Provider request timed out.',
  aborted: 'Provider request was cancelled.',
  'response-too-large': 'Provider response exceeded its safe limit.',
  'pagination-limit': 'Provider pagination exceeded its safe limit.',
  'state-conflict': 'Provider state changed before mutation.',
  'approval-required': 'A matching human approval is required.',
  'idempotency-reused': 'Provider idempotency key was already used.',
  'mutation-ambiguous': 'Provider mutation outcome is ambiguous.',
  'dns-unsafe': 'Provider hostname resolution is unsafe.',
});

export class ProviderAdapterError extends Error {
  constructor(reason = 'invalid-request', options = {}) {
    super(MESSAGES[reason] ?? MESSAGES['invalid-request']);
    this.name = 'ProviderAdapterError';
    this.code = `ERR_PROVIDER_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.provider = typeof options.provider === 'string' && PROVIDER.test(options.provider) ? options.provider : undefined;
    this.status = Number.isInteger(options.status) && options.status >= 100 && options.status <= 599 ? options.status : undefined;
    this.retryClassification = ['none', 'transient', 'permanent', 'ambiguous'].includes(options.retryClassification)
      ? options.retryClassification : 'permanent';
    this.details = Object.freeze({ reason });
  }
}

export function failProvider(reason, options) { throw new ProviderAdapterError(reason, options); }

export function captureRecord(input, allowed, required, reason = 'invalid-request') {
  let array;
  try { array = Array.isArray(input); } catch { failProvider(reason); }
  if (!input || typeof input !== 'object' || array) failProvider(reason);
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { failProvider(reason); }
  if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) failProvider(reason);
  const result = Object.create(null);
  for (const key of keys) {
    let descriptor;
    let entry;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
      entry = input[key];
    } catch { failProvider(reason); }
    if (!descriptor?.enumerable) failProvider(reason);
    result[key] = entry;
  }
  if (required.some(key => !Object.hasOwn(result, key))) failProvider(reason);
  return result;
}

export function boundedString(value, maximum = 1024, pattern, reason = 'invalid-request') {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.normalize('NFKC') !== value || /[\u0000-\u001f\u007f]/.test(value)
    || (pattern && !pattern.test(value))) failProvider(reason);
  return value;
}

export function boundedArray(input, maximum, convert, reason = 'invalid-request') {
  let array;
  let prototype;
  let length;
  try {
    array = Array.isArray(input);
    prototype = Object.getPrototypeOf(input);
    length = input.length;
  } catch { failProvider(reason); }
  if (!array || prototype !== Array.prototype || !Number.isSafeInteger(length) || length > maximum) failProvider(reason);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    let entry;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      entry = input[index];
    } catch { failProvider(reason); }
    if (!descriptor?.enumerable) failProvider(reason);
    try { result.push(convert(entry, index)); } catch { failProvider(reason); }
  }
  return Object.freeze(result);
}

function cloneJson(input, reason = 'invalid-request') {
  const active = new WeakSet();
  let nodes = 0;
  let stringBytes = 0;
  function clone(value, depth) {
    if (depth > 20) failProvider(reason);
    nodes += 1;
    if (nodes > 20_000) failProvider(reason);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value);
      if (value.length > 1_000_000 || stringBytes > 4 * 1024 * 1024 || value.includes('\0')) failProvider(reason);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) failProvider(reason);
      return value;
    }
    if (!value || typeof value !== 'object' || active.has(value)) failProvider(reason);
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) failProvider(reason);
        const result = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable) failProvider(reason);
          result.push(clone(value[index], depth + 1));
        }
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) failProvider(reason);
      const keys = Reflect.ownKeys(value);
      if (keys.length > 10_000 || keys.some(key => typeof key !== 'string' || key.length > 256)) failProvider(reason);
      const result = {};
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) failProvider(reason);
        Object.defineProperty(result, key, {
          value: clone(value[key], depth + 1), enumerable: true, configurable: false, writable: false,
        });
      }
      return Object.freeze(result);
    } finally { active.delete(value); }
  }
  try { return clone(input, 0); } catch { failProvider(reason); }
}

export function immutableRedactedJson(input, reason = 'invalid-request') {
  try { return cloneJson(redactSecrets(input, { environment: {} }), reason); } catch { failProvider(reason); }
}

export function snapshotProviderJson(input) {
  return immutableRedactedJson(cloneJson(input, 'invalid-request'), 'invalid-request');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function payloadDigest(value) {
  return createHash('sha256').update(canonical(cloneJson(value))).digest('hex');
}

function wireValue(write) {
  const payload = cloneJson(write.payload);
  let value;
  if (write.provider === 'jira' && write.action === 'comment') value = { body: payload.body };
  else if (write.provider === 'jira' && write.action === 'status') value = { transition: { id: payload.transitionId } };
  else if (write.provider === 'confluence' && write.action === 'page-update') value = {
    id: write.resourceId, status: 'current', title: payload.title,
    body: { representation: 'storage', value: payload.body }, version: { number: payload.version },
  };
  else if (['jira', 'linear'].includes(write.provider) && write.action === 'tracker-transition') {
    const jira = write.provider === 'jira';
    const identifier = jira ? /^[1-9][0-9]{0,19}$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const keys = jira ? ['transitionId'] : ['issueId', 'stateId'];
    if (!payload || Object.keys(payload).length !== keys.length || !keys.every(key => Object.hasOwn(payload, key))
      || !identifier.test(write.resourceId) || !identifier.test(write.expectedState)
      || !/^[a-f0-9]{64}$/.test(write.idempotencyKey) || !Number.isFinite(Date.parse(write.expectedVersion))
      || (jira ? !identifier.test(payload.transitionId) : payload.issueId !== write.resourceId || !identifier.test(payload.stateId)))
      failProvider('invalid-request', { provider: write.provider });
    value = jira ? { transition: { id: payload.transitionId } } : {
      query: 'mutation RivetTrackerTransition($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }',
      variables: { id: payload.issueId, input: { stateId: payload.stateId } },
    };
  }
  else if (write.provider === 'linear' && write.action === 'delivery-comment') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const lines = typeof payload?.body === 'string' ? payload.body.split('\n') : [];
    const validUrlLine = (line, prefix) => {
      if (typeof line !== 'string' || !line.startsWith(prefix)) return false;
      const value = line.slice(prefix.length);
      try {
        const url = new URL(value);
        return value.length <= 2048 && !/[\s<>`\[\]()]/.test(value)
          && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value;
      } catch { return false; }
    };
    if (!payload || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'issueId') || !Object.hasOwn(payload, 'body')
      || typeof payload.issueId !== 'string' || !uuid.test(payload.issueId) || payload.issueId !== write.resourceId
      || write.expectedState !== 'merged' || !/^[a-f0-9]{40}$/.test(write.expectedVersion) || !/^[a-f0-9]{64}$/.test(write.idempotencyKey)
      || ![5, 6].includes(lines.length) || lines[0] !== 'Rivet delivery update'
      || lines[1] !== `Merged commit: ${write.expectedVersion}` || !validUrlLine(lines[2], 'Review: ')
      || (lines.length === 6 && !validUrlLine(lines[3], 'Verified deployment: '))
      || lines.at(-2) !== '' || lines.at(-1) !== `Rivet delivery operation: ${write.idempotencyKey}`)
      failProvider('invalid-request', { provider: 'linear' });
    value = {
      query: 'mutation RivetDeliveryComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
      variables: { input: { issueId: payload.issueId, body: payload.body } },
    };
  }
  else if (write.provider === 'github' && write.action === 'comment') value = { body: payload.body };
  else if (write.provider === 'github' && write.action === 'pr') value = payload;
  else if (['github', 'gitlab', 'bitbucket'].includes(write.provider) && write.action === 'review-update') {
    const bodyKey = write.provider === 'github' ? 'body' : 'description';
    if (!payload || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'title') || !Object.hasOwn(payload, bodyKey)
      || write.expectedState !== 'open' || !/^[a-f0-9]{40}$/.test(write.expectedVersion) || !/^[a-f0-9]{64}$/.test(write.idempotencyKey)
      || typeof payload.title !== 'string' || !payload.title.trim() || Buffer.byteLength(payload.title) > 256 || /[\u0000-\u001f\u007f]/.test(payload.title)
      || typeof payload[bodyKey] !== 'string' || Buffer.byteLength(payload[bodyKey]) > 32000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(payload[bodyKey])) failProvider('invalid-request', { provider: write.provider });
    value = payload;
  }
  else if (['github', 'gitlab', 'bitbucket'].includes(write.provider) && write.action === 'review-request') {
    const github = write.provider === 'github', bitbucket = write.provider === 'bitbucket';
    const keys = github ? ['title', 'body', 'head', 'base', 'draft', 'maintainer_can_modify']
      : bitbucket ? ['title','description','source','destination','draft','close_source_branch'] : ['title', 'description', 'source_branch', 'target_branch', 'remove_source_branch', 'squash'];
    const body = github ? payload?.body : payload?.description;
    const source = github ? payload?.head : bitbucket ? payload?.source?.branch?.name : payload?.source_branch;
    const target = github ? payload?.base : bitbucket ? payload?.destination?.branch?.name : payload?.target_branch;
    const branch = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(value)
      && !value.includes('..') && !value.includes('//');
    if (!payload || Object.keys(payload).length !== keys.length || !keys.every(key => Object.hasOwn(payload, key))
      || write.expectedState !== 'absent' || !/^[a-f0-9]{40}$/.test(write.expectedVersion) || !/^[a-f0-9]{64}$/.test(write.idempotencyKey)
      || typeof payload.title !== 'string' || payload.title.length < 1 || payload.title.length > 256 || /[\u0000-\u001f\u007f]/.test(payload.title)
      || typeof body !== 'string' || body.length > 32100 || !body.endsWith(`\n\n<!-- rivet-review-operation:${write.idempotencyKey} -->`)
      || !branch(source) || !branch(target) || source === target
      || (github ? payload.draft !== false || payload.maintainer_can_modify !== false : bitbucket ? payload.draft !== false || payload.close_source_branch !== false || ![payload.source,payload.destination].every(part => part && Object.keys(part).length === 1 && part.branch && Object.keys(part.branch).length === 1 && Object.hasOwn(part.branch,'name')) : payload.remove_source_branch !== false || payload.squash !== false))
      failProvider('invalid-request', { provider: write.provider });
    value = payload;
  }
  else if (write.provider === 'github' && write.action === 'merge') {
    if (!payload || Object.keys(payload).length !== 2
      || !Object.hasOwn(payload, 'sha') || !Object.hasOwn(payload, 'merge_method')
      || !/^[a-f0-9]{40}$/.test(payload.sha) || payload.sha !== write.expectedVersion
      || !['merge', 'squash', 'rebase'].includes(payload.merge_method)) failProvider('invalid-request', { provider: 'github' });
    value = { sha: payload.sha, merge_method: payload.merge_method };
  }
  else if (write.provider === 'github' && write.action === 'deploy') {
    const keys = ['ref', 'auto_merge', 'task', 'environment', 'production_environment', 'transient_environment', 'payload'];
    if (!payload || Object.keys(payload).length !== keys.length || !keys.every(key => Object.hasOwn(payload, key))
      || !/^[a-f0-9]{40}$/.test(payload.ref) || payload.ref !== write.expectedVersion || write.expectedState !== 'merged'
      || payload.auto_merge !== false || payload.task !== 'rivet-deploy' || payload.transient_environment !== false
      || typeof payload.production_environment !== 'boolean'
      || typeof payload.environment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(payload.environment)
      || !payload.payload || Object.keys(payload.payload).length !== 2
      || !Object.hasOwn(payload.payload, 'rivetOperation') || !Object.hasOwn(payload.payload, 'workflow')
      || payload.payload.rivetOperation !== write.idempotencyKey || !/^[a-f0-9]{64}$/.test(payload.payload.rivetOperation)
      || typeof payload.payload.workflow !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.ya?ml$/.test(payload.payload.workflow))
      failProvider('invalid-request', { provider: 'github' });
    value = payload;
  }
  else if (write.provider === 'gitlab' && write.action === 'merge') {
    const keys = ['sha', 'squash', 'auto_merge', 'should_remove_source_branch'];
    if (!payload || Object.keys(payload).length !== keys.length || !keys.every(key => Object.hasOwn(payload, key))
      || !/^[a-f0-9]{40}$/.test(payload.sha) || payload.sha !== write.expectedVersion
      || payload.squash !== false || payload.auto_merge !== false || payload.should_remove_source_branch !== false)
      failProvider('invalid-request', { provider: 'gitlab' });
    value = { sha: payload.sha, squash: false, auto_merge: false, should_remove_source_branch: false };
  }
  else failProvider('invalid-request', { provider: write.provider });
  const safe = cloneJson(value);
  const redacted = redactSecrets(safe, { environment: {} });
  if (canonical(safe) !== canonical(redacted)) failProvider('invalid-request', { provider: write.provider });
  return safe;
}

export function createProviderWireBody(input) {
  const value = captureRecord(input, new Set([
    'provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload', 'payloadDigest', 'approval',
  ]), ['provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload']);
  const write = {
    provider: boundedString(value.provider, 32, PROVIDER), action: boundedString(value.action, 64, CAPABILITY),
    resourceId: boundedString(value.resourceId, 256, SAFE_ID), expectedState: boundedString(value.expectedState, 256, SAFE_ID),
    expectedVersion: boundedString(value.expectedVersion, 256), idempotencyKey: boundedString(value.idempotencyKey, 128, IDEMPOTENCY),
    payload: cloneJson(value.payload),
  };
  const bytes = JSON.stringify(wireValue(write));
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) failProvider('invalid-request', { provider: write.provider });
  const body = Object.freeze({ bytes, digest: createHash('sha256').update(bytes).digest('hex') });
  wireBodies.add(body);
  return body;
}

export function createProviderReadBody(input) {
  const value = captureRecord(input, new Set(['provider', 'payload']), ['provider', 'payload'], 'invalid-request');
  const provider = boundedString(value.provider, 32, PROVIDER);
  if (provider !== 'linear') failProvider('invalid-request', { provider });
  const payload = cloneJson(value.payload);
  const redacted = redactSecrets(payload, { environment: {} });
  if (canonical(payload) !== canonical(redacted)) failProvider('invalid-request', { provider });
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > 128 * 1024) failProvider('invalid-request', { provider });
  const body = Object.freeze({ bytes, digest: createHash('sha256').update(bytes).digest('hex') });
  wireBodies.add(body);
  return body;
}

// Models have a separate bounded JSON body brand; they never borrow a tracker
// read/mutation action. Protocol modules construct only non-streaming text calls.
export function createModelJsonBody(input) {
  const value = captureRecord(input, new Set(['provider', 'payload']), ['provider', 'payload'], 'invalid-request');
  const provider = boundedString(value.provider, 32, PROVIDER);
  if (!['anthropic', 'openai', 'gemini', 'ollama', 'openai-compatible'].includes(provider)) failProvider('invalid-request');
  const payload = cloneJson(value.payload);
  const redacted = redactSecrets(payload, { environment: {} });
  if (canonical(payload) !== canonical(redacted)) failProvider('invalid-request', { provider });
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > 512 * 1024) failProvider('invalid-request', { provider });
  const body = Object.freeze({ bytes, digest: createHash('sha256').update(bytes).digest('hex') });
  wireBodies.add(body);
  return body;
}

export function providerWireBytes(value) {
  if (!wireBodies.has(value)) failProvider('invalid-request');
  return value.bytes;
}

export function createProviderIdempotencyRegistry() {
  const registry = Object.freeze(Object.create(null));
  idempotencyRegistries.set(registry, new Map());
  return registry;
}

export function createTrustedConditionalMutationCapability(input) {
  const value = captureRecord(input, new Set(['provider', 'actions', 'execute']), ['provider', 'actions', 'execute'], 'invalid-config');
  const provider = boundedString(value.provider, 32, PROVIDER, 'invalid-config');
  const actionList = boundedArray(value.actions, 16, action => boundedString(action, 64, CAPABILITY, 'invalid-config'), 'invalid-config');
  const actions = new Set(actionList);
  if (typeof value.execute !== 'function' || actions.size !== actionList.length) failProvider('invalid-config', { provider });
  const capability = Object.freeze(Object.create(null));
  conditionalCapabilities.set(capability, { provider, actions, execute: value.execute });
  return capability;
}

export function validateTrustedConditionalMutationCapability(capability, provider, requiredActions) {
  const trusted = conditionalCapabilities.get(capability);
  return Boolean(trusted && trusted.provider === provider && requiredActions.every(action => trusted.actions.has(action)));
}

export async function executeTrustedConditionalMutation(capability, input) {
  const trusted = conditionalCapabilities.get(capability);
  if (!trusted || trusted.provider !== input.provider || !trusted.actions.has(input.action)
    || typeof input.dispatch !== 'function' || !wireBodies.has(input.wireBody)) failProvider('invalid-config', { provider: input.provider });
  let operationCalls = 0;
  let operationPromise;
  let operationClosed = false;
  let dispatchFailed = false;
  let dispatchError;
  const operation = Object.freeze({
    run() {
      operationCalls += 1;
      if (operationClosed || operationCalls !== 1) {
        const rejected = Promise.reject(new ProviderAdapterError('mutation-ambiguous', { provider: input.provider, retryClassification: 'ambiguous' }));
        rejected.catch(() => {});
        return rejected;
      }
      operationPromise = Promise.resolve().then(input.dispatch).then(result => {
        const receipt = Object.freeze(Object.create(null));
        conditionalOperationResults.set(receipt, { operation, result });
        return receipt;
      }, error => {
        dispatchFailed = true;
        dispatchError = error;
        throw error;
      });
      return operationPromise;
    },
  });
  const facts = Object.freeze({
    provider: input.provider, action: input.action, resourceId: input.resourceId,
    expectedState: input.expectedState, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey, wireBody: input.wireBody, operation,
  });
  let executorResult;
  let executorFailed = false;
  let executorError;
  try { executorResult = await trusted.execute(facts); } catch (error) {
    executorFailed = true;
    executorError = error;
  }
  operationClosed = true;
  if (operationCalls === 0 || !operationPromise) {
    if (executorFailed && executorError instanceof ProviderAdapterError
      && executorError.code === 'ERR_PROVIDER_STATE_CONFLICT') throw executorError;
    failProvider('mutation-ambiguous', { provider: input.provider, retryClassification: 'ambiguous' });
  }
  let receipt;
  try { receipt = await operationPromise; } catch {}
  if (operationCalls !== 1) {
    failProvider('mutation-ambiguous', { provider: input.provider, retryClassification: 'ambiguous' });
  }
  if (executorFailed) {
    if (dispatchFailed && executorError === dispatchError) throw dispatchError;
    failProvider('mutation-ambiguous', { provider: input.provider, retryClassification: 'ambiguous' });
  }
  const completed = conditionalOperationResults.get(executorResult);
  if (!completed || executorResult !== receipt || completed.operation !== operation || dispatchFailed) {
    failProvider('mutation-ambiguous', { provider: input.provider, retryClassification: 'ambiguous' });
  }
  return completed.result;
}

function capabilities(input, reason = 'invalid-envelope') {
  const value = captureRecord(input, new Set(['read', 'write']), ['read', 'write'], reason);
  const list = child => {
    const result = boundedArray(child, 64, item => boundedString(item, 64, CAPABILITY, reason), reason);
    if (new Set(result).size !== result.length) failProvider(reason);
    return result;
  };
  return Object.freeze({ read: list(value.read), write: list(value.write) });
}

function timestamp(value, reason = 'invalid-envelope') {
  boundedString(value, 32, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, reason);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) failProvider(reason);
  return value;
}

export function providerTimestamp(clock, provider) {
  if (typeof clock !== 'function') failProvider('invalid-config', { provider });
  try { return timestamp(clock(), 'invalid-config'); } catch { failProvider('invalid-config', { provider }); }
}

export function isSensitiveQueryKey(value) {
  if (typeof value !== 'string') return true;
  const key = value.normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return key === 'sig' || key.includes('signature') || key.includes('secret') || key.includes('token')
    || key.includes('credential') || key.includes('password') || key.includes('authorization')
    || key === 'auth' || key.startsWith('auth') || key.startsWith('xamz') || key.includes('key');
}

function safeUrl(value, reason = 'invalid-envelope') {
  boundedString(value, 2048, undefined, reason);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) failProvider(reason);
    for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    return url.href;
  } catch { failProvider(reason); }
}

export function sanitizeReferenceUrl(value) {
  boundedString(value, 4096);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) failProvider('invalid-request');
    for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    return url.href;
  } catch { failProvider('invalid-request'); }
}

export function sanitizeProviderLink(value) {
  boundedString(value, 4096);
  try {
    const relative = value.startsWith('/');
    if (value.startsWith('//') || (!relative && !value.startsWith('https://'))) failProvider('invalid-request');
    const url = new URL(value, 'https://provider.invalid');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) failProvider('invalid-request');
    for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    return relative ? `${url.pathname}${url.search}` : url.href;
  } catch { failProvider('invalid-request'); }
}

export function createSourceEnvelope(input) {
  const value = captureRecord(input, new Set([
    'provider', 'sourceId', 'sourceUrl', 'fetchedAt', 'fixtureSource', 'raw', 'normalized',
    'retryClassification', 'capabilities',
  ]), [
    'provider', 'sourceId', 'sourceUrl', 'fetchedAt', 'fixtureSource', 'raw', 'normalized',
    'retryClassification', 'capabilities',
  ], 'invalid-envelope');
  const provider = boundedString(value.provider, 32, PROVIDER, 'invalid-envelope');
  const sourceId = boundedString(value.sourceId, 256, SAFE_ID, 'invalid-envelope');
  const sourceUrl = safeUrl(value.sourceUrl);
  if (typeof value.fixtureSource !== 'boolean') failProvider('invalid-envelope');
  if (!['none', 'transient', 'permanent'].includes(value.retryClassification)) failProvider('invalid-envelope');
  const raw = immutableRedactedJson(value.raw, 'invalid-envelope');
  const digest = createHash('sha256').update(canonical(raw)).digest('hex');
  return Object.freeze({
    version: 1, provider, fixtureSource: value.fixtureSource,
    source: Object.freeze({ id: sourceId, url: sourceUrl }), fetchedAt: timestamp(value.fetchedAt), digest,
    rawPayloadRef: Object.freeze({ kind: 'redacted-sha256', digest, redacted: true }),
    normalized: immutableRedactedJson(value.normalized, 'invalid-envelope'),
    retry: Object.freeze({ classification: value.retryClassification }),
    capabilities: capabilities(value.capabilities),
  });
}

export function createAdapter(input) {
  const value = captureRecord(input, new Set([
    'provider', 'fixtureSource', 'capabilities', 'read', 'write',
  ]), ['provider', 'fixtureSource', 'capabilities', 'read', 'write'], 'invalid-adapter');
  const provider = boundedString(value.provider, 32, PROVIDER, 'invalid-adapter');
  if (typeof value.fixtureSource !== 'boolean' || typeof value.read !== 'function' || typeof value.write !== 'function') failProvider('invalid-adapter');
  const adapter = Object.freeze({
    version: 1, provider, fixtureSource: value.fixtureSource,
    capabilities: capabilities(value.capabilities, 'invalid-adapter'), read: value.read, write: value.write,
  });
  adapters.add(adapter);
  return adapter;
}

export function validateAdapter(adapter) { return adapters.has(adapter); }

function snapshotWriteIdentity(input) {
  const value = captureRecord(input, new Set([
    'provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload', 'approval',
  ]), [
    'provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload', 'approval',
  ]);
  const result = {
    provider: boundedString(value.provider, 32, PROVIDER),
    action: boundedString(value.action, 64, CAPABILITY),
    resourceId: boundedString(value.resourceId, 256, SAFE_ID),
    expectedState: boundedString(value.expectedState, 256, SAFE_ID),
    expectedVersion: boundedString(value.expectedVersion, 256),
    idempotencyKey: boundedString(value.idempotencyKey, 128, IDEMPOTENCY),
    payload: cloneJson(value.payload), approval: value.approval,
  };
  result.payloadDigest = payloadDigest(result.payload);
  return Object.freeze(result);
}

export function providerWriteResource(input) {
  const value = captureRecord(input, new Set([
    'provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload', 'payloadDigest', 'approval',
  ]), ['provider', 'action', 'resourceId', 'expectedState', 'expectedVersion', 'idempotencyKey', 'payload']);
  const provider = boundedString(value.provider, 32, PROVIDER);
  const action = boundedString(value.action, 64, CAPABILITY);
  const resourceId = boundedString(value.resourceId, 256, SAFE_ID);
  const expectedState = boundedString(value.expectedState, 256, SAFE_ID);
  const expectedVersion = boundedString(value.expectedVersion, 256);
  const key = boundedString(value.idempotencyKey, 128, IDEMPOTENCY);
  const digest = payloadDigest(value.payload);
  if (value.payloadDigest !== undefined && value.payloadDigest !== digest) failProvider('invalid-request');
  const wire = createProviderWireBody({ provider, action, resourceId, expectedState, expectedVersion, idempotencyKey: key, payload: value.payload });
  const tuple = { provider, action, resourceId, expectedState, expectedVersion, idempotencyKey: key, wireDigest: wire.digest };
  return `provider-write-sha256:${createHash('sha256').update(canonical(tuple)).digest('hex')}`;
}

export function createProviderWriteGovernance(input, providerInput) {
  const provider = boundedString(providerInput, 32, PROVIDER, 'invalid-config');
  const value = captureRecord(input, new Set([
    'approvalRegistry', 'idempotencyRegistry', 'expectedApproverId', 'subjectId', 'now',
  ]), ['approvalRegistry', 'idempotencyRegistry', 'expectedApproverId', 'subjectId', 'now'], 'invalid-config');
  if (typeof value.now !== 'function') failProvider('invalid-config', { provider });
  if (!idempotencyRegistries.has(value.idempotencyRegistry)) failProvider('invalid-config', { provider });
  const governance = Object.freeze({
    approvalRegistry: value.approvalRegistry,
    idempotencyRegistry: value.idempotencyRegistry,
    expectedApproverId: boundedString(value.expectedApproverId, 64, /^[a-z][a-z0-9-]*$/, 'invalid-config'),
    subjectId: boundedString(value.subjectId, 64, /^[a-z][a-z0-9-]*$/, 'invalid-config'),
    now: value.now,
  });
  governances.add(governance);
  return governance;
}

function governanceNow(governance, provider) {
  if (!governances.has(governance)) failProvider('approval-required', { provider });
  let value;
  try { value = governance.now(); } catch { failProvider('approval-required', { provider }); }
  if (!Number.isSafeInteger(value) || value < 0) failProvider('approval-required', { provider });
  return value;
}

export async function executeGovernedWrite(input, options) {
  const write = snapshotWriteIdentity(input);
  const provider = boundedString(options?.provider, 32, PROVIDER, 'invalid-config');
  if (write.provider !== provider || !options.actions?.has(write.action)
    || typeof options.preflight !== 'function'
    || typeof options.prepare !== 'function' || typeof options.mutate !== 'function'
    || !governances.has(options.governance)) failProvider('invalid-request', { provider });
  const keys = idempotencyRegistries.get(options.governance.idempotencyRegistry);
  if (!keys || keys.has(write.idempotencyKey)) failProvider('idempotency-reused', { provider });
  const resource = providerWriteResource(write);
  const reservation = { binding: resource, state: 'pending' };
  keys.set(write.idempotencyKey, reservation);
  let state;
  let prepared;
  try {
    state = await options.preflight(write);
    if (state?.state !== write.expectedState || state?.version !== write.expectedVersion) failProvider('state-conflict', { provider });
    prepared = options.prepare(write, state);
    if (prepared && typeof prepared.then === 'function') failProvider('invalid-config', { provider });
  } catch (error) {
    keys.delete(write.idempotencyKey);
    if (error instanceof ProviderAdapterError) throw error;
    failProvider('transport', { provider, retryClassification: 'transient' });
  }
  let claim;
  try {
    claim = claimApproval(write.approval, {
      subjectId: options.governance.subjectId, action: 'provider.write', resource, policyId: 'authority.external-write',
    }, {
      registry: options.governance.approvalRegistry, expectedApproverId: options.governance.expectedApproverId,
      requireHumanApprover: true, requireSingleUse: true, nowMs: governanceNow(options.governance, provider),
    });
  } catch {
    keys.delete(write.idempotencyKey);
    failProvider('approval-required', { provider });
  }
  if (!claim.valid) {
    keys.delete(write.idempotencyKey);
    failProvider('approval-required', { provider });
  }
  if (!claim.finalize()) {
    claim.release();
    keys.delete(write.idempotencyKey);
    failProvider('approval-required', { provider });
  }
  reservation.state = 'dispatching';
  try {
    const result = await options.mutate(write, state, prepared);
    if (!claim.publish()) failProvider('mutation-ambiguous', { provider, retryClassification: 'ambiguous' });
    reservation.state = 'succeeded';
    return Object.freeze({
      version: 1, provider, action: write.action, resourceId: write.resourceId,
      idempotencyKey: write.idempotencyKey, payloadDigest: write.payloadDigest,
      status: 'written', result: immutableRedactedJson(result),
    });
  } catch (error) {
    const definite = error instanceof ProviderAdapterError && (error.code === 'ERR_PROVIDER_STATE_CONFLICT'
      || (error.code === 'ERR_PROVIDER_REMOTE' && Number.isInteger(error.status)
      && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)));
    if (definite) {
      if (!claim.rollback()) failProvider('mutation-ambiguous', { provider, retryClassification: 'ambiguous' });
      keys.delete(write.idempotencyKey);
      throw error;
    }
    reservation.state = 'ambiguous';
    failProvider('mutation-ambiguous', { provider, retryClassification: 'ambiguous' });
  }
}

export function readOnlyWrite(provider) {
  return function write() { return Promise.reject(new ProviderAdapterError('read-only', { provider })); };
}
