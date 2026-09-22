export const FEATURE_PLANNING_TIMEOUT_MS = 120_000;

export const CLAUDE_FEATURE_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'claude-bounded-sonnet-v1',
  provider: 'claude',
  model: 'sonnet',
  planning: Object.freeze({
    effort: 'low',
    timeoutMs: FEATURE_PLANNING_TIMEOUT_MS,
    maxCostUsd: 1,
  }),
  execution: Object.freeze({ maxCostUsd: 2 }),
  fallbackModel: null,
});

function exactObject(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
  return expectedKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const expectedValue = expected[key];
    return expectedValue && typeof expectedValue === 'object'
      ? exactObject(descriptor.value, expectedValue)
      : descriptor.value === expectedValue;
  });
}

export function clientProfileFor(client) {
  return client === 'claude' ? CLAUDE_FEATURE_PROFILE : undefined;
}

export function matchesClientProfile(client, value) {
  const expected = clientProfileFor(client);
  return expected === undefined ? value === undefined : exactObject(value, expected);
}
