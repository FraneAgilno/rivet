import { evaluateAuthority } from '../policy/authority.js';
import { claimApproval } from '../policy/approvals.js';
import { EVIDENCE_TYPES } from '../config/defaults.js';
import { validatedGraphSnapshot } from '../graph/validate.js';
import { RuntimeError, appendRuntimeEvent, remainingRuntimeNodeBudget, runtimeTransaction, transitionRuntimeState } from './orchestrator.js';
import { heartbeatStatus } from './heartbeat.js';
import { retryDecision, retryPolicySchedule } from './retry.js';

function fail(reason) { throw new RuntimeError(reason); }
function version(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('invalid-runtime-input'); return value; }
function safeId(value) { return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64; }

function capture(input, allowed, required = allowed) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-runtime-input');
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('invalid-runtime-input');
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) fail('invalid-runtime-input');
      result[key] = input[key];
    }
    if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-runtime-input');
    return result;
  } catch (error) { if (error instanceof RuntimeError) throw error; fail('invalid-runtime-input'); }
}
function now(value) { const result = value ?? 0; if (!Number.isSafeInteger(result) || result < 0) fail('invalid-runtime-input'); return result; }
function reason(value) { if (typeof value !== 'string' || value.length < 1 || value.length > 1000 || /[\u0000\r\n]/.test(value)) fail('invalid-runtime-input'); return value; }
function structuralNode(state, nodeId, authority, action) {
  if (!safeId(nodeId)) fail('invalid-runtime-input');
  const node = state.graph.nodes.find(item => item.id === nodeId); const parent = state.graph.nodes.find(item => item.id === node?.parentId);
  if (!node || !parent || authority?.actorId !== parent.owner.id) fail('approval-required');
  const decision = evaluateAuthority(authority, { actorId: authority.actorId, action, resource: node.id });
  if (decision.decision !== 'allow') fail('approval-required');
  return node;
}
function retryBound(state, node) {
  const attempts = state.attempts[node.id] ?? 1; const maximum = Math.min((state.limits?.retries ?? 2) + 1, 10);
  if (attempts >= maximum || (state.usage?.retries ?? 0) >= (state.limits?.retries ?? 2)) fail('invalid-runtime-input');
  state.attempts[node.id] = attempts + 1; state.usage ??= { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0, taskLimit: 0 }; state.usage.retries += 1;
}
function reopenGraph(state, nowMs, actorId) {
  if (!['blocked', 'failed'].includes(state.terminal)) return;
  if (['blocked', 'failed'].includes(state.graph.status)) transitionRuntimeState(state, state.graph, 'corrective', nowMs, { role: 'manager', id: actorId });
  if (state.graph.status === 'corrective') transitionRuntimeState(state, state.graph, 'running', nowMs, { role: 'manager', id: actorId });
  state.terminal = null;
}

export async function retryNode(instance, input, runtimeOptions = null) {
  const value = capture(input, ['expectedVersion', 'nodeId', 'authority', 'reason', 'nowMs'], ['expectedVersion', 'nodeId', 'authority', 'reason']);
  const retryReason = reason(value.reason); const nowMs = now(value.nowMs);
  return runtimeTransaction(instance, value.expectedVersion, state => {
    const node = structuralNode(state, value.nodeId, value.authority, 'orchestration.retry');
    if (!['blocked', 'failed', 'corrective'].includes(node.status)) fail('invalid-runtime-input');
    let delayMs = 0;
    if (runtimeOptions?.retryPolicy) {
      const decision = retryDecision(runtimeOptions.retryPolicy, { attempt: state.attempts[node.id] ?? 1, classification: 'provider-transient' });
      if (!decision.retry || (state.usage?.retries ?? 0) >= (state.limits?.retries ?? 0)) fail('invalid-runtime-input');
      state.attempts[node.id] = decision.nextAttempt; state.usage.retries += 1; delayMs = decision.delayMs;
    } else retryBound(state, node);
    delete state.heartbeats[node.id]; delete state.lastHeartbeatAt[node.id];
    if (['failed', 'blocked'].includes(node.status)) transitionRuntimeState(state, node, 'corrective', nowMs, node.owner);
    if (delayMs === 0) transitionRuntimeState(state, node, 'ready', nowMs, node.owner);
    else { state.retryAtMs ??= {}; state.retryAtMs[node.id] = nowMs + delayMs; }
    appendRuntimeEvent(state, nowMs, { actor: { role: 'manager', id: value.authority.actorId }, event: { type: 'retry', nodeId: node.id, retryReason } });
    reopenGraph(state, nowMs, value.authority.actorId);
    return state;
  }, runtimeOptions?.retryPolicy ? retryPolicySchedule(runtimeOptions.retryPolicy) : null);
}

