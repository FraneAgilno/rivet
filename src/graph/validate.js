import { validateGoalGraph } from '../config/validate.js';

const GRAPH_KEYS = new Set(['schemaVersion', 'id', 'goal', 'providerRefs', 'maxDelegationDepth', 'status', 'nodes']);
const NODE_KEYS = new Set([
  'id', 'parentId', 'objective', 'owner', 'dependencies', 'authorityScopes', 'budget',
  'completionProfile', 'requiredEvidenceTypes', 'evidenceRefs', 'status', 'approvalGate',
]);
const OWNER_KEYS = new Set(['role', 'id']);
const BUDGET_KEYS = new Set(['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']);

export class GraphValidationError extends Error {
  constructor(reason = 'invalid-graph') {
    super('Goal graph operation is invalid.');
    this.name = 'GraphValidationError';
    this.code = 'ERR_INVALID_GOAL_GRAPH';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
    Object.freeze(this);
  }
}

export function graphFailure(reason) {
  throw new GraphValidationError(reason);
}

export function sanitizeGraphOperation(operation, reason) {
  try {
    return operation();
  } catch {
    throw new GraphValidationError(reason);
  }
}

function capturedObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) graphFailure('invalid-graph');
  const keys = Object.keys(value);
  if (keys.length > allowedKeys.size || keys.some(key => !allowedKeys.has(key))) graphFailure('invalid-graph');
  const captured = {};
  for (const key of keys) captured[key] = value[key];
  return captured;
}

function capturedArray(value, maximum, transform = item => item) {
  if (!Array.isArray(value)) graphFailure('invalid-graph');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maximum) graphFailure('invalid-graph');
  const captured = [];
  for (let index = 0; index < length; index += 1) captured.push(transform(value[index], index));
  return captured;
}

function capturedOwner(value) {
  return capturedObject(value, OWNER_KEYS);
}

function capturedBudget(value) {
  return capturedObject(value, BUDGET_KEYS);
}

function capturedNode(value) {
  const node = capturedObject(value, NODE_KEYS);
  if ('owner' in node) node.owner = capturedOwner(node.owner);
  if ('dependencies' in node) node.dependencies = capturedArray(node.dependencies, 100);
  if ('authorityScopes' in node) node.authorityScopes = capturedArray(node.authorityScopes, 32);
  if ('budget' in node) node.budget = capturedBudget(node.budget);
  if ('requiredEvidenceTypes' in node) node.requiredEvidenceTypes = capturedArray(node.requiredEvidenceTypes, 8);
  if ('evidenceRefs' in node) node.evidenceRefs = capturedArray(node.evidenceRefs, 64);
  return node;
}

function capturedGraph(graph) {
  const captured = capturedObject(graph, GRAPH_KEYS);
  if ('providerRefs' in captured) captured.providerRefs = capturedArray(captured.providerRefs, 64);
  if ('nodes' in captured) captured.nodes = capturedArray(captured.nodes, 1000, capturedNode);
  return captured;
}

function validatedGraphSnapshotUnsafe(graph, config) {
  const snapshot = capturedGraph(graph);
  validateGoalGraph(snapshot, config);

  const rolesByOwner = new Map();
  for (const node of snapshot.nodes) {
    const priorRole = rolesByOwner.get(node.owner.id);
    if (priorRole && priorRole !== node.owner.role) graphFailure('owner-role-conflict');
    rolesByOwner.set(node.owner.id, node.owner.role);
  }
  return snapshot;
}

export function validatedGraphSnapshot(graph, config) {
  return sanitizeGraphOperation(
    () => validatedGraphSnapshotUnsafe(graph, config),
    'invalid-graph',
  );
}

export function validateExecutionGraph(graph, config) {
  return sanitizeGraphOperation(
    () => {
      validatedGraphSnapshotUnsafe(graph, config);
      return true;
    },
    'invalid-graph',
  );
}
