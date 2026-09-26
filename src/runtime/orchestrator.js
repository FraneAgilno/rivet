import { createHash, randomUUID } from 'node:crypto';

import { evaluateAuthority } from '../policy/authority.js';
import { claimApproval } from '../policy/approvals.js';
import { captureWorktree, containsSecretMaterial, immutableJson } from '../clients/contract.js';
import { validateEvent } from '../config/validate.js';
import { reduceGraph } from '../graph/reducer.js';
import { scheduleReadyNodes } from '../graph/scheduler.js';
import { validatedGraphSnapshot } from '../graph/validate.js';
import { createRetryPolicy, MAX_RETRY_DELAY_MS, retryDecision, retryPolicySchedule } from './retry.js';
import { createHeartbeat, heartbeatStatus } from './heartbeat.js';
import { cancelGoal as recoverCancelGoal, cancelNode as recoverCancelNode, recoverStalledNode as recoverStalled, retryNode as recoverRetryNode } from './recovery.js';

const TERMINAL = new Set(['complete', 'completed', 'blocked', 'cancelled', 'budget-exhausted', 'failed']);
const INTENT_STATUSES = new Set(['committed', 'prepared', 'started', 'complete', 'recovered']);
const INTENT_KEYS = Object.freeze(['id', 'nodeId', 'reservationId', 'attempt', 'idempotencyKey', 'allocation', 'status', 'eventSequence']);
const INTENT_STATUS_KEYS = Object.freeze({
  committed: Object.freeze(['preparationClaim']),
  prepared: Object.freeze(['worktree']),
  started: Object.freeze(['startedAtMs', 'worktree']),
  complete: Object.freeze(['startedAtMs', 'worktree', 'retryAtMs']),
  recovered: Object.freeze(['startedAtMs', 'worktree']),
});

