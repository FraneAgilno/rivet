import { claimApproval } from '../policy/approvals.js';
import { assertQualityRun } from './runner.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const AC_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*-AC[1-9][0-9]*$/;
const traceabilityResults = new WeakSet();

export class TraceabilityError extends Error {
  constructor(reason = 'invalid-traceability-input') {
    super('Acceptance traceability input is invalid.');
    this.name = 'TraceabilityError';
    this.code = 'ERR_TRACEABILITY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new TraceabilityError(reason); }

function capture(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-traceability-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-traceability-input'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-traceability-input');
  const result = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail('invalid-traceability-input'); }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-traceability-input');
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-traceability-input');
  return result;
}

function array(value, maximum, convert) {
  try {
    if (!Array.isArray(value)) fail('invalid-traceability-input');
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(value).length !== length + 1) fail('invalid-traceability-input');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-traceability-input');
      result.push(convert(descriptor.value));
    }
    return result;
  } catch (error) {
    if (error instanceof TraceabilityError) throw error;
    fail('invalid-traceability-input');
  }
}

function id(value) {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)) fail('invalid-traceability-input');
  return value;
}

function acId(value) {
  if (typeof value !== 'string' || value.length > 100 || !AC_ID.test(value)) fail('invalid-traceability-input');
  return value;
}

function criterion(value) {
  const input = capture(value, new Set(['id', 'inScope']), ['id', 'inScope']);
  if (typeof input.inScope !== 'boolean') fail('invalid-traceability-input');
  return Object.freeze({ id: acId(input.id), inScope: input.inScope });
}

function manualEvidence(value) {
  const input = capture(value, new Set([
    'id', 'acceptanceCriterion', 'expectedApproverId', 'approval',
  ]), ['id', 'acceptanceCriterion', 'expectedApproverId', 'approval']);
  return Object.freeze({
    id: id(input.id),
    acceptanceCriterion: acId(input.acceptanceCriterion),
    expectedApproverId: id(input.expectedApproverId),
    approval: input.approval,
  });
}

export function assertTraceabilityResult(value) {
  if (!traceabilityResults.has(value)) fail('invalid-traceability-input');
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
  }
  return value;
}

export function validateTraceability(input, options = {}) {
  const value = capture(input, new Set([
    'subjectId', 'qualityRun', 'acceptanceCriteria', 'manualReviews',
  ]), ['subjectId', 'qualityRun', 'acceptanceCriteria', 'manualReviews']);
  const configured = capture(options, new Set(['approvalRegistry', 'nowMs']), ['approvalRegistry', 'nowMs']);
  const subjectId = id(value.subjectId);
  try { assertQualityRun(value.qualityRun); } catch { fail('invalid-traceability-input'); }
  if (!Number.isSafeInteger(configured.nowMs) || configured.nowMs < 0) fail('invalid-traceability-input');
  const criteria = array(value.acceptanceCriteria, 2_000, criterion);
  const tests = value.qualityRun.tests;
  const manualReviews = array(value.manualReviews, 2_000, manualEvidence);
  if (criteria.length === 0
    || new Set(criteria.map(item => item.id.toLowerCase())).size !== criteria.length
    || new Set(tests.map(item => item.id.toLowerCase())).size !== tests.length
    || new Set(manualReviews.map(item => item.id.toLowerCase())).size !== manualReviews.length
    || new Set(manualReviews.map(item => item.acceptanceCriterion.toLowerCase())).size !== manualReviews.length) {
    fail('invalid-traceability-input');
  }
  const known = new Set(criteria.map(item => item.id));
  if (tests.some(item => item.acceptanceCriteria.some(ac => !known.has(ac)))
    || manualReviews.some(item => !known.has(item.acceptanceCriterion))) fail('unknown-acceptance-criterion');

  const manualRequired = new Set(criteria
    .filter(item => item.inScope && !tests.some(test => test.status === 'passed' && test.acceptanceCriteria.includes(item.id)))
    .map(item => item.id));
  if (manualReviews.some(review => !manualRequired.has(review.acceptanceCriterion))) {
    fail('invalid-traceability-input');
  }

  const approvedManual = new Map();
  const approvalErrors = new Map();
  const claims = [];
  for (const review of manualReviews) {
    let claim = { valid: false };
    try {
      claim = claimApproval(review.approval, {
          subjectId,
          action: 'quality.manual-review',
          resource: 'acceptance:' + review.acceptanceCriterion + ':manual-review:' + review.id,
          policyId: 'quality.acceptance',
        }, {
          registry: configured.approvalRegistry,
          expectedApproverId: review.expectedApproverId,
          requireHumanApprover: true,
          requireSingleUse: true,
          nowMs: configured.nowMs,
        });
    } catch { claim = { valid: false }; }
    if (claim.valid) {
      claims.push({ claim, review });
      approvedManual.set(review.acceptanceCriterion, review);
    }
    else approvalErrors.set(review.acceptanceCriterion, 'Acceptance criterion ' + review.acceptanceCriterion + ' lacks exact human approval.');
  }

  const coverage = [];
  const errors = [];
  const outOfScope = [];
  for (const criterionEntry of [...criteria].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!criterionEntry.inScope) {
      outOfScope.push(criterionEntry.id);
      continue;
    }
    const passed = tests
      .filter(item => item.status === 'passed' && item.acceptanceCriteria.includes(criterionEntry.id))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (passed) {
      coverage.push({
        acceptanceCriterion: criterionEntry.id,
        method: 'test',
        evidenceId: passed.id,
        gateId: passed.gateId,
        resultPath: passed.resultPath,
        resultSha256: passed.resultSha256,
      });
      continue;
    }
    const manual = approvedManual.get(criterionEntry.id);
    if (manual) {
      coverage.push({
        acceptanceCriterion: criterionEntry.id,
        method: 'manual-review',
        evidenceId: manual.id,
        approvalReceiptId: manual.approval.id,
        approverId: manual.approval.approverId,
        approverPrincipal: manual.approval.approverPrincipal,
      });
      continue;
    }
    errors.push(approvalErrors.get(criterionEntry.id)
      ?? 'Acceptance criterion ' + criterionEntry.id + ' lacks a passed deterministic test or exact human approval.');
  }
  if (errors.length > 0) {
    for (const entry of claims) entry.claim.release();
  } else {
    const finalized = [];
    try {
      for (const entry of claims) {
        if (!entry.claim.finalize()) fail('approval-transaction-failed');
        finalized.push(entry);
      }
      for (const entry of claims) {
        if (!entry.claim.publish()) fail('approval-transaction-failed');
      }
    } catch (error) {
      for (const entry of finalized) entry.claim.rollback();
      for (const entry of claims) if (!finalized.includes(entry)) entry.claim.release();
      if (error instanceof TraceabilityError) throw error;
      fail('approval-transaction-failed');
    }
  }
  const output = immutable({
    valid: errors.length === 0,
    commitSha: value.qualityRun.commitSha,
    coverage,
    outOfScope,
    errors,
  });
  traceabilityResults.add(output);
  return output;
}
