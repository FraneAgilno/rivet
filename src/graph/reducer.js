import { validateEvent } from '../config/validate.js';
import { graphFailure, sanitizeGraphOperation, validatedGraphSnapshot } from './validate.js';

const EVENT_KEYS = new Set([
  'schemaVersion', 'eventId', 'graphId', 'nodeId', 'sequence', 'timestamp', 'actor', 'type',
  'priorState', 'newState', 'retryReason', 'authorityDelta', 'budgetDelta', 'evidenceRefs',
  'instanceId', 'leaseId', 'heartbeatSequence', 'heartbeatIntervalMs', 'approvalReceiptId',
]);
const ACTOR_KEYS = new Set(['role', 'id']);
const AUTHORITY_DELTA_KEYS = new Set(['added', 'removed']);
const BUDGET_DELTA_KEYS = new Set(['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']);

const TRANSITIONS = Object.freeze({
  proposed: new Set(['approved', 'blocked', 'cancelled']),
  approved: new Set(['ready', 'blocked', 'cancelled']),
  ready: new Set(['reserved', 'blocked', 'cancelled']),
  reserved: new Set(['ready', 'running', 'blocked', 'cancelled']),
  running: new Set(['verifying', 'corrective', 'blocked', 'failed', 'cancelled']),
  verifying: new Set(['completed', 'corrective', 'blocked', 'failed', 'cancelled']),
  corrective: new Set(['ready', 'reserved', 'running', 'verifying', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['ready', 'corrective', 'failed', 'cancelled']),
  failed: new Set(['corrective', 'archived']),
  completed: new Set(['archived']),
  archived: new Set(),
  cancelled: new Set(['archived']),
});

function transitionAllowedUnsafe(priorState, newState) {
  return TRANSITIONS[priorState]?.has(newState) ?? false;
}

export function transitionAllowed(priorState, newState) {
  return sanitizeGraphOperation(
    () => transitionAllowedUnsafe(priorState, newState),
    'invalid-transition-arguments',
  );
}

function checkedEvent(event) {
  validateEvent(event);
}

function capturedObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) graphFailure('invalid-event');
  const keys = Object.keys(value);
  if (keys.length > allowedKeys.size || keys.some(key => !allowedKeys.has(key))) graphFailure('invalid-event');
  const captured = {};
  for (const key of keys) captured[key] = value[key];
  return captured;
}

function capturedArray(value, maximum) {
  if (!Array.isArray(value)) graphFailure('invalid-event');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maximum) graphFailure('invalid-event');
  const captured = [];
  for (let index = 0; index < length; index += 1) captured.push(value[index]);
  return captured;
}

function capturedEvent(event) {
  const captured = capturedObject(event, EVENT_KEYS);
  if ('actor' in captured) captured.actor = capturedObject(captured.actor, ACTOR_KEYS);
  if ('authorityDelta' in captured) {
    captured.authorityDelta = capturedObject(captured.authorityDelta, AUTHORITY_DELTA_KEYS);
    if ('added' in captured.authorityDelta) captured.authorityDelta.added = capturedArray(captured.authorityDelta.added, 32);
    if ('removed' in captured.authorityDelta) captured.authorityDelta.removed = capturedArray(captured.authorityDelta.removed, 32);
  }
  if ('budgetDelta' in captured) captured.budgetDelta = capturedObject(captured.budgetDelta, BUDGET_DELTA_KEYS);
  if ('evidenceRefs' in captured) captured.evidenceRefs = capturedArray(captured.evidenceRefs, 64);
  return captured;
}

function targetFor(graph, event) {
  if (!event.nodeId) return graph;
  const node = graph.nodes.find(candidate => candidate.id === event.nodeId);
  if (!node) graphFailure('unknown-node');
  return node;
}

function appendEvidence(target, evidenceRefs) {
  if (!Array.isArray(target.evidenceRefs)) graphFailure('graph-evidence-target');
  const known = new Set(target.evidenceRefs);
  if (evidenceRefs.some(reference => known.has(reference))) graphFailure('duplicate-evidence');
  target.evidenceRefs.push(...evidenceRefs);
}

function exactReferences(left, right) {
  if (left.length !== right.length) return false;
  const actual = [...left].sort(); const expected = [...right].sort();
  return actual.every((value, index) => value === expected[index]);
}

function reduceGraphUnsafe(graph, event) {
  const stableGraph = validatedGraphSnapshot(graph);
  const stableEvent = capturedEvent(event);
  checkedEvent(stableEvent);
  if (stableEvent.graphId !== stableGraph.id) graphFailure('graph-event-mismatch');

  const next = stableGraph;
  const target = targetFor(next, stableEvent);
  if (stableEvent.type === 'state-transition') {
    if (target.status !== stableEvent.priorState) graphFailure('stale-transition');
    if (!transitionAllowedUnsafe(stableEvent.priorState, stableEvent.newState)) graphFailure('invalid-transition');
    target.status = stableEvent.newState;
  } else if (stableEvent.type === 'cancelled') {
    if (!transitionAllowedUnsafe(target.status, 'cancelled')) graphFailure('invalid-transition');
    target.status = 'cancelled';
  } else if (stableEvent.type === 'evidence-recorded') {
    appendEvidence(target, stableEvent.evidenceRefs);
  } else if (stableEvent.type === 'approval-recorded' && stableEvent.nodeId) {
    if (target.owner.role !== 'boss' || !target.approvalGate
      || !exactReferences(stableEvent.evidenceRefs, target.evidenceRefs)) graphFailure('invalid-approval-fact');
  }

  return validatedGraphSnapshot(next);
}

export function reduceGraph(graph, event) {
  return sanitizeGraphOperation(
    () => reduceGraphUnsafe(graph, event),
    'invalid-event',
  );
}
