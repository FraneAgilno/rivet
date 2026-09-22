import {
  cancelGoal, cancelNode, createCorrectiveNode, recoverRuntimeLock, recoverStalledNode, retryNode,
} from '../runtime/recovery.js';
import { containsSecretMaterial } from '../clients/contract.js';
import { validateEvent } from '../config/validate.js';
import { validatedGraphSnapshot } from '../graph/validate.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
  return value;
}

function boundedSnapshot(input) {
  let seen = 0;
  function visit(value, depth) {
    if (depth > 32 || ++seen > 100_000) throw new TypeError('Invalid runtime state');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > 16_384 || containsSecretMaterial(value)) throw new TypeError('Invalid runtime state');
      return value;
    }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Invalid runtime state'); return value; }
    if (!value || typeof value !== 'object') throw new TypeError('Invalid runtime state');
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 10_000 || Reflect.ownKeys(value).length !== length + 1) throw new TypeError('Invalid runtime state');
      return Array.from({ length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid runtime state');
        return visit(descriptor.value, depth + 1);
      });
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10_000 || keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid runtime state');
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid runtime state');
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  }
  return visit(input, 0);
}

async function read(instance) {
  if (!instance || typeof instance.acquire !== 'function' || typeof instance.read !== 'function') throw new TypeError('Invalid runtime instance');
  const lock = await instance.acquire();
  try { return boundedSnapshot(await instance.read()); }
  catch { throw new TypeError('Invalid runtime state'); }
  finally { await lock.release(); }
}

export async function goalsStatus(instance) {
  const state = await read(instance);
  if (!Number.isSafeInteger(state.version) || state.version < 0 || (state.terminal !== null && state.terminal !== undefined && !['completed', 'blocked', 'cancelled', 'budget-exhausted', 'failed'].includes(state.terminal))) throw new TypeError('Invalid runtime state');
  const graph = validatedGraphSnapshot(state.graph);
  return immutable({ version: state.version, activated: state.activated === true, terminal: state.terminal ?? null, graphId: graph.id, graphStatus: graph.status, nodes: graph.nodes.slice(0, 1000).map(node => ({ id: node.id, parentId: node.parentId ?? null, role: node.owner.role, status: node.status })) });
}

export async function goalsEvents(instance, input = {}) {
  let keys; let limit;
  try { keys = Reflect.ownKeys(input); if (keys.some(key => key !== 'limit')) throw new TypeError(); limit = keys.includes('limit') ? input.limit : 100; }
  catch { throw new TypeError('Invalid event limit'); }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid event limit');
  const state = await read(instance);
  if (!Array.isArray(state.events) || state.events.length > 10_000) throw new TypeError('Invalid runtime state');
  for (const event of state.events) { try { validateEvent(event); } catch { throw new TypeError('Invalid runtime state'); } }
  return immutable(state.events.slice(-limit).map(event => ({
    sequence: event.sequence, timestamp: event.timestamp, type: event.type,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.priorState ? { priorState: event.priorState, newState: event.newState } : {}),
    actorRole: event.actor?.role ?? 'system', evidenceCount: event.evidenceRefs?.length ?? 0,
  })));
}

export async function goalsRecoverLock(target, input) { return recoverRuntimeLock(target, input); }
export async function goalsRetryNode(runtime, instance, input) {
  if (!runtime || typeof runtime.retryNode !== 'function') throw new TypeError('Invalid runtime');
  return runtime.retryNode(instance, input);
}
export async function goalsCancelNode(runtime, instance, input) {
  if (!runtime || typeof runtime.cancelNode !== 'function') throw new TypeError('Invalid runtime');
  return runtime.cancelNode(instance, input);
}
export async function goalsCancelGoal(runtime, instance, input) {
  if (!runtime || typeof runtime.cancelGoal !== 'function') throw new TypeError('Invalid runtime');
  return runtime.cancelGoal(instance, input);
}
export async function goalsCreateCorrectiveNode(instance, input) { return createCorrectiveNode(instance, input); }
export async function goalsRecoverStalledNode(instance, input) { return recoverStalledNode(instance, input); }

