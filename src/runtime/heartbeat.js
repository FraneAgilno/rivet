const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class HeartbeatError extends Error {
  constructor(reason = 'invalid-heartbeat') {
    super('Runtime heartbeat is invalid.');
    this.name = 'HeartbeatError';
    this.code = 'ERR_RUNTIME_HEARTBEAT';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new HeartbeatError(reason); }
function id(value) { if (typeof value !== 'string' || value.length > 64 || !ID.test(value)) fail('invalid-heartbeat'); return value; }

function capture(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-heartbeat');
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('invalid-heartbeat');
  const result = {};
  try { for (const key of own) result[key] = input[key]; } catch { fail('invalid-heartbeat'); }
  return result;
}

export function createHeartbeat(input) {
  try {
    const value = capture(input, ['version', 'instanceId', 'nodeId', 'actorId', 'leaseId', 'sequence', 'timestampMs', 'intervalMs']);
    if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isSafeInteger(value.timestampMs) || value.timestampMs < 0
      || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 100 || value.intervalMs > 3_600_000) fail('invalid-heartbeat');
    return Object.freeze({ version: 1, instanceId: id(value.instanceId), nodeId: id(value.nodeId), actorId: id(value.actorId), leaseId: id(value.leaseId), sequence: value.sequence, timestampMs: value.timestampMs, intervalMs: value.intervalMs });
  } catch (error) { if (error instanceof HeartbeatError) throw error; fail('invalid-heartbeat'); }
}

export function heartbeatStatus(heartbeat, input) {
  try {
    const value = capture(input, ['nowMs', 'expected']);
    const stable = createHeartbeat(heartbeat);
    const expected = capture(value.expected, ['instanceId', 'nodeId', 'actorId', 'leaseId']);
    if (!Number.isSafeInteger(value.nowMs) || value.nowMs < stable.timestampMs || value.nowMs > Number.MAX_SAFE_INTEGER
      || stable.instanceId !== id(expected.instanceId) || stable.nodeId !== id(expected.nodeId)
      || stable.actorId !== id(expected.actorId) || stable.leaseId !== id(expected.leaseId)) fail('heartbeat-binding');
    const maximumAge = stable.intervalMs * 2;
    if (!Number.isSafeInteger(maximumAge)) fail('invalid-heartbeat');
    return Object.freeze({ status: value.nowMs - stable.timestampMs > maximumAge ? 'stalled' : 'alive', ageMs: value.nowMs - stable.timestampMs });
  } catch (error) { if (error instanceof HeartbeatError) throw error; fail('invalid-heartbeat'); }
}
