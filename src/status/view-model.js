import { isIP } from 'node:net';

const DEFAULT_LIMITS = Object.freeze({ nodes: 256, agents: 256, events: 200, evidence: 512, stringLength: 256 });
const INPUT_LIMITS = Object.freeze({ array: 4_096, events: 10_000, record: 4_096, ids: 512 });
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STATUS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ROLE = new Set(['boss', 'manager', 'worker', 'human', 'system']);
const EVENT_TYPES = new Set([
  'graph-created', 'state-transition', 'retry', 'heartbeat', 'evidence-recorded',
  'approval-recorded', 'authority-adjusted', 'budget-adjusted', 'cancelled',
]);
const SECRET_TEXT = /(?:authorization\s*:|(?:bearer|basic)\s+[a-z0-9._~+/=-]{3,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,}|glpat-[a-z0-9_-]{8,}|(?:npm|pypi|hf)_[a-z0-9_-]{8,}|akia[0-9a-z]{16}|aiza[0-9a-z_-]{16,}|(?:sk|xox[a-z]?)-[a-z0-9_-]{8,}|(?:password|passwd|secret|credential|token|api[-_ ]?key|private[-_ ]?key)\s*[:=]\s*\S+)/i;
const PRIVATE_PATH = /(?:^|[\s"'(])(?:\/(?:Users|home|private|tmp|var|etc|opt|srv|Volumes)(?:\/|$)|[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|\/\/[^/\s]+\/[^/\s]+)/i;
const ABSOLUTE_TEXT_PATH = /(?:^|[\s"'(])\/(?!\/)[^/\s]+\/[^\s]+/;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\//i;
const CREDENTIAL_WORD = /\b(?:authorization|bearer|cookie|credential|password|passwd|private[-_ ]?key|secret|session(?:id)?|token)\b/i;
const ENV_CREDENTIAL = /\b(?:aws_(?:secret_access_key|access_key_id|session_token)|[a-z][a-z0-9_]*(?:api_key|access_key|private_key|credential(?:s)?|cookie|password|passwd|secret|session|session_?id|token|url))\b\s*[:=]/i;
const PUBLIC_REASON = /^[a-z0-9][a-z0-9 .,'()_:+-]*$/i;
const SAFE_PATH_SEGMENT = /^[a-z0-9][a-z0-9._~-]{0,95}$/i;
const CREDENTIAL_PATH_SEGMENT = /(?:^|[._~-])(?:access[-_]?key|api[-_]?key|auth(?:orization)?|bearer|cookie|credential|key|password|passwd|private[-_]?key|secret|session(?:id)?|token)(?:$|[._~-])/i;

const arrayIsArray = Array.isArray;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const objectFreeze = Object.freeze;
const ownKeys = Reflect.ownKeys;
const stringNormalize = String.prototype.normalize;

export class StatusViewError extends Error {
  constructor() {
    super('Status state is invalid.');
    this.name = 'StatusViewError';
    this.code = 'ERR_STATUS_VIEW_INVALID';
  }
}

function invalid() { throw new StatusViewError(); }

function snapshotContext() {
  const records = new WeakMap();
  const arrays = new WeakMap();
  function record(value, { optional = false } = {}) {
    if (value === undefined || value === null) {
      if (optional) return objectFreeze(Object.create(null));
      invalid();
    }
    if (typeof value !== 'object' || arrayIsArray(value)) invalid();
    if (records.has(value)) return records.get(value);
    const prototype = getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = ownKeys(value);
    if (keys.length > INPUT_LIMITS.record) invalid();
    const copy = Object.create(null);
    records.set(value, copy);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') invalid();
      const descriptor = getDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      copy[key] = descriptor.value;
    }
    return objectFreeze(copy);
  }
  function array(value, { optional = false, maximum = INPUT_LIMITS.array } = {}) {
    if (value === undefined || value === null) {
      if (optional) return objectFreeze([]);
      invalid();
    }
    if (!arrayIsArray(value)) invalid();
    if (arrays.has(value)) {
      const cached = arrays.get(value);
      if (cached.length > maximum) invalid();
      return cached.value;
    }
    const lengthDescriptor = getDescriptor(value, 'length');
    if (!lengthDescriptor || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) invalid();
    const length = lengthDescriptor.value;
    const keys = ownKeys(value);
    if (keys.length !== length + 1) invalid();
    const copy = new Array(length);
    arrays.set(value, { value: copy, length });
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = getDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      copy[index] = descriptor.value;
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= length || String(Number(key)) !== key)) invalid();
    }
    return objectFreeze(copy);
  }
  return objectFreeze({ record, array });
}

function safeId(value) { return typeof value === 'string' && value.length <= 96 && ID.test(value) ? value : null; }
function safeStatus(value, fallback = 'unknown') { return typeof value === 'string' && value.length <= 48 && STATUS.test(value) ? value : fallback; }
function safeRole(value) { return ROLE.has(value) ? value : 'system'; }
function integer(value, fallback = 0) { return Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
function decimal(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && value.length <= 32 ? value : '0';
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}
function isoFromMs(value) { return Number.isSafeInteger(value) && value >= 0 ? new Date(value).toISOString() : null; }
function publicText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = stringNormalize.call(value, 'NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!normalized || SECRET_TEXT.test(normalized) || CREDENTIAL_WORD.test(normalized) || ENV_CREDENTIAL.test(normalized)
    || PRIVATE_PATH.test(normalized) || ABSOLUTE_TEXT_PATH.test(normalized)
    || URL_TEXT.test(normalized) || !PUBLIC_REASON.test(normalized)) return null;
  return normalized.slice(0, maximum);
}
function ids(context, value, maximum = 64) {
  const values = context.array(value, { optional: true, maximum: INPUT_LIMITS.ids });
  const result = [];
  for (let index = 0; index < Math.min(values.length, maximum); index += 1) {
    const id = safeId(values[index]);
    if (id) result.push(id);
  }
  return result;
}
function limits(context, input) {
  const candidate = context.record(input, { optional: true });
  const result = {};
  for (const key of ['nodes', 'agents', 'events', 'evidence', 'stringLength']) {
    const value = candidate[key];
    const fallback = DEFAULT_LIMITS[key];
    result[key] = Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback;
  }
  return objectFreeze(result);
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  const values = Object.values(value);
  for (let index = 0; index < values.length; index += 1) deepFreeze(values[index]);
  return objectFreeze(value);
}

function projectEvents(context, source, { afterSequence, maxEvents, stringLength }) {
  const events = context.array(source, { optional: true, maximum: INPUT_LIMITS.events });
  const output = [];
  for (let index = 0; index < events.length; index += 1) {
    const input = context.record(events[index]);
    const eventId = safeId(input.eventId);
    const sequence = input.sequence;
    const type = input.type;
    const eventTimestamp = timestamp(input.timestamp);
    if (!eventId || !Number.isSafeInteger(sequence) || sequence < 1 || !EVENT_TYPES.has(type) || !eventTimestamp) continue;
    const actorInput = context.record(input.actor, { optional: true });
    const actorId = safeId(actorInput.id);
    const event = {
      id: eventId, sequence, timestamp: eventTimestamp, type,
      ...(safeId(input.nodeId) ? { nodeId: safeId(input.nodeId) } : {}),
      actor: actorId ? { role: safeRole(actorInput.role), id: actorId } : { role: 'system', id: 'runtime' },
    };
    if (type === 'state-transition') {
      event.priorState = safeStatus(input.priorState);
      event.newState = safeStatus(input.newState);
    } else if (type === 'retry') {
      const reason = publicText(input.retryReason, stringLength);
      if (reason) event.retryReason = reason;
    } else if (type === 'heartbeat') {
      event.heartbeatSequence = integer(input.heartbeatSequence);
      event.heartbeatIntervalMs = integer(input.heartbeatIntervalMs);
    } else if (type === 'evidence-recorded' || type === 'approval-recorded') {
      event.evidenceRefs = ids(context, input.evidenceRefs);
    } else if (type === 'cancelled') {
      const reason = publicText(input.cancellationReason, stringLength);
      if (reason) event.reason = reason;
    }
    if (sequence > afterSequence) output.push(event);
  }
  output.sort((left, right) => left.sequence - right.sequence);
  return output.slice(-maxEvents);
}

export function projectStatusEvents(events, options = {}) {
  try {
    const context = snapshotContext();
    const safeOptions = context.record(options, { optional: true });
    const afterSequence = Number.isSafeInteger(safeOptions.afterSequence) && safeOptions.afterSequence >= 0 ? safeOptions.afterSequence : 0;
    const maxEvents = Number.isSafeInteger(safeOptions.maxEvents) && safeOptions.maxEvents > 0 ? Math.min(safeOptions.maxEvents, DEFAULT_LIMITS.events) : DEFAULT_LIMITS.events;
    const stringLength = Number.isSafeInteger(safeOptions.stringLength) && safeOptions.stringLength > 0 ? Math.min(safeOptions.stringLength, DEFAULT_LIMITS.stringLength) : DEFAULT_LIMITS.stringLength;
    return deepFreeze(projectEvents(context, events, { afterSequence, maxEvents, stringLength }));
  } catch { invalid(); }
}

function graphRows(context, allNodes, maximum) {
  const rows = [];
  const sources = new Map();
  const agentIds = new Set();
  for (let index = 0; index < allNodes.length; index += 1) {
    const input = context.record(allNodes[index]);
    const owner = context.record(input.owner, { optional: true });
    const id = safeId(input.id) ?? 'unknown-node';
    const ownerId = safeId(owner.id) ?? 'runtime';
    if (safeId(owner.id)) agentIds.add(ownerId);
    const row = { id, parentId: safeId(input.parentId), role: safeRole(owner.role), ownerId, status: safeStatus(input.status), dependencies: ids(context, input.dependencies) };
    sources.set(id, input);
    if (rows.length < maximum) rows.push(row);
  }
  return { rows, sources, agentIds };
}
function agentRows(context, nodes, state, nowMs, maximum) {
  const intents = context.record(state.launchIntents, { optional: true });
  const heartbeats = context.record(state.heartbeats, { optional: true });
  const priority = new Map([['corrective', 0], ['running', 1], ['reserved', 2], ['ready', 3], ['blocked', 4], ['failed', 5], ['completed', 6]]);
  const byAgent = new Map();
  for (const node of nodes) {
    const existing = byAgent.get(node.ownerId);
    if (!existing || (priority.get(node.status) ?? 99) < (priority.get(existing.status) ?? 99)) byAgent.set(node.ownerId, node);
  }
  const result = [];
  for (const node of byAgent.values()) {
    if (result.length >= maximum) break;
    const heartbeat = context.record(heartbeats[node.id], { optional: true });
    const heartbeatMs = heartbeat.timestampMs;
    const latestHeartbeatAt = isoFromMs(heartbeatMs);
    const intent = context.record(intents[node.id], { optional: true });
    const startedAtMs = intent.startedAtMs;
    result.push({
      id: node.ownerId, role: node.role, status: node.status, currentNodeId: node.id,
      attempt: Math.max(1, integer(intent.attempt, 1)),
      elapsedMs: Number.isSafeInteger(startedAtMs) && startedAtMs >= 0 && startedAtMs <= nowMs ? nowMs - startedAtMs : 0,
      latestHeartbeatAt, heartbeatAgeMs: latestHeartbeatAt && heartbeatMs <= nowMs ? nowMs - heartbeatMs : null,
    });
  }
  return result;
}
function worktreeRows(context, nodes, state) {
  const byNode = new Map();
  for (const node of nodes) byNode.set(node.id, node);
  const intents = context.record(state.launchIntents, { optional: true });
  const keys = Object.keys(intents).sort();
  const rows = [];
  for (const nodeId of keys) {
    const node = byNode.get(nodeId);
    const intent = context.record(intents[nodeId], { optional: true });
    if (!node || intent.worktree === undefined || intent.worktree === null) continue;
    context.record(intent.worktree);
    rows.push({ nodeId, ownerId: node.ownerId, status: safeStatus(intent.status), displayPath: `.worktrees/${node.id}` });
  }
  return rows;
}
function publicHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (!lower || lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) return false;
  if (isIP(lower) !== 0) return false;
  return lower.includes('.') && !lower.startsWith('.') && !lower.endsWith('.');
}
function safeEvidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !publicHostname(url.hostname)) return null;
    if (url.pathname.length > 1_024 || url.pathname.includes('%')) return null;
    const segments = url.pathname === '/' ? [] : url.pathname.slice(1).split('/');
    if (segments.some(segment => !SAFE_PATH_SEGMENT.test(segment)
      || CREDENTIAL_PATH_SEGMENT.test(segment) || SECRET_TEXT.test(segment))) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}