export async function cancelNode(instance, input) {
  const value = capture(input, ['expectedVersion', 'nodeId', 'authority', 'nowMs'], ['expectedVersion', 'nodeId', 'authority']); const nowMs = now(value.nowMs);
  return runtimeTransaction(instance, value.expectedVersion, state => {
    const node = structuralNode(state, value.nodeId, value.authority, 'orchestration.cancel');
    if (node.status === 'cancelled') return null;
    if (['completed', 'archived'].includes(node.status)) fail('invalid-runtime-input');
    const cancelled = new Set([node.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const candidate of state.graph.nodes) if (!cancelled.has(candidate.id) && candidate.dependencies.some(id => cancelled.has(id))) { cancelled.add(candidate.id); changed = true; }
    }
    for (const candidate of state.graph.nodes) if (cancelled.has(candidate.id) && !['completed', 'archived', 'cancelled'].includes(candidate.status)) {
      transitionRuntimeState(state, candidate, 'cancelled', nowMs, candidate.owner);
      const intent = state.launchIntents[candidate.id];
      if (intent && ['committed', 'prepared', 'started'].includes(intent.status)) { delete intent.preparationClaim; intent.status = 'complete'; }
      if (intent) delete intent.retryAtMs;
      if (state.retryAtMs) delete state.retryAtMs[candidate.id];
    }
    if (state.graph.status !== 'cancelled') transitionRuntimeState(state, state.graph, 'cancelled', nowMs, node.owner);
    state.terminal = 'cancelled'; return state;
  });
}

export async function cancelGoal(instance, input) {
  const value = capture(input, ['expectedVersion', 'authority', 'nowMs'], ['expectedVersion', 'authority']); const nowMs = now(value.nowMs);
  return runtimeTransaction(instance, value.expectedVersion, state => {
    const decision = evaluateAuthority(value.authority, { actorId: value.authority?.actorId, action: 'orchestration.cancel', resource: instance.id });
    if (value.authority?.principal !== 'human' || decision.decision !== 'allow') fail('approval-required');
    if (state.terminal === 'cancelled') return null;
    if (state.terminal === 'completed') fail('invalid-runtime-input');
    for (const node of state.graph.nodes) if (!['completed', 'cancelled', 'archived'].includes(node.status)) {
      transitionRuntimeState(state, node, 'cancelled', nowMs, { role: 'human', id: value.authority.actorId });
      const intent = state.launchIntents[node.id];
      if (intent && ['committed', 'prepared', 'started'].includes(intent.status)) { delete intent.preparationClaim; intent.status = 'complete'; }
      if (intent) delete intent.retryAtMs;
      if (state.retryAtMs) delete state.retryAtMs[node.id];
    }
    if (state.graph.status !== 'cancelled') transitionRuntimeState(state, state.graph, 'cancelled', nowMs, { role: 'human', id: value.authority.actorId });
    state.terminal = 'cancelled'; return state;
  });
}

