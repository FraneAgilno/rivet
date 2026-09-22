import { graphFailure, sanitizeGraphOperation, validatedGraphSnapshot } from './validate.js';

const CANDIDATE_STATES = new Set(['ready', 'corrective']);
const ACTIVE_STATES = new Set(['reserved', 'running', 'verifying']);
const BUDGET_KEYS = ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit'];
const OPTION_KEYS = new Set([
  'maxActiveNodes',
  'maxDelegationDepth',
  'priorities',
  'capacityByOwner',
  'childCapacityByParent',
  'budget',
]);

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegativeSafeInteger(value, reason) {
  if (!Number.isSafeInteger(value) || value < 0) graphFailure(reason);
  return value;
}

function decimalFromNumber(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) graphFailure('invalid-budget');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function decimalCoefficientAt(value, scale) {
  return value.coefficient * (10n ** BigInt(scale - value.scale));
}

function compareDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = decimalCoefficientAt(left, scale);
  const rightCoefficient = decimalCoefficientAt(right, scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function subtractDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale);
  let coefficient = decimalCoefficientAt(left, scale) - decimalCoefficientAt(right, scale);
  if (coefficient < 0n) graphFailure('budget-underflow');
  let normalizedScale = scale;
  while (normalizedScale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    normalizedScale -= 1;
  }
  return { coefficient, scale: normalizedScale };
}

function capturedObject(value, allowedKeys, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) graphFailure(reason);
  const keys = Object.keys(value);
  if (keys.some(key => !allowedKeys.has(key))) graphFailure(reason);
  const captured = {};
  for (const key of keys) captured[key] = value[key];
  return captured;
}

function validateOptions(rawOptions, graph) {
  const options = capturedObject(rawOptions, OPTION_KEYS, 'invalid-scheduler-options');
  if (!options || typeof options !== 'object' || Array.isArray(options)) graphFailure('invalid-scheduler-options');
  const maxActiveNodes = options.maxActiveNodes === undefined
    ? graph.nodes.length
    : nonNegativeSafeInteger(options.maxActiveNodes, 'invalid-active-capacity');
  const maxDelegationDepth = options.maxDelegationDepth === undefined
    ? graph.maxDelegationDepth
    : nonNegativeSafeInteger(options.maxDelegationDepth, 'invalid-delegation-depth');

  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const ownerIds = new Set(graph.nodes.map(node => node.owner.id));
  const parentIds = new Set(graph.nodes.flatMap(node => (node.parentId ? [node.parentId] : [])));
  const normalizedMaps = {};
  for (const [name, values, allowedKeys] of [
    ['priorities', options.priorities ?? {}, nodeIds],
    ['capacity', options.capacityByOwner ?? {}, ownerIds],
    ['child-capacity', options.childCapacityByParent ?? {}, parentIds],
  ]) {
    const captured = capturedObject(values, allowedKeys, `unknown-${name}-key`);
    for (const [id, value] of Object.entries(captured)) {
      nonNegativeSafeInteger(value, `invalid-${name}`);
    }
    normalizedMaps[name] = captured;
  }

  let budget;
  if (options.budget !== undefined) {
    const capturedBudget = capturedObject(options.budget, new Set(BUDGET_KEYS), 'invalid-budget');
    if (Object.keys(capturedBudget).length !== BUDGET_KEYS.length) graphFailure('invalid-budget');
    budget = {};
    for (const key of BUDGET_KEYS) {
      const value = capturedBudget[key];
      if (key === 'costUsd') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) graphFailure('invalid-budget');
        budget[key] = decimalFromNumber(value);
      } else {
        nonNegativeSafeInteger(value, 'invalid-budget');
        budget[key] = value;
      }
    }
  }

  return {
    maxActiveNodes,
    maxDelegationDepth,
    priorities: normalizedMaps.priorities,
    capacityByOwner: normalizedMaps.capacity,
    childCapacityByParent: normalizedMaps['child-capacity'],
    budget,
  };
}