function evidenceRows(context, state, maximum) {
  const values = context.array(state.evidence, { optional: true });
  const result = [];
  for (let index = 0; index < Math.min(values.length, maximum); index += 1) {
    const input = context.record(values[index]);
    const row = { id: safeId(input.id) ?? 'unknown-evidence', nodeId: safeId(input.nodeId), type: safeStatus(input.type), approvalState: safeStatus(input.approvalState, 'pending') };
    const url = safeEvidenceUrl(input.url);
    if (url) row.url = url;
    result.push(row);
  }
  return { rows: result, total: values.length };
}
function usageRecord(context, value) {
  const input = context.record(value, { optional: true });
  return { tokens: integer(input.tokens), costUsd: decimal(input.costUsd), retries: integer(input.retries), timeMinutes: integer(input.timeMinutes), taskLimit: integer(input.taskLimit) };
}
function earliestEventMs(events) {
  for (const event of events) {
    const value = Date.parse(event.timestamp);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function currentStage(nodes) {
  for (const status of ['corrective', 'running', 'reserved', 'ready']) for (const node of nodes) if (node.status === status) return node;
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function build(stateValue, optionsValue) {
  const context = snapshotContext();
  const state = context.record(stateValue);
  const options = context.record(optionsValue, { optional: true });
  const nowMs = Number.isSafeInteger(options.nowMs) && options.nowMs >= 0 ? options.nowMs : Date.now();
  const configuredLimits = limits(context, options.limits);
  const graph = context.record(state.graph);
  const allNodes = context.array(graph.nodes, { optional: true });
  const projectedGraph = graphRows(context, allNodes, configuredLimits.nodes);
  const nodes = projectedGraph.rows;
  const allEvents = context.array(state.events, { optional: true, maximum: INPUT_LIMITS.events });
  const events = projectEvents(context, allEvents, { afterSequence: 0, maxEvents: configuredLimits.events, stringLength: configuredLimits.stringLength });
  const agents = agentRows(context, nodes, state, nowMs, configuredLimits.agents);
  const evidenceResult = evidenceRows(context, state, configuredLimits.evidence);
  const evidence = evidenceResult.rows;
  const gates = [];
  for (const node of nodes) {
    const source = projectedGraph.sources.get(node.id);
    const gateId = safeId(source?.approvalGate);
    if (gateId) gates.push({ id: gateId, nodeId: node.id, status: node.status, requiredEvidence: ids(context, source.requiredEvidenceTypes) });
  }
  const gateByNode = new Map();
  for (const gate of gates) gateByNode.set(gate.nodeId, gate.id);
  const humanDecisions = [];
  for (const event of events) if (event.type === 'approval-recorded' && event.actor.role === 'human') humanDecisions.push({
    id: event.id, gateId: gateByNode.get(event.nodeId) ?? 'activation', nodeId: event.nodeId ?? null,
    decision: 'approved', decidedAt: event.timestamp, actorId: event.actor.id, evidenceRefs: event.evidenceRefs ?? [],
  });
  const attempts = context.record(state.attempts, { optional: true });
  const correctiveWork = [];
  for (const node of nodes) {
    if (node.status !== 'corrective') continue;
    let retry = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'retry' && events[index].nodeId === node.id) { retry = events[index]; break; }
    }
    correctiveWork.push({ nodeId: node.id, ownerId: node.ownerId, status: node.status, attempt: integer(attempts[node.id], 1), ...(retry?.retryReason ? { reason: retry.retryReason } : {}) });
  }
  const heartbeatTimes = [];
  for (const agent of agents) if (agent.latestHeartbeatAt) heartbeatTimes.push(agent.latestHeartbeatAt);
  heartbeatTimes.sort();
  const startedAtMs = Number.isSafeInteger(state.startedAtMs) && state.startedAtMs >= 0 ? state.startedAtMs : earliestEventMs(events);
  const stage = currentStage(nodes);
  return deepFreeze({
    schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(),
    goal: { id: safeId(graph.id) ?? 'unknown-goal', status: safeStatus(graph.status), version: integer(state.version), activated: state.activated === true, terminal: state.terminal === null ? null : safeStatus(state.terminal) },
    currentStage: stage ? { nodeId: stage.id, status: stage.status } : null,
    graph: { nodes }, agents, worktrees: worktreeRows(context, nodes, state), gates, correctiveWork, evidence, humanDecisions,
    budget: { elapsedMs: startedAtMs !== null && startedAtMs <= nowMs ? nowMs - startedAtMs : 0, usage: usageRecord(context, state.usage), limits: usageRecord(context, state.limits) },
    latestHeartbeatAt: heartbeatTimes.length ? heartbeatTimes[heartbeatTimes.length - 1] : null,
    events,
    truncated: { nodes: Math.max(0, allNodes.length - nodes.length), agents: Math.max(0, projectedGraph.agentIds.size - agents.length), events: Math.max(0, allEvents.length - events.length), evidence: Math.max(0, evidenceResult.total - evidence.length) },
  });
}

export function buildStatusViewModel(state, options = {}) {
  try { return build(state, options); } catch { invalid(); }
}
