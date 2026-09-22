const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const policies = new WeakSet();
export const MAX_RETRY_DELAY_MS = 3_600_000;

export class RetryPolicyError extends Error {
  constructor(reason = 'invalid-retry-policy') {
    super('Runtime retry policy is invalid.');
    this.name = 'RetryPolicyError';
    this.code = 'ERR_RUNTIME_RETRY_POLICY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new RetryPolicyError(reason); }

export function createRetryPolicy(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-retry-policy');
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !['maxAttempts', 'delaysMs', 'retryable'].includes(key))) fail('invalid-retry-policy');
    const maxAttempts = input.maxAttempts;
    const delays = input.delaysMs;
    const retryable = input.retryable;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16
      || !Array.isArray(delays) || delays.length !== Math.max(0, maxAttempts - 1) || delays.length > 15
      || delays.some(value => !Number.isSafeInteger(value) || value < 0 || value > MAX_RETRY_DELAY_MS)
      || !Array.isArray(retryable) || retryable.length > 32
      || retryable.some(value => typeof value !== 'string' || value.length > 64 || !ID.test(value))
      || new Set(retryable).size !== retryable.length) fail('invalid-retry-policy');
    const policy = Object.freeze({ maxAttempts, delaysMs: Object.freeze([...delays]), retryable: Object.freeze([...retryable].sort()) });
    policies.add(policy);
    return policy;
  } catch (error) { if (error instanceof RetryPolicyError) throw error; fail('invalid-retry-policy'); }
}

export function retryDecision(policy, input) {
  try {
    if (!policies.has(policy) || !input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-retry-decision');
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !['attempt', 'classification'].includes(key))) fail('invalid-retry-decision');
    const attempt = input.attempt;
    const classification = input.classification;
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 16 || typeof classification !== 'string' || !ID.test(classification)) fail('invalid-retry-decision');
    if (!policy.retryable.includes(classification)) return Object.freeze({ retry: false, reason: 'not-retryable' });
    if (attempt >= policy.maxAttempts) return Object.freeze({ retry: false, reason: 'attempts-exhausted' });
    return Object.freeze({ retry: true, nextAttempt: attempt + 1, delayMs: policy.delaysMs[attempt - 1] });
  } catch (error) { if (error instanceof RetryPolicyError) throw error; fail('invalid-retry-decision'); }
}

export function retryPolicySchedule(policy) {
  if (!policies.has(policy)) fail('invalid-retry-policy');
  return policy.delaysMs;
}