function dependencyDepths(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const depths = new Map(graph.nodes.map(node => [node.id, 0]));
  const remaining = new Map(graph.nodes.map(node => [node.id, node.dependencies.length]));
  const dependents = new Map(graph.nodes.map(node => [node.id, []]));
  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) dependents.get(dependency).push(node.id);
  }
  const queue = graph.nodes.filter(node => node.dependencies.length === 0).map(node => node.id).sort(codePointCompare);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const dependentId of dependents.get(id).sort(codePointCompare)) {
      depths.set(dependentId, Math.max(depths.get(dependentId), depths.get(id) + 1));
      const next = remaining.get(dependentId) - 1;
      remaining.set(dependentId, next);
      if (next === 0) queue.push(dependentId);
    }
  }
  if ([...remaining.values()].some(value => value !== 0)) graphFailure('dependency-cycle');
  return depths;
}

function delegationDepth(node, nodes) {
  let depth = 0;
  let current = node;
  while (current.parentId) {
    depth += 1;
    current = nodes.get(current.parentId);
  }
  return depth;
}

function dependenciesComplete(node, nodes) {
  return node.dependencies.every(id => nodes.get(id).status === 'completed');
}

function candidates(graph, options) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const depths = dependencyDepths(graph);
  return graph.nodes
    .filter(node => (
      CANDIDATE_STATES.has(node.status)
      && dependenciesComplete(node, nodes)
      && delegationDepth(node, nodes) <= options.maxDelegationDepth
    ))
    .sort((left, right) => (
      ((options.priorities[left.id] ?? 0) < (options.priorities[right.id] ?? 0) ? 1
        : (options.priorities[left.id] ?? 0) > (options.priorities[right.id] ?? 0) ? -1 : 0)
      || depths.get(left.id) - depths.get(right.id)
      || codePointCompare(left.id, right.id)
    ));
}

function budgetFits(node, remaining) {
  return !remaining || BUDGET_KEYS.every(key => (
    key === 'costUsd'
      ? compareDecimals(decimalFromNumber(node.budget[key]), remaining[key]) <= 0
      : node.budget[key] <= remaining[key]
  ));
}

function consumeBudget(node, remaining) {
  if (!remaining) return;
  for (const key of BUDGET_KEYS) {
    remaining[key] = key === 'costUsd'
      ? subtractDecimals(remaining[key], decimalFromNumber(node.budget[key]))
      : remaining[key] - node.budget[key];
  }
}

function scheduleReadyNodesUnsafe(graph, rawOptions) {
  const stableGraph = validatedGraphSnapshot(graph);
  return scheduleValidatedGraph(stableGraph, rawOptions);
}

function scheduleValidatedGraph(graph, rawOptions) {
  const options = validateOptions(rawOptions, graph);
  const active = graph.nodes.filter(node => ACTIVE_STATES.has(node.status));
  let slots = Math.max(0, options.maxActiveNodes - active.length);
  const ownerCounts = new Map();
  const childCounts = new Map();
  for (const node of active) {
    ownerCounts.set(node.owner.id, (ownerCounts.get(node.owner.id) ?? 0) + 1);
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }
  const remaining = options.budget ? { ...options.budget } : undefined;
  const selected = [];
  for (const node of candidates(graph, options)) {
    if (slots === 0) break;
    const ownerCapacity = options.capacityByOwner[node.owner.id] ?? graph.nodes.length;
    const childCapacity = node.parentId
      ? options.childCapacityByParent[node.parentId] ?? graph.nodes.length
      : graph.nodes.length;
    if ((ownerCounts.get(node.owner.id) ?? 0) >= ownerCapacity) continue;
    if (node.parentId && (childCounts.get(node.parentId) ?? 0) >= childCapacity) continue;
    if (!budgetFits(node, remaining)) continue;
    selected.push(node.id);
    slots -= 1;
    ownerCounts.set(node.owner.id, (ownerCounts.get(node.owner.id) ?? 0) + 1);
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    consumeBudget(node, remaining);
  }
  return selected;
}

export function scheduleReadyNodes(graph, rawOptions = {}) {
  return sanitizeGraphOperation(
    () => scheduleReadyNodesUnsafe(graph, rawOptions),
    'invalid-scheduler-options',
  );
}

export function readyNodeIds(graph, options = {}) {
  return sanitizeGraphOperation(
    () => scheduleReadyNodesUnsafe(graph, options),
    'invalid-scheduler-options',
  );
}

export function canStart(graph, nodeId, options = {}) {
  return sanitizeGraphOperation(() => {
    const stableGraph = validatedGraphSnapshot(graph);
    if (!stableGraph.nodes.some(node => node.id === nodeId)) graphFailure('unknown-node');
    return scheduleValidatedGraph(stableGraph, options).includes(nodeId);
  }, 'invalid-scheduler-options');
}
