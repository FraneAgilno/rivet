import { CliError, EXIT_CODES } from '../cli/output.js';
import { runQualityGates } from '../quality/runner.js';
import { validateTraceability } from '../quality/traceability.js';

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
  }
  return value;
}

function snapshot(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Verification input is invalid.');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw new TypeError('Verification input is invalid.'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw new TypeError('Verification input is invalid.');
  const result = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw new TypeError('Verification input is invalid.'); }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Verification input is invalid.');
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError('Verification input is invalid.');
  return result;
}

function boundedArray(value, maximum, convert) {
  try {
    if (!Array.isArray(value)) throw new TypeError('Verification input is invalid.');
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(value).length !== length + 1) throw new TypeError('Verification input is invalid.');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Verification input is invalid.');
      }
      result.push(convert(descriptor.value));
    }
    return Object.freeze(result);
  } catch {
    throw new TypeError('Verification input is invalid.');
  }
}

function boundedString(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) {
    throw new TypeError('Verification input is invalid.');
  }
  return value;
}

function acceptanceCriterion(value) {
  const criterion = snapshot(value, ['id', 'inScope'], ['id', 'inScope']);
  if (typeof criterion.inScope !== 'boolean') throw new TypeError('Verification input is invalid.');
  return Object.freeze({ id: boundedString(criterion.id, 100), inScope: criterion.inScope });
}

const APPROVAL_FIELDS = [
  'id', 'approverId', 'approverPrincipal', 'subjectId', 'action', 'resource', 'policyId',
  'decision', 'expiresAt', 'singleUse',
];

function immutableApproval(value) {
  const approval = snapshot(value, APPROVAL_FIELDS, APPROVAL_FIELDS);
  try {
    if (!Object.isFrozen(value)) throw new TypeError('Verification input is invalid.');
  } catch {
    throw new TypeError('Verification input is invalid.');
  }
  for (const key of APPROVAL_FIELDS) {
    if (key === 'singleUse') {
      if (typeof approval[key] !== 'boolean') throw new TypeError('Verification input is invalid.');
    } else {
      boundedString(approval[key], key === 'resource' ? 1_024 : 100);
    }
  }
  return value;
}

function manualReview(value) {
  const review = snapshot(value, [
    'id', 'acceptanceCriterion', 'expectedApproverId', 'approval',
  ], ['id', 'acceptanceCriterion', 'expectedApproverId', 'approval']);
  return Object.freeze({
    id: boundedString(review.id, 64),
    acceptanceCriterion: boundedString(review.acceptanceCriterion, 100),
    expectedApproverId: boundedString(review.expectedApproverId, 64),
    approval: immutableApproval(review.approval),
  });
}

function callerTest(value) {
  const test = snapshot(value, [
    'id', 'status', 'acceptanceCriteria', 'gateId', 'resultPath', 'resultSha256',
  ], ['id', 'status', 'acceptanceCriteria', 'gateId']);
  const result = {
    id: boundedString(test.id, 64),
    status: boundedString(test.status, 32),
    acceptanceCriteria: boundedArray(test.acceptanceCriteria, 128, criterion => boundedString(criterion, 100)),
    gateId: boundedString(test.gateId, 64),
  };
  if (test.resultPath !== undefined) result.resultPath = boundedString(test.resultPath, 500);
  if (test.resultSha256 !== undefined) result.resultSha256 = boundedString(test.resultSha256, 64);
  return Object.freeze(result);
}

function traceabilityRequest(value) {
  const request = snapshot(value, [
    'subjectId', 'acceptanceCriteria', 'manualReviews', 'tests',
  ], ['subjectId', 'acceptanceCriteria', 'manualReviews']);
  return Object.freeze({
    subjectId: boundedString(request.subjectId, 64),
    acceptanceCriteria: boundedArray(request.acceptanceCriteria, 2_000, acceptanceCriterion),
    manualReviews: boundedArray(request.manualReviews, 2_000, manualReview),
    tests: request.tests === undefined
      ? Object.freeze([])
      : boundedArray(request.tests, 2_000, callerTest),
  });
}

export async function verifyProject(input, options = {}) {
  const request = snapshot(input, ['quality', 'traceability'], ['quality', 'traceability']);
  const configured = snapshot(options, ['now', 'approvalRegistry', 'nowMs', 'gitClient'], ['gitClient']);
  const traceRequest = traceabilityRequest(request.traceability);
  const quality = await runQualityGates(request.quality, {
    gitClient: configured.gitClient,
    ...(configured.now === undefined ? {} : { now: configured.now }),
  });
  const traceability = validateTraceability({
    subjectId: traceRequest.subjectId,
    qualityRun: quality,
    acceptanceCriteria: traceRequest.acceptanceCriteria,
    manualReviews: traceRequest.manualReviews,
  }, {
    approvalRegistry: configured.approvalRegistry,
    nowMs: configured.nowMs,
  });
  const gateBindingsValid = true;
  const ok = quality.status === 'pass' && traceability.valid;
  return immutable({
    ok,
    status: ok ? 'pass' : 'fail',
    commitSha: quality.commitSha,
    quality,
    traceability,
    gateBindingsValid,
  });
}

export async function verifyCommand(parsed, dependencies = {}) {
  if (!parsed || parsed.command !== 'verify' || parsed.subcommand !== null
    || !Array.isArray(parsed.operands) || parsed.operands.length !== 0
    || !parsed.flags || Reflect.ownKeys(parsed.flags).some(key => key !== 'json')) {
    throw new CliError('Verify command options are invalid.', 'INVALID_INPUT');
  }
  const context = dependencies.quality;
  if (!context || typeof context.requestFor !== 'function') {
    throw new CliError('Quality verification is not configured.', 'MISSING_CONFIGURATION');
  }
  const request = await context.requestFor(Object.freeze({ command: 'verify' }));
  const result = await verifyProject(request, context);
  const exitCode = result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILED_GATE;
  if (parsed.flags.json) dependencies.output.json({ ok: result.ok, command: 'verify', result }, result.ok ? 'stdout' : 'stderr');
  else if (result.ok) dependencies.output.log('Verification: pass.');
  else dependencies.output.error('Verification: fail.');
  return exitCode;
}
