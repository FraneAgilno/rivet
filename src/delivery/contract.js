import { createHash } from 'node:crypto';
import { containsSecretMaterial } from '../clients/contract.js';
import { parseRepositoryRemote } from '../repositories/identity.js';

export const ACTIONS = Object.freeze(['branch-publish', 'review-request', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-transition']);
export const STAGES = Object.freeze([
  'locally-verified',
  'branch-published',
  'review-requested',
  'checks-passed',
  'merge-approved',
  'merged',
  'deployed',
  'tracker-updated',
  'tracker-status-confirmed',
]);
export class DeliveryError extends Error {
  constructor(reason = 'invalid-input') {
    super(`Delivery operation failed: ${reason}.`);
    this.name = 'DeliveryError';
    this.code = `ERR_DELIVERY_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
  }
}
export function fail(reason) {
  throw new DeliveryError(reason);
}
export function ensure(value, reason = 'invalid-input') {
  if (!value) fail(reason);
}
export function plain(input) {
  let nodes = 0;
  function copy(value, depth) {
    ensure(++nodes <= 10000 && depth <= 20);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      ensure(value.length <= 65536 && !containsSecretMaterial(value));
      return value;
    }
    if (typeof value === 'number') {
      ensure(Number.isSafeInteger(value));
      return value;
    }
    ensure(value && typeof value === 'object');
    const array = Array.isArray(value);
    ensure(
      Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype) ||
        (!array && Object.getPrototypeOf(value) === null)
    );
    const out = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      ensure(typeof key === 'string' && key !== '__proto__');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
      if (array) ensure(/^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
      else ensure(!containsSecretMaterial(`${key}: sensitive-value`));
      out[key] = copy(descriptor.value, depth + 1);
    }
    if (array) ensure(out.length === value.length && Object.keys(out).length === value.length);
    return Object.freeze(out);
  }
  const result = copy(input, 0);
  ensure(Buffer.byteLength(JSON.stringify(result)) <= 262144);
  return result;
}
export function exact(value, keys, optional = []) {
  ensure(value && typeof value === 'object' && !Array.isArray(value));
  ensure(
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key)) &&
      keys.every((key) => Object.hasOwn(value, key))
  );
  return value;
}
export function id(value) {
  ensure(typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value));
  return value;
}
export function sha(value) {
  ensure(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value));
  return value;
}
export function digest(value) {
  ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  return value;
}
export function timestamp(value) {
  ensure(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
  return value;
}
export function ref(value) {
  ensure(
    typeof value === 'string' &&
      /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(value) &&
      !value.includes('..') &&
      !value.includes('//')
  );
  return value;
}
export function hash(value) {
  const canonical = (item) =>
    item === null || typeof item !== 'object'
      ? JSON.stringify(item)
      : Array.isArray(item)
        ? `[${item.map(canonical).join(',')}]`
        : `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
            .join(',')}}`;
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function candidate(input) {
  const value = plain(input);
  exact(
    value,
    ['runId', 'repository', 'sourceBranch', 'targetBranch', 'localVerification'],
    ['reviewNumber']
  );
  id(value.runId);
  ref(value.sourceBranch);
  ref(value.targetBranch);
  const repository = parseRepositoryRemote(value.repository.url);
  ensure(hash(repository) === hash(value.repository));
  const proof = exact(value.localVerification, [
    'runId',
    'headSha',
    'evidenceDigest',
    'verifiedAt',
    'status',
  ]);
  ensure(proof.runId === value.runId && proof.status === 'passed');
  sha(proof.headSha);
  digest(proof.evidenceDigest);
  timestamp(proof.verifiedAt);
  ensure(
    value.reviewNumber === undefined || (Number.isSafeInteger(value.reviewNumber) && value.reviewNumber > 0)
  );
  return plain({ ...value, headSha: proof.headSha, reviewNumber: value.reviewNumber ?? null });
}
export function validateCandidate(value) {
  const { headSha, reviewNumber, ...input } = value;
  const result = candidate({ ...input, ...(reviewNumber === null ? {} : { reviewNumber }) });
  ensure(result.headSha === headSha);
  return value;
}
export function observation(input, target) {
  const value = plain(input);
  exact(value, [
    'repositoryUrl',
    'sourceBranch',
    'targetBranch',
    'headSha',
    'baseSha',
    'review',
    'checks',
    'reviews',
    'observedAt',
  ], ['publication']);
  if (value.publication !== undefined) {
    const p = exact(value.publication, ['destinationUrl', 'ref', 'remoteSha']);
    ensure(p.destinationUrl === target.repository.url + '.git' && p.ref === `refs/heads/${target.sourceBranch}`, 'changed-facts');
    ensure(p.remoteSha === null || sha(p.remoteSha), 'changed-facts');
  }
  timestamp(value.observedAt);
  sha(value.baseSha);
  ensure(
    value.repositoryUrl === target.repository.url &&
      value.sourceBranch === target.sourceBranch &&
      value.targetBranch === target.targetBranch &&
      value.headSha === target.headSha,
    'changed-facts'
  );
  if (value.review !== null) {
    const review = exact(value.review, ['number', 'state', 'url', 'headSha']);
    ensure(
      Number.isSafeInteger(review.number) &&
        review.number > 0 &&
        (target.reviewNumber === null || review.number === target.reviewNumber)
    );
    ensure(
      ['open', 'closed', 'merged'].includes(review.state) && review.headSha === target.headSha,
      'changed-facts'
    );
    const segment = { github: 'pull', bitbucket: 'pull-requests', gitlab: '-/merge_requests' }[
      target.repository.provider
    ];
    ensure(review.url === `${target.repository.url}/${segment}/${review.number}`);
  }
  for (const key of ['checks', 'reviews']) {
    const policy = exact(value[key], ['headSha', 'policy', 'satisfied', 'evidenceDigest']);
    ensure(policy.headSha === target.headSha, 'changed-facts');
    digest(policy.evidenceDigest);
    ensure(
      policy.policy === 'unknown'
        ? policy.satisfied === null
        : policy.policy === 'known' && typeof policy.satisfied === 'boolean'
    );
  }
  return value;
}
export function ready(value) {
  return (
    value?.review?.state === 'open' &&
    ['checks', 'reviews'].every((key) => value[key].policy === 'known' && value[key].satisfied === true)
  );
}
export function factsDigest(value) {
  const { observedAt, ...facts } = value;
  return hash(facts);
}
export function validateReceipt(input, operation) {
  const value = plain(input);
  exact(value, ['status', 'operationDigest', 'headSha', 'evidenceDigest', 'resourceUrl', 'commitSha']);
  ensure(
    value.status === 'succeeded' &&
      value.operationDigest === operation.digest &&
      value.headSha === operation.candidate.headSha,
    'invalid-receipt'
  );
  digest(value.evidenceDigest);
  let url;
  try {
    url = new URL(value.resourceUrl);
  } catch {
    fail('invalid-receipt');
  }
  ensure(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'invalid-receipt'
  );
  ensure(value.commitSha === null || sha(value.commitSha));
  if (operation.action === 'merge') sha(value.commitSha);
  if (operation.action === 'branch-publish') ensure(value.commitSha === operation.candidate.headSha && value.resourceUrl === operation.candidate.repository.url, 'invalid-receipt');
  return value;
}
export function mergeReceiptFor(operations, action) {
  if (!['deploy', 'tracker-update', 'tracker-transition'].includes(action)) return null;
  const merge = operations.find(
    (operation) => operation.action === 'merge' && operation.state === 'succeeded'
  );
  ensure(merge?.receipt?.commitSha, 'missing-merge-receipt');
  return merge.receipt;
}

function publicationPayload(value, target) {
  exact(value, ['destinationUrl', 'ref', 'headSha']);
  ensure(value.destinationUrl === target.repository.url + '.git' && value.ref === `refs/heads/${target.sourceBranch}` && value.headSha === target.headSha, 'invalid-publication');
}

export function validateRecord(input) {
  const value = plain(input);
  exact(value, [
    'schemaVersion',
    'stage',
    'candidate',
    'observation',
    'proposal',
    'operations',
    'usedApprovalIds',
    'createdAt',
    'updatedAt',
  ]);
  ensure(value.schemaVersion === 1 && STAGES.includes(value.stage));
  validateCandidate(value.candidate);
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  ensure(value.updatedAt >= value.createdAt);
  if (value.observation !== null) observation(value.observation, value.candidate);
  ensure(
    Array.isArray(value.operations) &&
      value.operations.length <= 64 &&
      Array.isArray(value.usedApprovalIds) &&
      value.usedApprovalIds.length <= 64 &&
      new Set(value.usedApprovalIds).size === value.usedApprovalIds.length
  );
  for (const operation of value.operations) {
    exact(operation, [
      'digest',
      'action',
      'payload',
      'candidate',
      'factsDigest',
      'mergeReceipt',
      'approvalId',
      'dispatchedAt',
      'state',
      'receipt',
    ]);
    ensure(
      hash(operation.mergeReceipt) ===
        hash(
          mergeReceiptFor(value.operations.slice(0, value.operations.indexOf(operation)), operation.action)
        ),
      'merge-receipt-mismatch'
    );
    if (operation.action === 'branch-publish') publicationPayload(operation.payload, value.candidate);
    digest(operation.digest);
    digest(operation.factsDigest);
    id(operation.approvalId);
    timestamp(operation.dispatchedAt);
    ensure(
      ACTIONS.includes(operation.action) &&
        ['dispatching', 'indeterminate', 'succeeded', 'not-applied'].includes(operation.state)
    );
    ensure(
      hash(operation.candidate) === hash(value.candidate) &&
        value.usedApprovalIds.includes(operation.approvalId)
    );
    if (operation.receipt !== null) {
      ensure(operation.state === 'succeeded');
      validateReceipt(operation.receipt, operation);
    } else ensure(operation.state !== 'succeeded');
  }
  if (value.proposal !== null) {
    const p = exact(value.proposal, [
      'digest',
      'action',
      'payload',
      'expiresAt',
      'factsDigest',
      'nonce',
      'resource',
      'approvalResource',
      'providerId',
      'mergeReceipt',
    ]);
    ensure(
      hash(p.mergeReceipt) === hash(mergeReceiptFor(value.operations, p.action)),
      'merge-receipt-mismatch'
    );
    if (p.action === 'branch-publish') publicationPayload(p.payload, value.candidate);
    digest(p.digest);
    digest(p.factsDigest);
    timestamp(p.expiresAt);
    id(p.providerId);
    ensure(ACTIONS.includes(p.action) && typeof p.nonce === 'string');
    const body = {
      candidate: value.candidate,
      action: p.action,
      payload: p.payload,
      expiresAt: p.expiresAt,
      factsDigest: p.factsDigest,
      nonce: p.nonce,
      providerId: p.providerId,
      mergeReceipt: p.mergeReceipt,
    };
    ensure(
      hash(body) === p.digest &&
        p.resource === `delivery:${p.digest}` &&
        p.approvalResource === `${p.providerId}:${p.action}:${p.resource}`
    );
  }
  const success = (action) => value.operations.some((op) => op.action === action && op.state === 'succeeded');
  if (['merged', 'deployed', 'tracker-updated', 'tracker-status-confirmed'].includes(value.stage)) ensure(success('merge'));
  if (value.stage === 'branch-published') ensure(success('branch-publish'));
  if (value.stage === 'deployed') ensure(success('deploy'));
  if (value.stage === 'tracker-status-confirmed') ensure(success('tracker-transition'));
  if (value.stage === 'tracker-updated') ensure(success('tracker-update'));
  if (value.stage === 'merge-approved')
    ensure(
      value.operations.some(
        (op) => op.action === 'merge' && ['dispatching', 'indeterminate', 'not-applied'].includes(op.state)
      )
    );
  if (value.stage === 'review-requested')
    ensure((value.observation?.review !== null && value.observation !== null) || success('review-request'));
  ensure(
    new Set(value.operations.map((op) => op.digest)).size === value.operations.length &&
      new Set(value.operations.map((op) => op.approvalId)).size === value.operations.length &&
      value.usedApprovalIds.length === value.operations.length
  );
  if (value.stage === 'checks-passed') ensure(ready(value.observation));
  return value;
}