function cliFailure(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }
function cliInstanceId(parsed) {
  if (!parsed || parsed.command !== 'goals' || !Array.isArray(parsed.operands) || parsed.operands.length !== 1
    || typeof parsed.operands[0] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(parsed.operands[0])
    || parsed.operands[0].length > 64) cliFailure('Goals commands require one explicit private instance ID.');
  return parsed.operands[0];
}
function cliFlags(parsed, allowed) {
  const flags = parsed?.flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) cliFailure('Goals command options are invalid.');
  const keys = Object.keys(flags);
  if (keys.some(key => !allowed.includes(key))) cliFailure('Goals command options are invalid.');
  return flags;
}
function cliInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) cliFailure(`Goals option '${name}' is invalid.`);
  return parsed;
}
function cliId(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) cliFailure(`Goals option '${name}' is invalid.`);
  return value;
}
function cliReason(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1000 || /[\u0000\r\n]/.test(value)) cliFailure("Goals option 'reason' is invalid.");
  return value;
}
function cliDependencies(dependencies, { mutation = false, runtimeMethod } = {}) {
  const context = dependencies?.orchestration;
  if (!context || typeof context.resolveInstance !== 'function') cliFailure('Private orchestration is not configured.', 'MISSING_CONFIGURATION');
  if (mutation && typeof context.requestFor !== 'function') cliFailure('Private orchestration mutation input is not configured.', 'MISSING_CONFIGURATION');
  if (runtimeMethod && (!context.runtime || typeof context.runtime[runtimeMethod] !== 'function')) cliFailure('Private orchestration runtime is not configured.', 'MISSING_CONFIGURATION');
  return context;
}
async function cliContext(instanceId, context) {
  const instance = await context.resolveInstance(instanceId);
  if (!instance || instance.id !== instanceId) cliFailure('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
  return { context, instance, instanceId };
}
const MUTATION_INPUT_SHAPES = Object.freeze({
  'recover-lock': { allowed: ['expectedVersion', 'nowMs', 'authority', 'approval', 'approvalRegistry', 'expectedApproverId'], required: ['expectedVersion', 'nowMs', 'authority', 'approval', 'approvalRegistry', 'expectedApproverId'] },
  'retry-node': { allowed: ['expectedVersion', 'nodeId', 'authority', 'reason', 'nowMs'], required: ['expectedVersion', 'nodeId', 'authority', 'reason'] },
  'cancel-node': { allowed: ['expectedVersion', 'nodeId', 'authority', 'nowMs'], required: ['expectedVersion', 'nodeId', 'authority'] },
  'cancel-goal': { allowed: ['expectedVersion', 'authority', 'nowMs'], required: ['expectedVersion', 'authority'] },
  'create-corrective-node': { allowed: ['expectedVersion', 'sourceNodeId', 'nodeId', 'ownerId', 'authority', 'reason', 'evidenceRefs', 'evidenceTypes', 'nowMs'], required: ['expectedVersion', 'sourceNodeId', 'nodeId', 'ownerId', 'authority', 'reason', 'evidenceRefs'] },
  'recover-stalled-node': { allowed: ['expectedVersion', 'nodeId', 'authority', 'nowMs', 'reason'], required: ['expectedVersion', 'nodeId', 'authority', 'nowMs', 'reason'] },
});
const CLI_RUNTIME_BINDINGS = Object.freeze({ 'expected-version': 'expectedVersion', node: 'nodeId', source: 'sourceNodeId', owner: 'ownerId', reason: 'reason', 'now-ms': 'nowMs' });
function snapshotMutationArray(value) {
  if (!Array.isArray(value)) throw new TypeError();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 8 || Reflect.ownKeys(value).length !== length + 1) throw new TypeError();
  return Object.freeze(Array.from({ length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    return descriptor.value;
  }));
}
function snapshotMutationInput(input, subcommand, flags) {
  const shape = MUTATION_INPUT_SHAPES[subcommand]; const output = Object.create(null);
  try {
    if (!shape || !input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError();
    const keys = Reflect.ownKeys(input);
    if (keys.length > shape.allowed.length || keys.some(key => typeof key !== 'string' || !shape.allowed.includes(key))) throw new TypeError();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) throw new TypeError();
      const value = input[key];
      output[key] = ['evidenceRefs', 'evidenceTypes'].includes(key) ? snapshotMutationArray(value) : value;
    }
    if (shape.required.some(key => !Object.hasOwn(output, key))) throw new TypeError();
  } catch { cliFailure('Private orchestration mutation input is invalid.', 'MISSING_CONFIGURATION'); }
  for (const [flag, field] of Object.entries(CLI_RUNTIME_BINDINGS)) {
    if (Object.hasOwn(flags, flag) && output[field] !== flags[flag]) cliFailure('Private orchestration mutation input does not match the CLI request.', 'MISSING_CONFIGURATION');
  }
  return Object.freeze(output);
}
async function cliMutationInput(context, parsed, instanceId, flags) {
  const input = await context.requestFor(Object.freeze({ command: 'goals', subcommand: parsed.subcommand, instanceId, flags }));
  return snapshotMutationInput(input, parsed.subcommand, flags);
}
function emitCliResult(parsed, dependencies, result) {
  const payload = { ok: true, command: 'goals', subcommand: parsed.subcommand, result };
  if (parsed.flags.json) dependencies.output.json(payload);
  else dependencies.output.log(`Goals ${parsed.subcommand}: ${result.terminal ?? result.graphStatus ?? 'ok'}.`);
  return EXIT_CODES.SUCCESS;
}

