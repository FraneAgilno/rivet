const TERMINAL = new Set(['complete', 'completed', 'blocked', 'cancelled', 'budget-exhausted', 'failed']);
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const ADD_ABORT_LISTENER = AbortSignal.prototype.addEventListener;
const REMOVE_ABORT_LISTENER = AbortSignal.prototype.removeEventListener;

export class SupervisorError extends Error {
  constructor(reason = 'invalid-watch') {
    super('Orchestration watch request is invalid.');
    this.name = 'SupervisorError'; this.code = 'ERR_RUNTIME_SUPERVISOR'; this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new SupervisorError(reason); }

function readClock(now, prior) {
  let value;
  try { value = now(); } catch { fail('clock-failed'); }
  if (Number.isSafeInteger(value) && Number.isSafeInteger(prior) && value < prior) fail('clock-regressed');
  return value;
}

function captureSignal(value) {
  if (value === undefined) return Object.freeze({ signal: undefined, release() {} });
  try {
    if (!(value instanceof AbortSignal) || typeof ABORTED_GETTER !== 'function') fail('invalid-watch');
    const controller = new AbortController(); const relayAbort = () => controller.abort();
    const aborted = ABORTED_GETTER.call(value);
    if (typeof aborted !== 'boolean') fail('invalid-watch');
    let listening = false;
    if (aborted) controller.abort();
    else {
      ADD_ABORT_LISTENER.call(value, 'abort', relayAbort, { once: true }); listening = true;
      if (ABORTED_GETTER.call(value)) relayAbort();
    }
    return Object.freeze({
      signal: controller.signal,
      release() {
        if (!listening) return;
        listening = false;
        try { REMOVE_ABORT_LISTENER.call(value, 'abort', relayAbort); } catch {}
      },
    });
  } catch { fail('invalid-watch'); }
}

function captureTickResult(value) {
  let terminal; let version;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('tick-output');
    terminal = value.terminal; version = value.version;
  } catch { fail('tick-output'); }
  if (TERMINAL.has(terminal)) return Object.freeze({ terminal, version });
  if (terminal !== null || !Number.isSafeInteger(version) || version < 0) fail('tick-output');
  return Object.freeze({ terminal, version });
}

async function boundedWait(wait, intervalMs, signal) {
  const controller = new AbortController(); const timeoutToken = Object.freeze(Object.create(null)); const abortToken = Object.freeze(Object.create(null));
  let timer; let resolveAbort; let externallyAborted = false; let timedOut = false;
  const relayAbort = () => { externallyAborted = true; resolveAbort?.(abortToken); controller.abort(); };
  signal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const operation = Promise.resolve().then(() => wait(intervalMs, controller.signal))
      .then(() => Object.freeze({ ok: true }), () => Object.freeze({ ok: false }));
    const timeout = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(timeoutToken); controller.abort(); }, intervalMs); });
    const aborted = new Promise(resolve => { resolveAbort = resolve; if (signal?.aborted) relayAbort(); });
    const result = await Promise.race([operation, timeout, aborted]);
    if (result === abortToken || externallyAborted) return 'aborted';
    if (result === timeoutToken || timedOut) return 'timeout';
    if (result !== timeoutToken && result.ok !== true) fail('wait-failed');
    return 'settled';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

