import { containsSecretMaterial, createLaunchContract, failAgent } from './contract.js';

const CONFIG_KEYS = new Set(['scripts', 'clock']);
const OPTION_KEYS = new Set(['signal']);
const SCRIPT_KEYS = new Set(['version', 'kind', 'delayMs', 'output', 'usage', 'payload']);
const RESULT_KINDS = new Map([
  ['success', 'success'], ['retry', 'retry'], ['failed', 'failed'], ['blocked', 'blocked'],
  ['budget-exhausted', 'budget-exhausted'],
]);

function stable(reason, operation) {
  try { return operation(); } catch { failAgent(reason); }
}

function capture(input, keys, required, reason = 'invalid-script') {
  return stable(reason, () => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) failAgent(reason);
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length > keys.size || ownKeys.some(key => typeof key !== 'string' || !keys.has(key))) failAgent(reason);
    const result = Object.create(null);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent(reason);
      result[key] = input[key];
    }
    if (required.some(key => !Object.hasOwn(result, key))) failAgent(reason);
    return result;
  });
}

function captureArray(input, maximum, convert, reason = 'invalid-script') {
  return stable(reason, () => {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) failAgent(reason);
    const length = input.length;
    if (!Number.isSafeInteger(length) || length > maximum) failAgent(reason);
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable) failAgent(reason);
      result.push(convert(input[index]));
    }
    return Object.freeze(result);
  });
}

function boundedText(value, maximum, reason = 'invalid-script') {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0') || containsSecretMaterial(value)) failAgent(reason);
  return value;
}

function captureOutput(input) {
  const value = capture(input, new Set(['summary', 'evidence']), ['summary', 'evidence']);
  return Object.freeze({
    summary: boundedText(value.summary, 16_384),
    evidence: captureArray(value.evidence, 128, child => boundedText(child, 500)),
  });
}

function captureUsage(input) {
  const value = capture(input, new Set(['tokens', 'costUsd']), ['tokens', 'costUsd']);
  if (!Number.isSafeInteger(value.tokens) || value.tokens < 0 || value.tokens > 10_000_000
    || typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0 || value.costUsd > 100_000) failAgent('invalid-script');
  return Object.freeze({ tokens: value.tokens, costUsd: value.costUsd });
}

function snapshotScripts(input) {
  const scripts = captureArray(input, 1024, child => {
    const value = capture(child, SCRIPT_KEYS, ['version', 'kind']);
    if (value.version !== 1 || ![...RESULT_KINDS.keys(), 'stall', 'malformed', 'cancel'].includes(value.kind)) failAgent('invalid-script');
    const delayMs = value.delayMs ?? 0;
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 3_600_000) failAgent('invalid-script');
    const isResult = RESULT_KINDS.has(value.kind);
    if (isResult !== (value.output !== undefined) || isResult !== (value.usage !== undefined)) failAgent('invalid-script');
    if (value.kind === 'malformed' && (typeof value.payload !== 'string' || value.payload.length > 16_384)) failAgent('invalid-script');
    if (value.kind !== 'malformed' && value.payload !== undefined) failAgent('invalid-script');
    return Object.freeze({
      version: 1, kind: value.kind, delayMs,
      ...(isResult ? { output: captureOutput(value.output), usage: captureUsage(value.usage) } : {}),
      ...(value.payload === undefined ? {} : { payload: value.payload }),
    });
  });
  if (scripts.length === 0) failAgent('invalid-script');
  return scripts;
}

function captureClock(input) {
  if (input === undefined) return Object.freeze({ now: () => 0, wait: async () => {} });
  const value = capture(input, new Set(['now', 'wait']), ['now', 'wait']);
  if (typeof value.now !== 'function' || typeof value.wait !== 'function') failAgent('invalid-script');
  return Object.freeze({ now: value.now, wait: value.wait });
}

export function createFakeClient(input) {
  const config = capture(input, CONFIG_KEYS, ['scripts']);
  const scripts = snapshotScripts(config.scripts);
  const timing = captureClock(config.clock);
  let cursor = 0;

  function safeNow() {
    return stable('invalid-script', () => {
      const value = timing.now();
      if (!Number.isSafeInteger(value) || value < 0) failAgent('invalid-script');
      return value;
    });
  }

  function signalIsAborted(signal) {
    return signal ? stable('invalid-script', () => signal.aborted === true) : false;
  }

  async function safeWait(delayMs, signal, remainingMs) {
    if (delayMs > remainingMs) failAgent('timeout');
    let onAbort;
    let watchdog;
    try {
      const aborted = new Promise(resolve => {
        if (!signal) return;
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        if (signalIsAborted(signal)) resolve('aborted');
      });
      const deadline = new Promise(resolve => {
        watchdog = setTimeout(() => resolve('timeout'), Math.max(1, remainingMs));
      });
      return await Promise.race([
        Promise.resolve().then(() => timing.wait(delayMs, signal)).then(() => 'completed'),
        aborted, deadline,
      ]);
    } catch { failAgent('invalid-script'); }
    finally {
      clearTimeout(watchdog);
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { failAgent('invalid-script'); }
      }
    }
  }

  async function launch(contractInput, optionInput = {}) {
    const contract = createLaunchContract(contractInput);
    const options = capture(optionInput, OPTION_KEYS, []);
    const signal = stable('invalid-script', () => {
      const value = options.signal;
      if (value !== undefined && !(value instanceof AbortSignal)) failAgent('invalid-script');
      return value;
    });
    if (signalIsAborted(signal)) failAgent('aborted');
    const startedAt = safeNow();
    const deadline = startedAt + contract.budget.maxRuntimeMs;
    if (!Number.isSafeInteger(deadline)) failAgent('invalid-script');
    if (cursor >= scripts.length) failAgent('invalid-script');
    const script = scripts[cursor];
    cursor += 1;
    if (script.delayMs > 0) {
      const waitResult = await safeWait(script.delayMs, signal, deadline - startedAt);
      if (waitResult === 'aborted') failAgent('aborted');
      if (waitResult === 'timeout') failAgent('timeout');
    }
    const finishedAt = safeNow();
    if (finishedAt < startedAt) failAgent('invalid-script');
    if (finishedAt > deadline) failAgent('timeout');
    if (signalIsAborted(signal) || script.kind === 'cancel') failAgent('aborted');
    if (script.kind === 'malformed') failAgent('output-invalid');
    if (script.kind === 'stall') failAgent('timeout');
    if (script.kind !== 'budget-exhausted'
      && (script.usage.tokens > contract.budget.maxTokens || script.usage.costUsd > contract.budget.maxCostUsd)) failAgent('output-invalid');
    return Object.freeze({ version: 1, status: RESULT_KINDS.get(script.kind), output: script.output, usage: script.usage });
  }

  return Object.freeze({ provider: 'fake', launch });
}