export async function goalsCommand(parsed, dependencies) {
  const instanceId = cliInstanceId(parsed);
  let eventLimit; let mutationFlags; let runtimeMethod;
  const mutations = new Set(['recover-lock', 'retry-node', 'cancel-node', 'cancel-goal', 'create-corrective-node', 'recover-stalled-node']);
  if (parsed.subcommand === 'status') cliFlags(parsed, ['json']);
  else if (parsed.subcommand === 'events') {
    const flags = cliFlags(parsed, ['json', 'limit']);
    eventLimit = flags.limit === undefined ? 100 : cliInteger(flags.limit, 'limit', { minimum: 1, maximum: 1000 });
  } else if (mutations.has(parsed.subcommand)) {
    const shape = {
      'recover-lock': { ids: [], reason: false },
      'retry-node': { ids: ['node'], reason: true },
      'cancel-node': { ids: ['node'], reason: false },
      'cancel-goal': { ids: [], reason: false },
      'create-corrective-node': { ids: ['source', 'node', 'owner'], reason: true },
      'recover-stalled-node': { ids: ['node'], reason: true },
    }[parsed.subcommand];
    const flags = cliFlags(parsed, ['json', 'expected-version', 'now-ms', ...shape.ids, ...(shape.reason ? ['reason'] : [])]);
    mutationFlags = {
      ...flags,
      'expected-version': cliInteger(flags['expected-version'], 'expected-version'),
      ...(flags['now-ms'] === undefined ? {} : { 'now-ms': cliInteger(flags['now-ms'], 'now-ms') }),
      ...Object.fromEntries(shape.ids.map(name => [name, cliId(flags[name], name)])),
      ...(shape.reason ? { reason: cliReason(flags.reason) } : {}),
    };
    runtimeMethod = ({ 'retry-node': 'retryNode', 'cancel-node': 'cancelNode', 'cancel-goal': 'cancelGoal', 'recover-stalled-node': 'recoverStalledNode' })[parsed.subcommand];
  }
  else cliFailure('Unknown goals subcommand.');
  const mutation = mutations.has(parsed.subcommand);
  const context = cliDependencies(dependencies, { mutation, runtimeMethod });
  const input = mutation ? await cliMutationInput(context, parsed, instanceId, Object.freeze(mutationFlags)) : undefined;
  const { instance } = await cliContext(instanceId, context);
  let result;
  if (parsed.subcommand === 'status') {
    result = await goalsStatus(instance);
  } else if (parsed.subcommand === 'events') {
    result = await goalsEvents(instance, { limit: eventLimit });
  } else {
    if (parsed.subcommand === 'recover-lock') await goalsRecoverLock(instance, input);
    else if (parsed.subcommand === 'retry-node') await goalsRetryNode(context.runtime, instance, input);
    else if (parsed.subcommand === 'cancel-node') await goalsCancelNode(context.runtime, instance, input);
    else if (parsed.subcommand === 'cancel-goal') await goalsCancelGoal(context.runtime, instance, input);
    else if (parsed.subcommand === 'create-corrective-node') await goalsCreateCorrectiveNode(instance, input);
    else if (parsed.subcommand === 'recover-stalled-node') await context.runtime.recoverStalledNode(instance, input);
    result = await goalsStatus(instance);
  }
  return emitCliResult(parsed, dependencies, result);
}