export class RuntimeError extends Error {
  constructor(reason = 'invalid-runtime-input') {
    const messages = { 'approval-required': 'Runtime activation requires valid human approval.', 'version-conflict': 'Runtime state version changed concurrently.', 'not-activated': 'Runtime instance is not activated.', 'invalid-runtime-input': 'Runtime request is invalid.', 'client-output': 'Agent client output is invalid.' };
    super(messages[reason] ?? messages['invalid-runtime-input']);
    this.name = 'RuntimeError';
    this.code = `ERR_RUNTIME_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new RuntimeError(reason); }
function clone(value) { try { return structuredClone(value); } catch { fail('invalid-runtime-input'); } }
function exactVersion(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('invalid-runtime-input'); return value; }
function iso(nowMs) { if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('invalid-runtime-input'); return new Date(nowMs).toISOString(); }
function safeId(value) { return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64; }
function launchIntentId(nodeId, attempt) {
  if (!safeId(nodeId) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10_000) fail('invalid-runtime-input');
  const direct = `launch-${nodeId}-${attempt}`;
  if (safeId(direct)) return direct;
  const digest = createHash('sha256').update(nodeId).digest('hex').slice(0, 40);
  return `launch-${digest}-${attempt}`;
}
function evidenceBindings(node, pinned = new Map()) {
  if (node.evidenceRefs.length !== node.requiredEvidenceTypes.length) fail('invalid-runtime-input');
  const references = [...node.evidenceRefs].sort(); const types = [...node.requiredEvidenceTypes].sort();
  const bindings = new Map();
  for (const [id, type] of pinned) {
    const referenceIndex = references.indexOf(id); const typeIndex = types.indexOf(type);
    if (referenceIndex < 0 || typeIndex < 0) fail('invalid-runtime-input');
    references.splice(referenceIndex, 1); types.splice(typeIndex, 1); bindings.set(id, type);
  }
  for (let index = 0; index < references.length; index += 1) bindings.set(references[index], types[index]);
  return bindings;
}

function captureOptions(input, allowed, required = []) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-runtime-input');
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('invalid-runtime-input');
    const output = {};
    for (const key of keys) output[key] = input[key];
    if (required.some(key => !Object.hasOwn(output, key))) fail('invalid-runtime-input');
    return output;
  } catch (error) { if (error instanceof RuntimeError) throw error; fail('invalid-runtime-input'); }
}

function assertInstance(instance) {
  if (!instance || typeof instance !== 'object' || !safeId(instance.id) || typeof instance.acquire !== 'function' || typeof instance.read !== 'function' || typeof instance.commit !== 'function') fail('invalid-runtime-input');
}

function canonicalState(input, expectedInstanceId, retryDelaysMs = null) {
  const state = clone(input);
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isSafeInteger(state.version)
    || state.version < 0 || !Array.isArray(state.events) || state.events.length > 10_000) fail('invalid-runtime-input');
  if (typeof state.activated !== 'boolean') fail('invalid-runtime-input');
  state.graph = validatedGraphSnapshot(state.graph);
  for (const node of state.graph.nodes) {
    if (node.requiredEvidenceTypes.includes('human-approval')
      && !(node.owner.role === 'boss' && (!node.parentId || node.approvalGate))) fail('invalid-runtime-input');
  }
  const bindingsByNode = new Map(state.graph.nodes.map(node => [node.id, evidenceBindings(node)]));
  for (let index = 0; index < state.events.length; index += 1) {
    try { validateEvent(state.events[index]); } catch { fail('invalid-runtime-input'); }
    if (state.events[index].sequence !== index + 1 || state.events[index].graphId !== state.graph.id) fail('invalid-runtime-input');
  }
  const applied = state.appliedSequence ?? state.events.length;
  if (!Number.isSafeInteger(applied) || applied < 0 || applied > state.events.length) fail('invalid-runtime-input');
  state.attempts ??= {}; state.launchIntents ??= {}; state.heartbeats ??= {}; state.evidence ??= [];
  state.lastHeartbeatAt ??= {};
  if (state.nodeUsage === undefined) state.nodeUsage = {};
  if (state.delegatedUsage === undefined) state.delegatedUsage = {};
  if (state.usage === undefined) state.usage = { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0, taskLimit: 0 };
  const nodesById = new Map(state.graph.nodes.map(node => [node.id, node]));
  for (const [nodeId, intent] of Object.entries(state.launchIntents)) {
    if (!safeId(nodeId) || !intent || typeof intent !== 'object' || Array.isArray(intent) || intent.nodeId !== nodeId || !nodesById.has(nodeId)
      || !safeId(intent.id) || !safeId(intent.reservationId) || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > 10_000
      || !Number.isSafeInteger(intent.eventSequence) || intent.eventSequence < 0 || intent.eventSequence > 10_000
      || !INTENT_STATUSES.has(intent.status)) fail('invalid-runtime-input');
    const allowedIntentKeys = new Set([...INTENT_KEYS, ...INTENT_STATUS_KEYS[intent.status]]);
    const intentKeys = Reflect.ownKeys(intent);
    if (intentKeys.some(key => typeof key !== 'string' || !allowedIntentKeys.has(key))
      || INTENT_KEYS.some(key => !Object.hasOwn(intent, key))
      || (intent.status === 'prepared' && !Object.hasOwn(intent, 'worktree'))
      || !safeId(expectedInstanceId) || intent.idempotencyKey !== `${expectedInstanceId}:${nodeId}:${intent.attempt}`) fail('invalid-runtime-input');
    const allocation = intent.allocation; const nodeBudget = nodesById.get(nodeId).budget;
    if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)
      || Reflect.ownKeys(allocation).length !== 4
      || ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit'].some(key => !Object.hasOwn(allocation, key))
      || !Number.isSafeInteger(allocation.timeMinutes) || allocation.timeMinutes < 1 || allocation.timeMinutes > nodeBudget.timeMinutes
      || !Number.isSafeInteger(allocation.tokenLimit) || allocation.tokenLimit < 1 || allocation.tokenLimit > nodeBudget.tokenLimit
      || !Number.isSafeInteger(allocation.taskLimit) || allocation.taskLimit < 1 || allocation.taskLimit > nodeBudget.taskLimit
      || typeof allocation.costUsd !== 'string' || decimalCompare(allocation.costUsd, 0) <= 0
      || decimalCompare(allocation.costUsd, nodeBudget.costUsd) > 0) fail('invalid-runtime-input');
    const claim = intent?.preparationClaim;
    if (claim !== undefined && (!claim || typeof claim !== 'object' || Array.isArray(claim) || Reflect.ownKeys(claim).length !== 2
      || !safeId(claim.id) || !Number.isSafeInteger(claim.claimedAtMs) || claim.claimedAtMs < 0
      || intent.status !== 'committed')) fail('invalid-runtime-input');
    if ((Object.hasOwn(intent, 'startedAtMs') && (!Number.isSafeInteger(intent.startedAtMs) || intent.startedAtMs < 0))
      || (Object.hasOwn(intent, 'retryAtMs') && (!Number.isSafeInteger(intent.retryAtMs) || intent.retryAtMs < 0))) fail('invalid-runtime-input');
    if (intent?.status === 'started' && (intent.nodeId !== nodeId || !nodesById.has(nodeId)
      || !Number.isSafeInteger(intent.startedAtMs) || intent.startedAtMs < 0)) fail('invalid-runtime-input');
    if (Object.hasOwn(intent, 'worktree')) {
      let worktree;
      try { worktree = captureWorktree(intent.worktree); } catch { fail('invalid-runtime-input'); }
      if (worktree.reservationId !== intent.reservationId) fail('invalid-runtime-input');
      intent.worktree = worktree;
    }
  }
  for (let index = applied; index < state.events.length; index += 1) {
    const pending = state.events[index];
    if (['state-transition', 'cancelled'].includes(pending.type)) state.graph = reduceGraph(state.graph, pending);
    else if (pending.type === 'retry') {
      state.attempts[pending.nodeId] = (state.attempts[pending.nodeId] ?? 1) + 1;
      state.usage.retries += 1;
    } else if (pending.type === 'heartbeat') {
      const node = state.graph.nodes.find(item => item.id === pending.nodeId); const intent = state.launchIntents[pending.nodeId];
      const heartbeat = createHeartbeat({
        version: 1,
        instanceId: pending.instanceId,
        nodeId: pending.nodeId,
        actorId: pending.actor.id,
        leaseId: pending.leaseId,
        sequence: pending.heartbeatSequence,
        timestampMs: Date.parse(pending.timestamp),
        intervalMs: pending.heartbeatIntervalMs,
      });
      const prior = state.heartbeats[pending.nodeId] ? createHeartbeat(state.heartbeats[pending.nodeId]) : null;
      const same = prior && Object.keys(heartbeat).every(key => heartbeat[key] === prior[key]);
      if (!safeId(expectedInstanceId) || !node || !intent || heartbeat.instanceId !== expectedInstanceId || heartbeat.nodeId !== node.id || heartbeat.actorId !== node.owner.id || pending.actor.role !== node.owner.role
        || heartbeat.leaseId !== intent.reservationId
        || (prior && !same && (heartbeat.sequence <= prior.sequence || heartbeat.timestampMs < prior.timestampMs))) fail('invalid-runtime-input');
      state.heartbeats[pending.nodeId] = heartbeat; state.lastHeartbeatAt[pending.nodeId] = heartbeat.timestampMs;
    }
    else if (pending.type === 'evidence-recorded' || pending.type === 'approval-recorded') {
      const approvalReceiptId = pending.type === 'approval-recorded' ? pending.approvalReceiptId : null;
      if (approvalReceiptId && (pending.actor.role !== 'human' || !pending.evidenceRefs.includes(approvalReceiptId))) fail('invalid-runtime-input');
      if (!pending.nodeId) { if (pending.type === 'approval-recorded') state.activated = true; }
      else {
        const node = state.graph.nodes.find(item => item.id === pending.nodeId);
        if (!node) fail('invalid-runtime-input');
        if (approvalReceiptId) {
          const actual = [...pending.evidenceRefs].sort(); const expected = [...node.evidenceRefs].sort();
          if (node.owner.role !== 'boss' || !node.approvalGate || actual.length !== expected.length
            || actual.some((item, index) => item !== expected[index])) fail('invalid-runtime-input');
        }
        const bindings = approvalReceiptId
          ? evidenceBindings(node, new Map([[approvalReceiptId, 'human-approval']]))
          : bindingsByNode.get(node.id);
        for (const id of pending.evidenceRefs) {
          const type = bindings.get(id);
          if (!type) fail('invalid-runtime-input');
          if (!state.evidence.some(item => item.id === id && item.nodeId === node.id)) state.evidence.push({ id, nodeId: node.id, type, approvalState: 'approved' });
        }
      }
    } else if (pending.type === 'authority-adjusted') {
      const node = state.graph.nodes.find(item => item.id === pending.nodeId); if (!node) fail('invalid-runtime-input');
      const scopes = new Set(node.authorityScopes); for (const value of pending.authorityDelta.removed) scopes.delete(value); for (const value of pending.authorityDelta.added) scopes.add(value);
      node.authorityScopes = [...scopes].sort(); state.graph = validatedGraphSnapshot(state.graph);
    } else if (pending.type === 'budget-adjusted') {
      const node = state.graph.nodes.find(item => item.id === pending.nodeId); if (!node) fail('invalid-runtime-input');
      for (const [key, delta] of Object.entries(pending.budgetDelta)) node.budget[key] += delta;
      state.graph = validatedGraphSnapshot(state.graph);
    } else if (pending.type !== 'graph-created') fail('invalid-runtime-input');
  }
  const reducedNodesById = new Map(state.graph.nodes.map(node => [node.id, node]));
  for (const [nodeId, intent] of Object.entries(state.launchIntents)) {
    const nodeStatus = reducedNodesById.get(nodeId)?.status;
    if ((['committed', 'prepared'].includes(intent.status) && nodeStatus !== 'reserved')
      || (intent.status === 'started' && nodeStatus !== 'running')
      || (intent.status === 'recovered' && nodeStatus !== 'ready')
      || (intent.status === 'complete' && ['reserved', 'running'].includes(nodeStatus))) fail('invalid-runtime-input');
  }
  for (const node of state.graph.nodes) {
    const intentStatus = state.launchIntents[node.id]?.status;
    if ((node.status === 'reserved' && !['committed', 'prepared'].includes(intentStatus))
      || (node.status === 'running' && intentStatus !== 'started')) fail('invalid-runtime-input');
  }
  validateDurableIntentRelations(state, retryDelaysMs);
  state.appliedSequence = state.events.length;
  state.terminal ??= null;
  return state;
}

/** Validate a saved default-policy host runtime without acquiring locks or writing state. */
export function validateRuntimeSnapshot(input, instanceId) {
  return immutableJson(canonicalState(input, instanceId, [0, 0]));
}

async function transaction(instance, expectedVersion, operation, retryDelaysMs = null) {
  assertInstance(instance);
  const lock = await instance.acquire();
  if (!lock || typeof lock.release !== 'function') fail('invalid-runtime-input');
  try {
    const current = canonicalState(await instance.read(), instance.id, retryDelaysMs);
    if (exactVersion(current.version) !== exactVersion(expectedVersion)) fail('version-conflict');
    const priorVersion = current.version;
    const next = await operation(current);
    if (next === null) return current;
    next.version = priorVersion + 1;
    next.appliedSequence = next.events.length;
    const validatedNext = canonicalState(next, instance.id, retryDelaysMs);
    return canonicalState(await instance.commit(priorVersion, validatedNext), instance.id, retryDelaysMs);
  } catch (error) {
    if (error?.code === 'ERR_STATE_VERSION_CONFLICT') fail('version-conflict');
    throw error;
  } finally { await lock.release(); }
}

export { transaction as runtimeTransaction };

function event(state, nowMs, values) {
  if (!Array.isArray(state.events) || state.events.length >= 10_000) fail('invalid-runtime-input');
  const sequence = state.events.length + 1;
  const persisted = { schemaVersion: 1, eventId: `runtime-${sequence}`, graphId: state.graph.id, sequence, timestamp: iso(nowMs), actor: values.actor, ...values.event };
  try { validateEvent(persisted); } catch { fail('invalid-runtime-input'); }
  state.events.push(persisted); state.appliedSequence = state.events.length;
  return persisted;
}

export { event as appendRuntimeEvent };

function transition(state, node, status, nowMs, actor = { role: 'system', id: 'runtime' }) {
  const graphTarget = Array.isArray(node?.nodes);
  const nodeId = graphTarget ? null : node?.id;
  const target = graphTarget ? state.graph : state.graph.nodes.find(item => item.id === nodeId);
  if (!target) fail('invalid-runtime-input');
  const persisted = event(state, nowMs, { actor, event: { type: 'state-transition', ...(nodeId ? { nodeId } : {}), priorState: target.status, newState: status } });
  state.graph = reduceGraph(state.graph, persisted);
  return nodeId ? state.graph.nodes.find(item => item.id === nodeId) : state.graph;
}

export { transition as transitionRuntimeState };

function decimal(value) {
  const source = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const match = typeof source === 'string' && source.length <= 64 ? /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source) : null;
  if (!match) fail('invalid-runtime-input');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) fail('invalid-runtime-input');
  let digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+(?=\d)/, '');
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  return { coefficient: BigInt(digits || '0'), scale };
}

function decimalAt(value, scale) { return value.coefficient * (10n ** BigInt(scale - value.scale)); }
function decimalCompare(leftValue, rightValue) {
  const left = decimal(leftValue); const right = decimal(rightValue); const scale = Math.max(left.scale, right.scale);
  const leftScaled = decimalAt(left, scale); const rightScaled = decimalAt(right, scale);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}
function decimalText(coefficient, scale) {
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
function decimalMath(leftValue, rightValue, subtract = false) {
  const left = decimal(leftValue); const right = decimal(rightValue); const scale = Math.max(left.scale, right.scale);
  const result = decimalAt(left, scale) + (subtract ? -decimalAt(right, scale) : decimalAt(right, scale));
  if (result < 0n) fail('invalid-runtime-input');
  return decimalText(result, scale);
}

const NODE_USAGE_KEYS = Object.freeze(['tokens', 'costUsd', 'timeMinutes', 'tasks']);
const GLOBAL_USAGE_KEYS = Object.freeze(['tokens', 'costUsd', 'retries', 'timeMinutes', 'taskLimit']);
function zeroNodeUsage() { return { tokens: 0, costUsd: '0', timeMinutes: 0, tasks: 0 }; }
function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-runtime-input');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) fail('invalid-runtime-input');
}
function validateNodeUsage(value) {
  exactRecord(value, NODE_USAGE_KEYS);
  if (!Number.isSafeInteger(value.tokens) || value.tokens < 0
    || !Number.isSafeInteger(value.timeMinutes) || value.timeMinutes < 0
    || !Number.isSafeInteger(value.tasks) || value.tasks < 0
    || decimalCompare(value.costUsd, 0) < 0) fail('invalid-runtime-input');
}
function addNodeUsage(total, value) {
  total.tokens += value.tokens; total.timeMinutes += value.timeMinutes; total.tasks += value.tasks;
  if (!Number.isSafeInteger(total.tokens) || !Number.isSafeInteger(total.timeMinutes) || !Number.isSafeInteger(total.tasks)) fail('invalid-runtime-input');
  total.costUsd = decimalMath(total.costUsd, value.costUsd);
}
function sameNodeUsage(left, right) {
  return left.tokens === right.tokens && left.timeMinutes === right.timeMinutes && left.tasks === right.tasks
    && decimalCompare(left.costUsd, right.costUsd) === 0;
}
function validateUsageLedgers(state) {
  if (!state.usage || typeof state.usage !== 'object' || Array.isArray(state.usage)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(state.usage))) fail('invalid-runtime-input');
  exactRecord(state.usage, GLOBAL_USAGE_KEYS);
  if (!Number.isSafeInteger(state.usage.tokens) || state.usage.tokens < 0
    || !Number.isSafeInteger(state.usage.retries) || state.usage.retries < 0
    || !Number.isSafeInteger(state.usage.timeMinutes) || state.usage.timeMinutes < 0
    || !Number.isSafeInteger(state.usage.taskLimit) || state.usage.taskLimit < 0
    || decimalCompare(state.usage.costUsd, 0) < 0) fail('invalid-runtime-input');
  let retryFacts = 0;
  for (let index = 0; index < state.events.length; index += 1) if (state.events[index].type === 'retry') retryFacts += 1;
  if (state.usage.retries !== retryFacts) fail('invalid-runtime-input');

  const nodes = new Map(state.graph.nodes.map(node => [node.id, node]));
  const total = zeroNodeUsage(); const expectedDelegated = new Map(state.graph.nodes.map(node => [node.id, zeroNodeUsage()]));
  for (const [name, ledger] of [['nodeUsage', state.nodeUsage], ['delegatedUsage', state.delegatedUsage]]) {
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(ledger))) fail('invalid-runtime-input');
    const keys = Reflect.ownKeys(ledger);
    if (keys.some(key => typeof key !== 'string' || !nodes.has(key))) fail('invalid-runtime-input');
    for (const key of keys) validateNodeUsage(ledger[key]);
    if (name === 'delegatedUsage') continue;
    for (const nodeId of keys) {
      const value = ledger[nodeId]; addNodeUsage(total, value);
      for (const ancestor of ancestorNodes(state, nodes.get(nodeId))) addNodeUsage(expectedDelegated.get(ancestor.id), value);
    }
  }
  if (state.usage.tokens !== total.tokens || state.usage.timeMinutes !== total.timeMinutes || state.usage.taskLimit !== total.tasks
    || decimalCompare(state.usage.costUsd, total.costUsd) !== 0) fail('invalid-runtime-input');
  for (const nodeId of nodes.keys()) {
    const actual = state.delegatedUsage[nodeId] ?? zeroNodeUsage();
    if (!sameNodeUsage(actual, expectedDelegated.get(nodeId))) fail('invalid-runtime-input');
  }
}

function availableBudget(state) {
  const limits = state.limits ?? {}; const usage = state.usage ?? {};
  const available = {
    tokenLimit: (limits.tokenLimit ?? limits.tokens ?? Number.MAX_SAFE_INTEGER) - (usage.tokens ?? 0),
    costUsd: decimalMath(limits.costUsd ?? '999999999999999', usage.costUsd ?? 0, true),
    timeMinutes: (limits.timeMinutes ?? Number.MAX_SAFE_INTEGER) - (usage.timeMinutes ?? 0),
    taskLimit: (limits.taskLimit ?? Number.MAX_SAFE_INTEGER) - (usage.taskLimit ?? 0),
    retries: (limits.retries ?? 0) - (usage.retries ?? 0),
  };
  for (const intent of Object.values(state.launchIntents ?? {})) {
    if (!['committed', 'prepared', 'started'].includes(intent.status) || !intent.allocation) continue;
    reserveBudget(available, intent.allocation);
  }
  return available;
}

function budgetFits(budget, available) {
  return budget.tokenLimit <= available.tokenLimit && decimalCompare(budget.costUsd, available.costUsd) <= 0
    && budget.timeMinutes <= available.timeMinutes && budget.taskLimit <= available.taskLimit;
}

function reserveBudget(available, budget) {
  available.tokenLimit -= budget.tokenLimit;
  available.costUsd = decimalMath(available.costUsd, budget.costUsd, true);
  available.timeMinutes -= budget.timeMinutes;
  available.taskLimit -= budget.taskLimit;
}

function remainingNodeBudget(state, node) {
  const used = state.nodeUsage?.[node.id] ?? {};
  const budget = {
    tokenLimit: node.budget.tokenLimit - (used.tokens ?? 0),
    costUsd: decimalMath(node.budget.costUsd, used.costUsd ?? 0, true),
    timeMinutes: node.budget.timeMinutes - (used.timeMinutes ?? 0),
    taskLimit: node.budget.taskLimit - (used.tasks ?? 0),
  };
  if (budget.tokenLimit < 0 || budget.timeMinutes < 0 || budget.taskLimit < 0) fail('invalid-runtime-input');
  return budget;
}

export { remainingNodeBudget as remainingRuntimeNodeBudget };

function ancestorNodes(state, node) {
  const byId = new Map(state.graph.nodes.map(item => [item.id, item]));
  const ancestors = []; let parentId = node.parentId;
  while (parentId) {
    const parent = byId.get(parentId); if (!parent || ancestors.length >= state.graph.maxDelegationDepth) fail('invalid-runtime-input');
    ancestors.push(parent); parentId = parent.parentId;
  }
  return ancestors;
}

function remainingParentBudget(state, parent) {
  const own = state.nodeUsage?.[parent.id] ?? {}; const delegated = state.delegatedUsage?.[parent.id] ?? {};
  return {
    tokenLimit: parent.budget.tokenLimit - (own.tokens ?? 0) - (delegated.tokens ?? 0),
    costUsd: decimalMath(decimalMath(parent.budget.costUsd, own.costUsd ?? 0, true), delegated.costUsd ?? 0, true),
    timeMinutes: parent.budget.timeMinutes - (own.timeMinutes ?? 0) - (delegated.timeMinutes ?? 0),
    taskLimit: parent.budget.taskLimit - (own.tasks ?? 0) - (delegated.tasks ?? 0),
  };
}

function validateRetryDeadline(state, nodeId, deadlineMs, retryDelaysMs) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs >= Number.MAX_SAFE_INTEGER) fail('invalid-runtime-input');
  let retryFact = null;
  for (const candidate of state.events) if (candidate.type === 'retry' && candidate.nodeId === nodeId) retryFact = candidate;
  if (!retryFact) fail('invalid-runtime-input');
  const factMs = Date.parse(retryFact.timestamp); const delayMs = deadlineMs - factMs;
  const retryScheduleIndex = state.attempts[nodeId] - 2;
  if (!Number.isSafeInteger(factMs) || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_DELAY_MS
    || (retryDelaysMs && (!Number.isSafeInteger(retryScheduleIndex) || retryScheduleIndex < 0
      || retryScheduleIndex >= retryDelaysMs.length || delayMs !== retryDelaysMs[retryScheduleIndex]))) fail('invalid-runtime-input');
}

function validateNonnegativeBudget(value) {
  if (!Number.isSafeInteger(value.tokenLimit) || value.tokenLimit < 0
    || !Number.isSafeInteger(value.timeMinutes) || value.timeMinutes < 0
    || !Number.isSafeInteger(value.taskLimit) || value.taskLimit < 0
    || (Object.hasOwn(value, 'retries') && (!Number.isSafeInteger(value.retries) || value.retries < 0))
    || decimalCompare(value.costUsd, 0) < 0) fail('invalid-runtime-input');
}

function validateDurableIntentRelations(state, retryDelaysMs) {
  validateUsageLedgers(state);
  const activeStatuses = new Set(['committed', 'prepared', 'started']);
  const active = []; const reservations = new Set(); const worktreePaths = new Set(); const worktreeIdentities = new Set();
  for (const [nodeId, intent] of Object.entries(state.launchIntents)) {
    const node = state.graph.nodes.find(item => item.id === nodeId); const recordedAttempt = state.attempts[nodeId];
    if (intent.id !== launchIntentId(nodeId, intent.attempt) || !Number.isSafeInteger(recordedAttempt)
      || recordedAttempt < intent.attempt || recordedAttempt > 10_000) fail('invalid-runtime-input');
    if (activeStatuses.has(intent.status)) {
      if (recordedAttempt !== intent.attempt || (retryDelaysMs && intent.attempt > retryDelaysMs.length + 1)
        || reservations.has(intent.reservationId)) fail('invalid-runtime-input');
      reservations.add(intent.reservationId); active.push({ node, intent });
      if (intent.worktree) {
        const identity = `${intent.worktree.dev}:${intent.worktree.ino}`;
        if (worktreePaths.has(intent.worktree.path) || worktreeIdentities.has(identity)) fail('invalid-runtime-input');
        worktreePaths.add(intent.worktree.path); worktreeIdentities.add(identity);
      }
      const remaining = remainingNodeBudget(state, node);
      if (intent.allocation.tokenLimit !== remaining.tokenLimit || intent.allocation.timeMinutes !== remaining.timeMinutes
        || intent.allocation.taskLimit !== remaining.taskLimit || decimalCompare(intent.allocation.costUsd, remaining.costUsd) !== 0) fail('invalid-runtime-input');
    }
    if (Object.hasOwn(intent, 'retryAtMs')) {
      if (intent.status !== 'complete' || !['corrective', 'ready'].includes(node.status)) fail('invalid-runtime-input');
      validateRetryDeadline(state, nodeId, intent.retryAtMs, retryDelaysMs);
    }
  }
  if (state.retryAtMs !== undefined) {
    if (!state.retryAtMs || typeof state.retryAtMs !== 'object' || Array.isArray(state.retryAtMs)) fail('invalid-runtime-input');
    const retryKeys = Reflect.ownKeys(state.retryAtMs);
    if (retryKeys.length > state.graph.nodes.length || retryKeys.some(key => typeof key !== 'string')) fail('invalid-runtime-input');
    for (const nodeId of retryKeys) {
      const node = state.graph.nodes.find(item => item.id === nodeId); const intent = state.launchIntents[nodeId];
      if (!safeId(nodeId) || !node || node.status !== 'corrective' || Object.hasOwn(intent ?? {}, 'retryAtMs')) fail('invalid-runtime-input');
      validateRetryDeadline(state, nodeId, state.retryAtMs[nodeId], retryDelaysMs);
    }
  }
  validateNonnegativeBudget(availableBudget(state));
  const parentAvailability = new Map(state.graph.nodes.map(parent => [parent.id, remainingParentBudget(state, parent)]));
  for (const { node, intent } of active) for (const parent of ancestorNodes(state, node)) reserveBudget(parentAvailability.get(parent.id), intent.allocation);
  for (const remaining of parentAvailability.values()) validateNonnegativeBudget(remaining);
}

function captureResult(input) {
  try {
    const value = captureOptions(input, ['version', 'status', 'output', 'usage'], ['version', 'status', 'output', 'usage']);
    const output = immutableJson(value.output);
    const usage = immutableJson(value.usage);
    if (value.version !== 1 || !['success', 'retry', 'failed', 'blocked', 'budget-exhausted'].includes(value.status)
      || Reflect.ownKeys(output).some(key => !['summary', 'evidence'].includes(key))
      || Reflect.ownKeys(usage).some(key => !['tokens', 'costUsd', 'timeMinutes', 'tasks'].includes(key))
      || typeof output.summary !== 'string' || output.summary.length < 1 || containsSecretMaterial(output.summary)
      || !Array.isArray(output.evidence) || output.evidence.length > 64
      || output.evidence.some(item => !safeId(item) || containsSecretMaterial(item))
      || new Set(output.evidence).size !== output.evidence.length
      || !Number.isSafeInteger(usage.tokens) || usage.tokens < 0
      || typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
      || (usage.timeMinutes !== undefined && (!Number.isSafeInteger(usage.timeMinutes) || usage.timeMinutes < 0))
      || (usage.tasks !== undefined && (!Number.isSafeInteger(usage.tasks) || usage.tasks < 0))) fail('client-output');
    return Object.freeze({ version: 1, status: value.status, output, usage });
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    fail('client-output');
  }
}

function classify(error) {
  let code;
  try { code = error?.code; } catch { return 'malformed-output'; }
  if (code === 'ERR_AGENT_TIMEOUT' || code === 'ERR_AGENT_PROVIDER_UNAVAILABLE') return 'provider-transient';
  if (code === 'ERR_AGENT_ABORTED') return 'cancelled';
  return 'malformed-output';
}

function deriveTerminal(state, nowMs) {
  if (state.terminal === 'cancelled' || state.terminal === 'budget-exhausted') return;
  const statuses = state.graph.nodes.map(node => node.status);
  let terminal = null;
  if (statuses.includes('failed')) terminal = 'failed';
  else if (statuses.includes('blocked')) terminal = 'blocked';
  else if (statuses.every(status => ['completed', 'archived'].includes(status))) terminal = 'completed';
  if (!terminal) return;
  state.terminal = terminal;
  if (terminal === 'completed' && state.graph.status === 'running') transition(state, state.graph, 'verifying', nowMs);
  if (state.graph.status !== terminal) transition(state, state.graph, terminal, nowMs);
}

export function createOrchestrator(input) {
  const config = captureOptions(input, ['client', 'now', 'launchFor', 'reservationId', 'retryPolicy', 'prepareWorktree', 'reconcile', 'processStatus', 'launchGraceMs'], ['client', 'now', 'launchFor']);
  if (!config.client || typeof config.client.launch !== 'function' || typeof config.now !== 'function' || typeof config.launchFor !== 'function'
    || (config.prepareWorktree !== undefined && typeof config.prepareWorktree !== 'function')
    || (config.reconcile !== undefined && typeof config.reconcile !== 'function')
    || (config.processStatus !== undefined && typeof config.processStatus !== 'function')) fail('invalid-runtime-input');
  const launchGraceMs = config.launchGraceMs ?? 5_000;
  if (!Number.isSafeInteger(launchGraceMs) || launchGraceMs < 100 || launchGraceMs > 300_000) fail('invalid-runtime-input');
  const retryPolicy = config.retryPolicy ?? createRetryPolicy({ maxAttempts: 3, delaysMs: [0, 0], retryable: ['provider-transient'] });
  const retryDelaysMs = retryPolicySchedule(retryPolicy);
  const canonicalRuntimeState = (state, instanceId) => canonicalState(state, instanceId, retryDelaysMs);
  const runTransaction = (instance, expectedVersion, operation) => transaction(instance, expectedVersion, operation, retryDelaysMs);
  const controllers = new Map();
  const inflight = new Map();
  const resultQueues = new Map();

  async function settleApprovalFailure(instance, expectedVersion, claim, persisted) {
    let current; let lock;
    try {
      lock = await instance.acquire(); current = canonicalRuntimeState(await instance.read(), instance.id);
    } catch { return; }
    finally { if (lock) await lock.release(); }
    if (persisted(current)) { claim.publish(); return; }
    if (!claim.rollback()) claim.release();
  }

  async function serializeResult(instanceId, operation) {
    const prior = resultQueues.get(instanceId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    resultQueues.set(instanceId, current);
    try { return await current; }
    finally { if (resultQueues.get(instanceId) === current) resultQueues.delete(instanceId); }
  }

  async function observeProcess(request) {
    const controller = new AbortController();
    const timeoutToken = Object.freeze(Object.create(null));
    let timer;
    try {
      const provider = Promise.resolve().then(() => config.processStatus(request, { signal: controller.signal }))
        .then(value => Object.freeze({ ok: true, value }), () => Object.freeze({ ok: false }));
      const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(timeoutToken); }, Math.min(launchGraceMs, 5_000)); });
      const outcome = await Promise.race([provider, timeout]);
      if (outcome === timeoutToken || outcome.ok !== true || !['running', 'absent'].includes(outcome.value)) fail('invalid-runtime-input');
      return outcome.value;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function activate(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'receipt', 'registry', 'authority', 'expectedApproverId'], ['expectedVersion']);
    if (!options.receipt || !options.registry || !options.authority || !options.expectedApproverId) fail('approval-required');
    const decision = evaluateAuthority(options.authority, { actorId: options.authority.actorId, action: 'activation', resource: instance.id });
    if (decision.policyId !== 'authority.human-gate.activation') fail('approval-required');
    const claim = claimApproval(options.receipt, { subjectId: options.authority.actorId, action: 'activation', resource: instance.id, policyId: 'authority.human-gate.activation' }, { registry: options.registry, expectedApproverId: options.expectedApproverId, requireHumanApprover: true, requireSingleUse: true, nowMs: config.now() });
    if (!claim.valid) fail('approval-required');
    try {
      if (!claim.finalize()) fail('approval-required');
      const persisted = await runTransaction(instance, options.expectedVersion, state => {
        if (state.activated) return null;
        state.activated = true; const nowMs = config.now();
        event(state, nowMs, { actor: { role: 'human', id: options.expectedApproverId }, event: { type: 'approval-recorded', evidenceRefs: [options.receipt.id], approvalReceiptId: options.receipt.id } });
        if (state.graph.status === 'approved') transition(state, state.graph, 'ready', nowMs);
        if (state.graph.status === 'ready') transition(state, state.graph, 'reserved', nowMs);
        if (state.graph.status === 'reserved') transition(state, state.graph, 'running', nowMs);
        return state;
      });
      if (!claim.publish()) fail('approval-required');
      return persisted;
    } catch (error) {
      await settleApprovalFailure(instance, options.expectedVersion, claim, state => state.activated === true && state.events.some(item => item.type === 'approval-recorded' && !item.nodeId && item.approvalReceiptId === options.receipt.id));
      throw error;
    }
  }

  async function approveNode(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'nodeId', 'evidence', 'receipt', 'registry', 'authority', 'expectedApproverId'], ['expectedVersion', 'nodeId', 'evidence']);
    if (!safeId(options.nodeId) || !options.receipt || !options.registry || !options.authority || !options.expectedApproverId) fail('approval-required');
    const evidence = immutableJson(options.evidence);
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 64 || evidence.some(item => {
      const keys = item && typeof item === 'object' ? Reflect.ownKeys(item) : [];
      return keys.length !== 2 || !keys.includes('id') || !keys.includes('type') || !safeId(item.id) || !safeId(item.type);
    })) fail('invalid-runtime-input');
    const resource = `${instance.id}:${options.nodeId}`;
    const inspectLock = await instance.acquire(); let inspected;
    try { inspected = canonicalRuntimeState(await instance.read(), instance.id); } finally { await inspectLock.release(); }
    if (inspected.version !== exactVersion(options.expectedVersion)) fail('version-conflict');
    const gate = inspected.graph.nodes.find(item => item.id === options.nodeId)?.approvalGate;
    if (!safeId(gate)) fail('approval-required');
    const policyId = `authority.human-gate.${gate}`;
    const decision = evaluateAuthority(options.authority, { actorId: options.authority.actorId, action: gate, resource });
    if (decision.policyId !== policyId) fail('approval-required');
    const claim = claimApproval(options.receipt, { subjectId: options.authority.actorId, action: gate, resource, policyId }, { registry: options.registry, expectedApproverId: options.expectedApproverId, requireHumanApprover: true, requireSingleUse: true, nowMs: config.now() });
    if (!claim.valid) fail('approval-required');
    try {
      if (!claim.finalize()) fail('approval-required');
      const persisted = await runTransaction(instance, options.expectedVersion, state => {
        const node = state.graph.nodes.find(item => item.id === options.nodeId);
        const nodes = new Map(state.graph.nodes.map(item => [item.id, item]));
        if (node?.approvalGate !== gate || node.status !== 'ready' || !node.dependencies.every(id => nodes.get(id)?.status === 'completed')) fail('approval-required');
        const bindings = evidenceBindings(node, new Map([[options.receipt.id, 'human-approval']]));
        const actualIds = evidence.map(item => item.id).sort(); const expectedIds = [...bindings.keys()].sort();
        const actualTypes = evidence.map(item => item.type).sort(); const expectedTypes = [...bindings.values()].sort();
        if (actualIds.length !== expectedIds.length || actualIds.some((item, index) => item !== expectedIds[index])
          || actualTypes.some((item, index) => item !== expectedTypes[index])
          || evidence.some(item => bindings.get(item.id) !== item.type)
          || !actualIds.includes(options.receipt.id) || !actualTypes.includes('human-approval')) fail('approval-required');
        const nowMs = config.now();
        transition(state, node, 'reserved', nowMs);
        transition(state, node, 'running', nowMs);
        transition(state, node, 'verifying', nowMs);
        state.evidence.push(...[...bindings].map(([id, type]) => ({ id, nodeId: node.id, type, approvalState: 'approved' })));
        event(state, nowMs, { actor: { role: 'human', id: options.expectedApproverId }, event: { type: 'approval-recorded', nodeId: node.id, evidenceRefs: evidence.map(item => item.id).sort(), approvalReceiptId: options.receipt.id } });
        transition(state, node, 'completed', nowMs);
        deriveTerminal(state, nowMs);
        return state;
      });
      if (!claim.publish()) fail('approval-required');
      return persisted;
    } catch (error) {
      await settleApprovalFailure(instance, options.expectedVersion, claim, state => state.graph.nodes.find(item => item.id === options.nodeId)?.status === 'completed'
        && state.events.some(item => item.type === 'approval-recorded' && item.nodeId === options.nodeId && item.approvalReceiptId === options.receipt.id));
      throw error;
    }
  }

  async function recordHeartbeat(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'heartbeat'], ['expectedVersion', 'heartbeat']);
    const heartbeat = createHeartbeat(options.heartbeat);
    const observedNow = config.now();
    if (!Number.isSafeInteger(observedNow) || observedNow < 0 || heartbeat.timestampMs > observedNow) fail('invalid-runtime-input');
    return runTransaction(instance, options.expectedVersion, state => {
      const node = state.graph.nodes.find(item => item.id === heartbeat.nodeId);
      const intent = state.launchIntents[heartbeat.nodeId];
      const prior = state.heartbeats[heartbeat.nodeId];
      if (heartbeat.instanceId !== instance.id || !node || node.owner.id !== heartbeat.actorId
        || !intent || intent.reservationId !== heartbeat.leaseId || !['committed', 'prepared', 'started'].includes(intent.status)
        || (prior && (heartbeat.sequence <= prior.sequence || heartbeat.timestampMs < prior.timestampMs))) fail('invalid-runtime-input');
      state.heartbeats[heartbeat.nodeId] = heartbeat;
      event(state, heartbeat.timestampMs, { actor: node.owner, event: { type: 'heartbeat', nodeId: node.id, instanceId: heartbeat.instanceId, leaseId: heartbeat.leaseId, heartbeatSequence: heartbeat.sequence, heartbeatIntervalMs: heartbeat.intervalMs } });
      return state;
    });
  }

  async function commitResult(instance, intent, outcome) {
    let result; let classification;
    if (outcome.error) classification = classify(outcome.error);
    else {
      try { result = captureResult(outcome.result); classification = result.status; }
      catch { classification = 'malformed-output'; }
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = await instance.acquire();
      let version;
      try { version = (await instance.read()).version; } finally { await observed.release(); }
      try {
        return await runTransaction(instance, version, state => {
          if (state.terminal === 'cancelled' || state.launchIntents[intent.nodeId]?.status === 'complete') return null;
          const node = state.graph.nodes.find(item => item.id === intent.nodeId);
          const storedIntent = state.launchIntents[intent.nodeId];
          if (storedIntent?.id !== intent.id || storedIntent.attempt !== intent.attempt) return null;
          const preparationFailure = outcome.phase === 'prepare' && node?.status === 'reserved'
            && storedIntent?.id === intent.id && storedIntent.status === 'committed'
            && storedIntent.preparationClaim?.id === outcome.preparationClaimId;
          if (outcome.phase === 'prepare' && !preparationFailure) return null;
          if (!node || (node.status !== 'running' && !preparationFailure)) return null;
          let retryNowMs;
          state.usage ??= { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0, taskLimit: 0 };
          if (result) {
            const allocation = state.launchIntents[intent.nodeId]?.allocation ?? node.budget;
            const elapsed = Math.ceil(Math.max(0, config.now() - (state.launchIntents[intent.nodeId]?.startedAtMs ?? config.now())) / 60_000);
            const attemptUsage = { tokens: result.usage.tokens, costUsd: result.usage.costUsd, timeMinutes: result.usage.timeMinutes ?? elapsed, tasks: result.usage.tasks ?? 1 };
            if (attemptUsage.tokens > allocation.tokenLimit || decimalCompare(attemptUsage.costUsd, allocation.costUsd) > 0
              || attemptUsage.timeMinutes > allocation.timeMinutes || attemptUsage.tasks > allocation.taskLimit) { result = undefined; classification = 'malformed-output'; }
            else {
              state.usage.tokens += attemptUsage.tokens;
              state.usage.costUsd = decimalMath(state.usage.costUsd ?? 0, attemptUsage.costUsd);
              state.usage.timeMinutes = (state.usage.timeMinutes ?? 0) + attemptUsage.timeMinutes;
              state.usage.taskLimit = (state.usage.taskLimit ?? 0) + attemptUsage.tasks;
              const prior = state.nodeUsage[node.id] ?? { tokens: 0, costUsd: '0', timeMinutes: 0, tasks: 0 };
              state.nodeUsage[node.id] = { tokens: prior.tokens + attemptUsage.tokens, costUsd: decimalMath(prior.costUsd, attemptUsage.costUsd), timeMinutes: prior.timeMinutes + attemptUsage.timeMinutes, tasks: prior.tasks + attemptUsage.tasks };
              for (const parent of ancestorNodes(state, node)) {
                const delegated = state.delegatedUsage[parent.id] ?? { tokens: 0, costUsd: '0', timeMinutes: 0, tasks: 0 };
                state.delegatedUsage[parent.id] = { tokens: delegated.tokens + attemptUsage.tokens, costUsd: decimalMath(delegated.costUsd, attemptUsage.costUsd), timeMinutes: delegated.timeMinutes + attemptUsage.timeMinutes, tasks: delegated.tasks + attemptUsage.tasks };
              }
            }
          }
          if (classification === 'cancelled') { transition(state, node, 'cancelled', config.now()); }
          else if (result?.status === 'success') {
            const exact = [...result.output.evidence].sort();
            const expected = [...node.evidenceRefs].sort();
            if (node.requiredEvidenceTypes.includes('human-approval')
              || exact.length !== expected.length || exact.some((id, index) => id !== expected[index])) {
              transition(state, node, 'blocked', config.now());
            } else {
              transition(state, node, 'verifying', config.now());
              const bindings = evidenceBindings(node);
              state.evidence.push(...exact.map(id => ({ id, nodeId: node.id, type: bindings.get(id), approvalState: 'approved' })));
              event(state, config.now(), { actor: node.owner, event: { type: 'evidence-recorded', nodeId: node.id, evidenceRefs: exact } });
              transition(state, node, 'completed', config.now());
            }
          } else {
            const currentAttempt = state.attempts[node.id] ?? 1;
            const decision = retryDecision(retryPolicy, { attempt: currentAttempt, classification: classification === 'retry' ? 'provider-transient' : classification });
            if (decision.retry && availableBudget(state).retries > 0) {
              retryNowMs = config.now();
              state.attempts[node.id] = decision.nextAttempt;
              state.usage.retries += 1;
              delete state.heartbeats[node.id];
              delete state.lastHeartbeatAt[node.id];
              event(state, retryNowMs, { actor: node.owner, event: { type: 'retry', nodeId: node.id, retryReason: classification } });
              if (preparationFailure) {
                state.launchIntents[node.id].retryAtMs = retryNowMs + decision.delayMs;
                transition(state, node, 'ready', retryNowMs);
              } else {
                transition(state, node, 'corrective', retryNowMs);
                state.launchIntents[node.id].retryAtMs = retryNowMs + decision.delayMs;
                if (decision.delayMs === 0) transition(state, node, 'ready', retryNowMs);
              }
            } else transition(state, node, preparationFailure ? 'blocked' : result?.status === 'failed' ? 'failed' : 'blocked', config.now());
          }
          delete state.launchIntents[node.id].preparationClaim;
          state.launchIntents[node.id].status = 'complete';
          if (result?.status === 'budget-exhausted') {
            state.terminal = 'budget-exhausted';
            if (state.graph.status !== 'blocked') transition(state, state.graph, 'blocked', config.now());
          } else deriveTerminal(state, retryNowMs ?? config.now());
          return state;
        });
      } catch (error) {
        if (error instanceof RuntimeError && error.details.reason === 'version-conflict') continue;
        throw error;
      }
    }
    fail('version-conflict');
  }

  async function claimPreparation(instance, intent, claimId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const lock = await instance.acquire(); let inspected;
      try { inspected = canonicalRuntimeState(await instance.read(), instance.id); } finally { await lock.release(); }
      const observed = inspected.launchIntents[intent.nodeId];
      if (!observed || observed.id !== intent.id || ['prepared', 'started', 'complete'].includes(observed.status)) return null;
      if (observed.status !== 'committed') return null;
      const claimedAtMs = config.now(); iso(claimedAtMs);
      if (observed.preparationClaim) {
        if (observed.preparationClaim.claimedAtMs > claimedAtMs) fail('invalid-runtime-input');
        if (claimedAtMs - observed.preparationClaim.claimedAtMs < launchGraceMs) return null;
      }
      try {
        const state = await runTransaction(instance, inspected.version, current => {
          const stored = current.launchIntents[intent.nodeId];
          if (!stored || stored.id !== intent.id || stored.status !== 'committed') fail('version-conflict');
          stored.preparationClaim = { id: claimId, claimedAtMs }; return current;
        });
        return state.launchIntents[intent.nodeId];
      } catch (error) {
        if (error instanceof RuntimeError && error.details.reason === 'version-conflict') continue;
        throw error;
      }
    }
    return null;
  }

  async function persistPreparedIntent(instance, intent, claimId, worktree) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const lock = await instance.acquire(); let inspected;
      try { inspected = canonicalRuntimeState(await instance.read(), instance.id); } finally { await lock.release(); }
      const observed = inspected.launchIntents[intent.nodeId];
      if (!observed || observed.id !== intent.id || observed.status !== 'committed'
        || observed.preparationClaim?.id !== claimId) return null;
      try {
        const state = await runTransaction(instance, inspected.version, current => {
          const stored = current.launchIntents[intent.nodeId];
          if (!stored || stored.id !== intent.id || stored.status !== 'committed'
            || stored.preparationClaim?.id !== claimId) fail('version-conflict');
          stored.worktree = worktree; delete stored.preparationClaim; stored.status = 'prepared'; return current;
        });
        return state.launchIntents[intent.nodeId];
      } catch (error) {
        if (error instanceof RuntimeError && error.details.reason === 'version-conflict') continue;
        throw error;
      }
    }
    return null;
  }

  async function markIntentStarted(instance, intent) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const lock = await instance.acquire(); let inspected;
      try { inspected = canonicalRuntimeState(await instance.read(), instance.id); } finally { await lock.release(); }
      const observed = inspected.launchIntents[intent.nodeId];
      if (!observed || observed.id !== intent.id || ['started', 'complete'].includes(observed.status)) return null;
      if (!['committed', 'prepared'].includes(observed.status)) return null;
      try {
        const state = await runTransaction(instance, inspected.version, current => {
          const stored = current.launchIntents[intent.nodeId];
          if (!stored || stored.id !== intent.id || !['committed', 'prepared'].includes(stored.status)) fail('version-conflict');
          const node = current.graph.nodes.find(item => item.id === intent.nodeId);
          if (!node || node.status !== 'reserved') fail('version-conflict');
          stored.status = 'started'; stored.startedAtMs = config.now(); transition(current, node, 'running', stored.startedAtMs); return current;
        });
        return state.launchIntents[intent.nodeId];
      } catch (error) {
        if (error instanceof RuntimeError && error.details.reason === 'version-conflict') continue;
        throw error;
      }
    }
    return null;
  }

  async function launch(instance, intent, node, signal) {
    const key = `${instance.id}:${intent.id}`;
    if (inflight.has(key)) return inflight.get(key);
    const controller = new AbortController(); controllers.set(`${instance.id}:${node.id}`, controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const promise = (async () => {
      try {
      let outcome; let phase = 'claim'; let preparationClaimId;
      try {
        let preparedIntent = intent;
        if (config.prepareWorktree && intent.status !== 'prepared') {
          preparationClaimId = `prepare-${randomUUID()}`;
          const claimedIntent = await serializeResult(instance.id, () => claimPreparation(instance, intent, preparationClaimId));
          if (claimedIntent === null) return Object.freeze({ coordinated: true });
          phase = 'prepare';
          const worktree = clone(await config.prepareWorktree(clone(node), clone(claimedIntent)));
          phase = 'prepare-commit';
          preparedIntent = await serializeResult(instance.id, () => persistPreparedIntent(instance, claimedIntent, preparationClaimId, worktree));
        }
        if (preparedIntent === null) return Object.freeze({ coordinated: true });
        phase = 'start';
        const startedIntent = await serializeResult(instance.id, () => markIntentStarted(instance, preparedIntent));
        if (startedIntent === null) return Object.freeze({ coordinated: true });
        phase = 'client';
        const result = captureResult(await config.client.launch(config.launchFor(clone(node), clone(startedIntent)), { signal: controller.signal }));
        if (config.reconcile) {
          phase = 'reconcile';
          const report = clone(await config.reconcile(clone(node), clone(startedIntent), result));
          if (report?.status !== 'integrated') outcome = { result: { version: 1, status: 'blocked', output: { summary: 'Worktree reconciliation requires review.', evidence: [] }, usage: result.usage } };
          else outcome = { result };
        } else outcome = { result };
      }
      catch (error) {
        if (phase === 'claim' || phase === 'prepare-commit') throw error;
        outcome = { error, ...(phase === 'prepare' ? { phase, preparationClaimId } : {}) };
      }
      await serializeResult(instance.id, () => commitResult(instance, intent, outcome));
      return outcome;
      } finally {
        signal?.removeEventListener('abort', abort);
        controllers.delete(`${instance.id}:${node.id}`);
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  async function tickInternal(instance, inputOptions, launchWork) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'maxActiveNodes', 'signal'], ['expectedVersion']);
    const maxActiveNodes = options.maxActiveNodes ?? 4;
    try { if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('invalid-runtime-input'); }
    catch { fail('invalid-runtime-input'); }
    if (!Number.isSafeInteger(maxActiveNodes) || maxActiveNodes < 1 || maxActiveNodes > 64) fail('invalid-runtime-input');
    const processObservations = new Map();
    const inspectLock = await instance.acquire(); let inspected;
    try { inspected = canonicalRuntimeState(await instance.read(), instance.id); } finally { await inspectLock.release(); }
    const observedNow = config.now();
    if (!Number.isSafeInteger(observedNow) || observedNow < 0
      || Object.values(inspected.launchIntents).some(intent => intent.status === 'started' && intent.startedAtMs > observedNow)) fail('invalid-runtime-input');
    for (const [nodeId, intent] of Object.entries(inspected.launchIntents)) {
      if (intent.status !== 'started' || inspected.heartbeats[nodeId] || !Number.isSafeInteger(intent.startedAtMs)
        || observedNow - intent.startedAtMs < launchGraceMs) continue;
      const key = `${instance.id}:${intent.id}`;
      let status = inflight.has(key) ? 'running' : 'absent';
      if (status === 'absent' && config.processStatus) status = await observeProcess(Object.freeze({ instanceId: instance.id, nodeId, intentId: intent.id, reservationId: intent.reservationId }));
      if (!['running', 'absent'].includes(status)) fail('invalid-runtime-input');
      processObservations.set(nodeId, status);
    }
    const abortNodeIds = new Set();
    const committed = await runTransaction(instance, options.expectedVersion, state => {
      if (TERMINAL.has(state.terminal)) return null;
      if (state.activated !== true) fail('not-activated');
      if (!Array.isArray(state.graph?.nodes) || state.graph.nodes.length > 1000 || !Array.isArray(state.events) || !state.launchIntents || !state.attempts || !Array.isArray(state.evidence)) fail('invalid-runtime-input');
      for (const node of state.graph.nodes) {
        const intent = state.launchIntents[node.id]; const heartbeat = state.heartbeats?.[node.id];
        if (!['reserved', 'running'].includes(node.status) || !['committed', 'prepared', 'started'].includes(intent?.status) || !heartbeat) continue;
        const liveness = heartbeatStatus(heartbeat, { nowMs: config.now(), expected: { instanceId: instance.id, nodeId: node.id, actorId: node.owner.id, leaseId: intent.reservationId } });
        if (liveness.status === 'stalled') { transition(state, node, 'blocked', config.now()); delete intent.preparationClaim; intent.status = 'complete'; abortNodeIds.add(node.id); }
      }
      for (const [nodeId, status] of processObservations) {
        const node = state.graph.nodes.find(item => item.id === nodeId); const intent = state.launchIntents[nodeId];
        if (node?.status === 'running' && intent?.status === 'started' && !state.heartbeats[nodeId]) {
          transition(state, node, 'blocked', config.now()); intent.status = 'complete'; abortNodeIds.add(nodeId);
        }
      }
      for (const node of state.graph.nodes) {
        const intent = state.launchIntents[node.id];
        const retryAtMs = state.retryAtMs?.[node.id] ?? intent?.retryAtMs;
        if (node.status === 'corrective' && Number.isSafeInteger(retryAtMs) && retryAtMs <= config.now()) { transition(state, node, 'ready', config.now()); if (state.retryAtMs) delete state.retryAtMs[node.id]; }
      }
      deriveTerminal(state, config.now());
      if (TERMINAL.has(state.terminal)) return state;
      const recoverable = state.graph.nodes.filter(node => node.status === 'reserved' && ['committed', 'prepared'].includes(state.launchIntents[node.id]?.status));
      const scheduledIds = scheduleReadyNodes(state.graph, { maxActiveNodes }).filter(id => {
        const node = state.graph.nodes.find(item => item.id === id); const intent = state.launchIntents[id];
        const retryAtMs = state.retryAtMs?.[id] ?? intent?.retryAtMs;
        return !node.approvalGate && (!Number.isSafeInteger(retryAtMs) || retryAtMs <= config.now());
      });
      const available = availableBudget(state);
      const launchableIds = [];
      const allocations = new Map();
      const parentAvailability = new Map();
      for (const parent of state.graph.nodes) {
        const availableForChildren = remainingParentBudget(state, parent);
        if (availableForChildren.tokenLimit < 0 || availableForChildren.timeMinutes < 0 || availableForChildren.taskLimit < 0) fail('invalid-runtime-input');
        for (const intent of Object.values(state.launchIntents)) {
          if (!['committed', 'prepared', 'started'].includes(intent.status) || !intent.allocation) continue;
          const active = state.graph.nodes.find(item => item.id === intent.nodeId);
          if (active && ancestorNodes(state, active).some(item => item.id === parent.id)) reserveBudget(availableForChildren, intent.allocation);
        }
        parentAvailability.set(parent.id, availableForChildren);
      }
      for (const id of scheduledIds) {
        const candidate = state.graph.nodes.find(node => node.id === id);
        const allocation = remainingNodeBudget(state, candidate);
        const parents = ancestorNodes(state, candidate);
        if (allocation.tokenLimit < 1 || allocation.timeMinutes < 1 || allocation.taskLimit < 1 || !budgetFits(allocation, available)
          || parents.some(parent => !budgetFits(allocation, parentAvailability.get(parent.id)))) continue;
        launchableIds.push(id);
        allocations.set(id, allocation);
        reserveBudget(available, allocation);
        for (const parent of parents) reserveBudget(parentAvailability.get(parent.id), allocation);
      }
      if (scheduledIds.length > 0 && launchableIds.length === 0 && recoverable.length === 0) {
        state.terminal = 'budget-exhausted';
        if (state.graph.status !== 'blocked') transition(state, state.graph, 'blocked', config.now());
        return state;
      }
      for (const nodeId of launchableIds) {
        const node = state.graph.nodes.find(item => item.id === nodeId);
        const sequence = state.events.length + 1;
        const generated = config.reservationId ? config.reservationId(node.id, sequence) : randomUUID();
        const reservationId = safeId(generated) ? generated : generated.replaceAll('-', '').slice(0, 63).replace(/^[^a-z]+/, 'lease-');
        if (!safeId(reservationId)) fail('invalid-runtime-input');
        state.attempts[node.id] ??= 1;
        transition(state, node, 'reserved', config.now());
        state.launchIntents[node.id] = { id: launchIntentId(node.id, state.attempts[node.id]), nodeId: node.id, reservationId, attempt: state.attempts[node.id], idempotencyKey: `${instance.id}:${node.id}:${state.attempts[node.id]}`, allocation: allocations.get(node.id), status: 'committed', eventSequence: state.events.length };
      }
      return state;
    });
    for (const nodeId of abortNodeIds) controllers.get(`${instance.id}:${nodeId}`)?.abort();
    const launches = committed.graph.nodes
      .filter(node => node.status === 'reserved' && ['committed', 'prepared'].includes(committed.launchIntents[node.id]?.status))
      .sort((left, right) => committed.launchIntents[left.id].eventSequence - committed.launchIntents[right.id].eventSequence)
      .slice(0, maxActiveNodes);
    if (launchWork) await Promise.all(launches.map(node => launch(instance, committed.launchIntents[node.id], node, options.signal)));
    const lock = await instance.acquire();
    let final;
    try { final = clone(await instance.read()); } finally { await lock.release(); }
    return Object.freeze({ version: final.version, terminal: final.terminal, launched: Object.freeze(launches.map(node => node.id).sort()) });
  }

  async function tick(instance, inputOptions) {
    return tickInternal(instance, inputOptions, true);
  }

  async function prepareAction(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion'], ['expectedVersion']);
    const inspect = async () => {
      const lock = await instance.acquire();
      try { return canonicalRuntimeState(await instance.read(), instance.id); }
      finally { await lock.release(); }
    };
    let state = await inspect();
    if (state.version !== exactVersion(options.expectedVersion)) fail('version-conflict');
    let active = state.graph.nodes.find(node => node.status === 'running'
      && state.launchIntents[node.id]?.status === 'started');
    if (!active) {
      await tickInternal(instance, { expectedVersion: state.version, maxActiveNodes: 1 }, false);
      state = await inspect();
      active = state.graph.nodes.find(node => node.status === 'reserved'
        && ['committed', 'prepared'].includes(state.launchIntents[node.id]?.status));
      if (!active) return Object.freeze({ version: state.version, action: null });
      let intent = state.launchIntents[active.id];
      if (config.prepareWorktree && intent.status !== 'prepared') {
        const claimId = `prepare-${randomUUID()}`;
        const claimed = await serializeResult(instance.id, () => claimPreparation(instance, intent, claimId));
        if (claimed === null) fail('version-conflict');
        const worktree = clone(await config.prepareWorktree(clone(active), clone(claimed)));
        intent = await serializeResult(instance.id, () => persistPreparedIntent(instance, claimed, claimId, worktree));
        if (intent === null) fail('version-conflict');
      }
      const started = await serializeResult(instance.id, () => markIntentStarted(instance, intent));
      if (started === null) fail('version-conflict');
      state = await inspect();
      active = state.graph.nodes.find(node => node.id === started.nodeId);
    }
    const intent = state.launchIntents[active.id];
    return Object.freeze({
      version: state.version,
      action: Object.freeze({
        node: clone(active),
        intent: clone(intent),
        launch: clone(config.launchFor(clone(active), clone(intent))),
      }),
    });
  }

  async function submitAction(instance, inputOptions) {
    const options = captureOptions(inputOptions, [
      'expectedVersion', 'nodeId', 'intentId', 'idempotencyKey', 'reservationId', 'result',
    ], ['expectedVersion', 'nodeId', 'intentId', 'idempotencyKey', 'reservationId', 'result']);
    const result = captureResult(options.result);
    const lock = await instance.acquire();
    let state;
    try { state = canonicalRuntimeState(await instance.read(), instance.id); }
    finally { await lock.release(); }
    if (state.version !== exactVersion(options.expectedVersion)) fail('version-conflict');
    const node = state.graph.nodes.find(item => item.id === options.nodeId);
    const intent = state.launchIntents[options.nodeId];
    if (!node || node.status !== 'running' || intent?.status !== 'started'
      || intent.id !== options.intentId || intent.idempotencyKey !== options.idempotencyKey
      || intent.reservationId !== options.reservationId
      || intent.worktree?.reservationId !== options.reservationId) fail('version-conflict');
    let report = null;
    let outcome = { result };
    if (config.reconcile) {
      report = clone(await config.reconcile(clone(node), clone(intent), result));
      if (report?.status !== 'integrated') {
        outcome = {
          result: {
            version: 1,
            status: 'blocked',
            output: { summary: 'Worktree reconciliation requires review.', evidence: [] },
            usage: result.usage,
          },
        };
      }
    }
    const committed = await serializeResult(instance.id, () => commitResult(instance, intent, outcome));
    const settled = committed.graph.nodes.find(item => item.id === node.id);
    return Object.freeze({
      version: committed.version,
      nodeId: node.id,
      nodeStatus: settled.status,
      terminal: committed.terminal,
      report,
    });
  }

  async function cancelGoal(instance, inputOptions) {
    const state = await recoverCancelGoal(instance, inputOptions);
    for (const [key, controller] of controllers) if (key.startsWith(`${instance.id}:`)) controller.abort();
    return state;
  }

  async function cancelNode(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'nodeId', 'authority', 'nowMs'], ['expectedVersion', 'nodeId', 'authority']);
    const state = await recoverCancelNode(instance, options);
    for (const node of state.graph.nodes) if (node.status === 'cancelled') controllers.get(`${instance.id}:${node.id}`)?.abort();
    return state;
  }

  async function recoverStalledNode(instance, inputOptions) {
    const options = captureOptions(inputOptions, ['expectedVersion', 'nodeId', 'authority', 'nowMs', 'reason'], ['expectedVersion', 'nodeId', 'authority', 'nowMs', 'reason']);
    const state = await recoverStalled(instance, options);
    controllers.get(`${instance.id}:${options.nodeId}`)?.abort();
    return state;
  }

  async function retryNode(instance, inputOptions) { return recoverRetryNode(instance, inputOptions, { retryPolicy }); }

  const runtime = Object.freeze({ activate, approveNode, recordHeartbeat, tick, prepareAction, submitAction, retryNode, recoverStalledNode, cancelNode, cancelGoal });
  return runtime;
}