export async function createCorrectiveNode(instance, input) {
  const captured = capture(input, ['expectedVersion', 'sourceNodeId', 'nodeId', 'ownerId', 'authority', 'reason', 'evidenceRefs', 'evidenceTypes', 'nowMs'], ['expectedVersion', 'sourceNodeId', 'nodeId', 'ownerId', 'authority', 'reason', 'evidenceRefs']);
  const evidenceRefs = Array.isArray(captured.evidenceRefs) ? [...captured.evidenceRefs] : captured.evidenceRefs; const retryReason = reason(captured.reason); const nowMs = now(captured.nowMs);
  if (![captured.sourceNodeId, captured.nodeId, captured.ownerId].every(safeId) || !Array.isArray(evidenceRefs) || evidenceRefs.length < 1 || evidenceRefs.length > 8 || evidenceRefs.some(item => !safeId(item)) || new Set(evidenceRefs).size !== evidenceRefs.length) fail('invalid-runtime-input');
  return runtimeTransaction(instance, captured.expectedVersion, state => {
    if (state.graph.nodes.some(node => node.id === captured.nodeId) || state.graph.nodes.length >= 1000) fail('invalid-runtime-input');
    const source = structuralNode(state, captured.sourceNodeId, captured.authority, 'orchestration.correct');
    if (!['failed', 'blocked', 'corrective'].includes(source.status)) fail('invalid-runtime-input');
    retryBound(state, source);
    const evidenceTypes = captured.evidenceTypes === undefined ? [...source.requiredEvidenceTypes] : Array.isArray(captured.evidenceTypes) ? [...captured.evidenceTypes] : captured.evidenceTypes;
    if (!Array.isArray(evidenceTypes) || evidenceTypes.length !== evidenceRefs.length || evidenceTypes.length > 8
      || evidenceTypes.some(item => !EVIDENCE_TYPES.includes(item)) || new Set(evidenceTypes).size !== evidenceTypes.length) fail('invalid-runtime-input');
    evidenceTypes.sort(); evidenceRefs.sort();
    const inheritedEvidenceTypes = [...source.requiredEvidenceTypes].sort();
    if (evidenceTypes.length !== inheritedEvidenceTypes.length
      || evidenceTypes.some((item, index) => item !== inheritedEvidenceTypes[index])) fail('invalid-runtime-input');
    const remaining = remainingRuntimeNodeBudget(state, source);
    if (remaining.timeMinutes < 1 || remaining.tokenLimit < 1 || remaining.taskLimit < 1) fail('invalid-runtime-input');
    const correctiveCost = Number(remaining.costUsd);
    if (!Number.isFinite(correctiveCost) || correctiveCost <= 0) fail('invalid-runtime-input');
    const corrective = { id: captured.nodeId, parentId: source.parentId, objective: `Correct ${source.id}: ${retryReason}`.slice(0, 2000), owner: { role: 'worker', id: captured.ownerId }, dependencies: [...source.dependencies], authorityScopes: [...source.authorityScopes], budget: { ...remaining, costUsd: correctiveCost }, completionProfile: source.completionProfile, requiredEvidenceTypes: evidenceTypes, evidenceRefs: [...evidenceRefs], status: 'corrective' };
    if (source.status === 'blocked') transitionRuntimeState(state, source, 'failed', nowMs, source.owner);
    if (state.graph.nodes.find(node => node.id === source.id).status === 'corrective') transitionRuntimeState(state, source, 'failed', nowMs, source.owner);
    transitionRuntimeState(state, source, 'archived', nowMs, source.owner);
    const nodes = state.graph.nodes.map(node => ({ ...node, dependencies: node.dependencies.map(id => id === source.id ? corrective.id : id) }));
    state.graph = validatedGraphSnapshot({ ...state.graph, nodes: [...nodes, corrective] });
    appendRuntimeEvent(state, nowMs, { actor: { role: 'manager', id: captured.authority.actorId }, event: { type: 'retry', nodeId: source.id, retryReason: `corrective:${retryReason}` } });
    reopenGraph(state, nowMs, captured.authority.actorId);
    return state;
  });
}