async function boundedTick(runtime, tick, instance, expectedVersion, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutToken = Object.freeze({ status: 'timeout' });
  const abortToken = Object.freeze({ status: 'aborted' });
  const lateToken = Object.freeze({ status: 'late' });
  let expired = false; let timer; let resolveAbort; let timeoutRemaining = timeoutMs;
  const relayAbort = () => { controller.abort(); resolveAbort?.(abortToken); };
  signal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const operation = Promise.resolve()
      .then(() => tick.call(runtime, instance, { expectedVersion, signal: controller.signal }))
      .then(
        value => expired ? lateToken : Object.freeze({ status: 'settled', ok: true, value }),
        () => expired ? lateToken : Object.freeze({ status: 'settled', ok: false }),
      );
    const timeout = new Promise(resolve => {
      const schedule = () => {
        const delay = Math.min(timeoutRemaining, 2_147_483_647);
        timer = setTimeout(() => {
          timeoutRemaining -= delay;
          if (timeoutRemaining > 0) schedule();
          else { expired = true; controller.abort(); resolve(timeoutToken); }
        }, delay);
      };
      schedule();
    });
    const aborted = new Promise(resolve => { resolveAbort = resolve; if (signal?.aborted) relayAbort(); });
    const result = await Promise.race([operation, timeout, aborted]);
    if (result === timeoutToken || result === abortToken) { expired = true; return result; }
    if (result.ok !== true) fail('tick-failed');
    return result;
  } finally {
    expired = true;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export async function watchOrchestration(runtime, instance, input) {
    let tick; let expectedVersion; let intervalMs; let maxTicks; let deadlineMs; let now; let wait; let signal;
    try {
      if (!runtime || !instance || !input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-watch');
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) fail('invalid-watch');
      const allowed = new Set(['expectedVersion', 'intervalMs', 'maxTicks', 'deadlineMs', 'now', 'wait', 'signal']);
      const required = ['expectedVersion', 'intervalMs', 'maxTicks', 'deadlineMs', 'now', 'wait'];
      const keys = Reflect.ownKeys(input);
      if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))
        || required.some(key => !keys.includes(key))) fail('invalid-watch');
      for (const key of keys) if (!Object.getOwnPropertyDescriptor(input, key)?.enumerable) fail('invalid-watch');
      tick = runtime.tick;
      if (typeof tick !== 'function') fail('invalid-watch');
      expectedVersion = input.expectedVersion;
      intervalMs = input.intervalMs;
      maxTicks = input.maxTicks;
      deadlineMs = input.deadlineMs;
      now = input.now;
      wait = input.wait;
      signal = input.signal;
    } catch { fail('invalid-watch'); }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000
      || !Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 10_000 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0
      || typeof now !== 'function' || typeof wait !== 'function') fail('invalid-watch');
    const signalBoundary = captureSignal(signal); signal = signalBoundary.signal;
    try {
    let version = expectedVersion; let lastClock;
    for (let ticks = 1; ticks <= maxTicks; ticks += 1) {
      if (signal?.aborted) return Object.freeze({ terminal: 'cancelled', ticks: ticks - 1 });
      const current = readClock(now, lastClock); lastClock = current;
      if (!Number.isSafeInteger(current) || current < 0 || current > deadlineMs) return Object.freeze({ terminal: 'deadline', ticks: ticks - 1 });
      const remainingForTick = deadlineMs - current;
      if (remainingForTick <= 0) return Object.freeze({ terminal: 'deadline', ticks: ticks - 1 });
      const tickOutcome = await boundedTick(runtime, tick, instance, version, remainingForTick, signal);
      if (tickOutcome.status === 'timeout') return Object.freeze({ terminal: 'deadline', ticks });
      if (tickOutcome.status === 'aborted') return Object.freeze({ terminal: 'cancelled', ticks });
      const result = captureTickResult(tickOutcome.value);
      if (TERMINAL.has(result.terminal)) return Object.freeze({ terminal: result.terminal, ticks });
      version = result.version;
      if (ticks === maxTicks) return Object.freeze({ terminal: 'max-ticks', ticks });
      const afterTick = readClock(now, lastClock); lastClock = afterTick;
      const remaining = deadlineMs - afterTick;
      if (!Number.isSafeInteger(remaining) || remaining <= 0) return Object.freeze({ terminal: 'deadline', ticks });
      const waitOutcome = await boundedWait(wait, Math.min(intervalMs, remaining), signal);
      if (waitOutcome === 'aborted') return Object.freeze({ terminal: 'cancelled', ticks });
    }
    fail('invalid-watch');
    } finally { signalBoundary.release(); }
}
