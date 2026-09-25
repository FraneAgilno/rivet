export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(?:^|[-_])(?:password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|credential|access[-_]?token|api[-_]?token|auth[-_]?token|token)(?:$|[-_])/i;
const SENSITIVE_ENVIRONMENT_KEY = /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i;
const SAFE_KEYS = new Set(['token_limit', 'api_token_env', 'access_token_env', 'token_env', 'username_env']);
// Gemini usage metadata is numeric accounting, never credential content. Exact
// keys and integer values only; configured secret keys always take precedence.
const NUMERIC_USAGE_KEYS = new Set(['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount']);
const TOKEN_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.:=-]+/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function normalizedKey(key) {
  return String(key)
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function sensitiveEnvironmentValues(environment) {
  return [...new Set(Object.entries(environment ?? {})
    .filter(([key, value]) => (
      SENSITIVE_ENVIRONMENT_KEY.test(key)
      && typeof value === 'string'
      && value.length > 0
    ))
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(value, environmentValues) {
  let result = value;
  if (environmentValues.length > 0) {
    result = result.replace(new RegExp(environmentValues.map(escapeRegExp).join('|'), 'g'), REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

function isSensitiveKey(key, configuredKeys) {
  const normalized = normalizedKey(key);
  if (configuredKeys.has(normalized)) return true;
  if (SAFE_KEYS.has(normalized)) return false;
  return SENSITIVE_KEY.test(normalized);
}

function redactValue(value, context, active) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value, context.environmentValues);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('State values must be JSON-compatible');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('State values must be JSON-compatible');
  if (active.has(value)) throw new TypeError('Cannot redact a cyclic value');

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('State values must be JSON-compatible');
  }

  active.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => redactValue(item, context, active));
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('State values must be JSON-compatible');
      }
      const safeUsageCount = NUMERIC_USAGE_KEYS.has(key)
        && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
        && !context.configuredKeys.has(normalizedKey(key));
      const child = isSensitiveKey(key, context.configuredKeys) && !safeUsageCount
        ? REDACTED
        : redactValue(descriptor.value, context, active);
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
}

export function redactSecrets(value, options = {}) {
  const configuredKeys = new Set((options.secretKeys ?? []).map(normalizedKey));
  const environment = options.environment ?? process.env;
  return redactValue(value, {
    configuredKeys,
    environmentValues: sensitiveEnvironmentValues(environment),
  }, new WeakSet());
}