export async function recoverStalledNode(instance, input) {
  const value = capture(input, ['expectedVersion', 'nodeId', 'authority', 'nowMs', 'reason']); const nowMs = now(value.nowMs); const retryReason = reason(value.reason);
  return runtimeTransaction(instance, value.expectedVersion, state => {
    const node = structuralNode(state, value.nodeId, value.authority, 'orchestration.recover');
    const intent = state.launchIntents[node.id]; const heartbeat = state.heartbeats[node.id];
    if (!['reserved', 'running'].includes(node.status) || !intent || !['committed', 'prepared', 'started'].includes(intent.status) || !heartbeat) fail('invalid-runtime-input');
    const liveness = heartbeatStatus(heartbeat, { nowMs, expected: { instanceId: instance.id, nodeId: node.id, actorId: node.owner.id, leaseId: intent.reservationId } });
    if (liveness.status !== 'stalled') fail('invalid-runtime-input');
    retryBound(state, node);
    if (node.status === 'running') {
      transitionRuntimeState(state, node, 'corrective', nowMs, node.owner);
      transitionRuntimeState(state, node, 'ready', nowMs, node.owner);
    } else transitionRuntimeState(state, node, 'ready', nowMs, node.owner);
    delete state.heartbeats[node.id]; delete state.lastHeartbeatAt[node.id];
    delete intent.preparationClaim; intent.status = 'recovered'; appendRuntimeEvent(state, nowMs, { actor: { role: 'manager', id: value.authority.actorId }, event: { type: 'retry', nodeId: node.id, retryReason } }); return state;
  });
}

export async function recoverRuntimeLock(target, input) {
  const value = capture(input, ['expectedVersion', 'nowMs', 'authority', 'approval', 'approvalRegistry', 'expectedApproverId']);
  if (!target || !safeId(target.id) || typeof target.version !== 'function' || typeof target.inspectLock !== 'function' || typeof target.recoverLock !== 'function') fail('invalid-runtime-input');
  const expectedVersion = version(value.expectedVersion); const nowMs = now(value.nowMs);
  if (await target.version() !== expectedVersion) fail('version-conflict');
  const lock = capture(await target.inspectLock(), ['ownerId', 'acquiredAtMs', 'expiresAtMs', 'ownerAlive']);
  if (!safeId(lock.ownerId) || !Number.isSafeInteger(lock.acquiredAtMs) || !Number.isSafeInteger(lock.expiresAtMs) || lock.acquiredAtMs < 0 || lock.expiresAtMs <= lock.acquiredAtMs || nowMs < lock.expiresAtMs || lock.ownerAlive !== false) fail('invalid-runtime-input');
  const decision = evaluateAuthority(value.authority, { actorId: value.authority?.actorId, action: 'orchestration.recover', resource: target.id });
  if (decision.decision !== 'allow') fail('approval-required');
  const claim = claimApproval(value.approval, { subjectId: value.authority.actorId, action: 'orchestration.recover', resource: target.id, policyId: 'runtime.stale-lock-recovery' }, { registry: value.approvalRegistry, expectedApproverId: value.expectedApproverId, requireHumanApprover: true, requireSingleUse: true, nowMs });
  if (!claim.valid) fail('approval-required');
  try {
    if (!claim.finalize()) fail('approval-required');
    await target.recoverLock(Object.freeze({ expectedVersion, expectedOwnerId: lock.ownerId, expectedExpiresAtMs: lock.expiresAtMs, nowMs, requireOwnerDead: true }));
    if (!claim.publish()) fail('approval-required');
    return Object.freeze({ recovered: true, expectedVersion });
  } catch (error) {
    try {
      const observedLock = capture(await target.inspectLock(), ['ownerId', 'acquiredAtMs', 'expiresAtMs', 'ownerAlive']);
      const unchanged = observedLock.ownerId === lock.ownerId && observedLock.acquiredAtMs === lock.acquiredAtMs
        && observedLock.expiresAtMs === lock.expiresAtMs && observedLock.ownerAlive === lock.ownerAlive;
      if (unchanged) { if (!claim.rollback()) claim.release(); }
      else claim.publish();
    } catch { /* Ambiguous recovery remains finalized and unusable. */ }
    throw error;
  }
}
