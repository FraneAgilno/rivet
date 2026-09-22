const LIMIT_FIELDS = Object.freeze(['elapsedMs', 'agentTurns', 'retries', 'childCount', 'activeNodes', 'tokens', 'costUsd']);
const MONOTONIC_FIELDS = Object.freeze(['agentTurns', 'retries', 'childCount', 'tokens', 'costUsd']);
const snapshots = new WeakSet();

export class BudgetPolicyError extends Error {
  constructor(reason = 'invalid-budget') {
    super(reason === 'non-monotonic-observation'
      ? 'Budget observations must be monotonic.'
      : 'Budget policy input is invalid.');
    this.name = 'BudgetPolicyError';
    this.code = 'ERR_BUDGET_POLICY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new BudgetPolicyError(reason); }

function capture(value, allowed, required, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(reason); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail(reason);
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail(reason);
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof BudgetPolicyError) throw error;
    fail(reason);
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail(reason);
  return result;
}

function integer(value, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail('invalid-integer-budget');
  return value;
}

function decimal(value) {
  const source = typeof value === 'number' && Number.isFinite(value) ? value.toString() : value;
  if (typeof source !== 'string' || source.length === 0 || source.length > 64) fail('invalid-decimal-budget');
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) fail('invalid-decimal-budget');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) fail('invalid-decimal-budget');
  let digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+(?=\d)/, '');
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  const coefficient = BigInt(digits || '0');
  return { coefficient, scale, text: scale === 0
    ? coefficient.toString()
    : `${coefficient.toString().padStart(scale + 1, '0').slice(0, -scale)}.${coefficient.toString().padStart(scale + 1, '0').slice(-scale)}` };
}

function compareDecimal(leftValue, rightValue) {
  const left = decimal(leftValue);
  const right = decimal(rightValue);
  const scale = Math.max(left.scale, right.scale);
  const leftScaled = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rightScaled = right.coefficient * (10n ** BigInt(scale - right.scale));
  return leftScaled === rightScaled ? 0 : (leftScaled < rightScaled ? -1 : 1);
}

function now(options) {
  const value = options.nowMs ?? Date.now();
  return integer(value);
}

function makeSnapshot(limits, usage, startedAtMs, observedAtMs) {
  const result = Object.freeze({
    limits: Object.freeze({ ...limits }),
    usage: Object.freeze({ ...usage }),
    startedAtMs,
    observedAtMs,
  });
  snapshots.add(result);
  return result;
}

export function createBudgetSnapshot(limitsInput, optionsInput = {}) {
  try {
    const limitsValue = capture(limitsInput, new Set(LIMIT_FIELDS), LIMIT_FIELDS, 'invalid-limits');
    const options = capture(optionsInput, new Set(['nowMs']), [], 'invalid-options');
    const limits = {};
    for (const field of LIMIT_FIELDS) {
      limits[field] = field === 'costUsd'
        ? decimal(limitsValue[field]).text
        : integer(limitsValue[field], true);
    }
    if (compareDecimal(limits.costUsd, '0') <= 0) fail('invalid-decimal-budget');
    const nowMs = now(options);
    return makeSnapshot(limits, {
      elapsedMs: 0, agentTurns: 0, retries: 0, childCount: 0, activeNodes: 0, tokens: 0, costUsd: '0',
    }, nowMs, nowMs);
  } catch (error) {
    if (error instanceof BudgetPolicyError) throw error;
    fail('invalid-budget');
  }
}

export function observeBudget(snapshot, observationInput, optionsInput = {}) {
  try {
    if (!snapshots.has(snapshot)) fail('untrusted-snapshot');
    const observation = capture(observationInput, new Set(LIMIT_FIELDS.filter(field => field !== 'elapsedMs')), [], 'invalid-observation');
    const options = capture(optionsInput, new Set(['nowMs']), [], 'invalid-options');
    const observedAtMs = now(options);
    if (observedAtMs < snapshot.observedAtMs) fail('non-monotonic-observation');
    const usage = { ...snapshot.usage, elapsedMs: observedAtMs - snapshot.startedAtMs };
    for (const field of Object.keys(observation)) {
      const value = field === 'costUsd' ? decimal(observation[field]).text : integer(observation[field]);
      if (MONOTONIC_FIELDS.includes(field)) {
        const backwards = field === 'costUsd'
          ? compareDecimal(value, snapshot.usage[field]) < 0
          : value < snapshot.usage[field];
        if (backwards) fail('non-monotonic-observation');
      }
      usage[field] = value;
    }
    return makeSnapshot(snapshot.limits, usage, snapshot.startedAtMs, observedAtMs);
  } catch (error) {
    if (error instanceof BudgetPolicyError) throw error;
    fail('invalid-budget-observation');
  }
}

export function evaluateBudget(snapshot) {
  try {
    if (!snapshots.has(snapshot)) fail('untrusted-snapshot');
    const exhausted = LIMIT_FIELDS.filter(field => field === 'costUsd'
      ? compareDecimal(snapshot.usage[field], snapshot.limits[field]) >= 0
      : snapshot.usage[field] >= snapshot.limits[field]);
    if (exhausted.length === 0) return Object.freeze({
      decision: 'allow', policyId: 'budget.available', reason: 'budget-available', exhausted: Object.freeze([]),
    });
    const firstReason = exhausted[0] === 'elapsedMs' ? 'elapsed-time-exhausted' : `${exhausted[0]}-exhausted`;
    return Object.freeze({
      decision: 'deny', policyId: 'budget.exhausted', reason: firstReason, exhausted: Object.freeze(exhausted),
    });
  } catch (error) {
    if (error instanceof BudgetPolicyError) throw error;
    fail('invalid-budget');
  }
}
