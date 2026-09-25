import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { EVIDENCE_TYPES, SCHEMA_FILES } from './defaults.js';
import { CommandConfigurationError, compileProjectCommands, compileQualitySteps } from './commands.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(SCHEMA_FILES).map(([name, filename]) => {
    const schema = JSON.parse(readFileSync(new URL(`../../schemas/${filename}`, import.meta.url), 'utf8'));
    return [name, ajv.compile(schema)];
  }),
);

const SAFE_SECRET_KEYS = new Set([
  'credentials',
  'apiTokenEnv',
  'accessTokenEnv',
  'tokenEnv',
  'usernameEnv',
  'tokenLimit',
]);
const SECRET_KEY = /(?:password|passwd|secret|api[-_]?key|authorization|cookie|credential|access[-_]?token|api[-_]?token|\btoken\b)/i;
const SECRET_VALUE = /^(?:bearer\s+|basic\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z]{16})/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const EVIDENCE_TYPE_SET = new Set(EVIDENCE_TYPES);
const WINDOWS_RESERVED_PATH_COMPONENT = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const ROLE_AUTHORITY_CEILINGS = Object.freeze({
  boss: new Set(['plan', 'implement', 'delegate', 'verify', 'external-write', 'merge', 'deploy', 'change-authority', 'change-budget']),
  manager: new Set(['implement', 'delegate', 'verify', 'external-write', 'merge']),
  worker: new Set(['implement', 'verify']),
});
const ROLE_PERMISSION_CEILINGS = Object.freeze({
  boss: new Set(['externalWrites', 'merge', 'deploy']),
  manager: new Set(['externalWrites', 'merge']),
  worker: new Set(),
});
const ROLE_DELEGATION_CEILINGS = Object.freeze({
  boss: new Set(['manager']),
  manager: new Set(['worker']),
  worker: new Set(),
});
const HUMAN_FINAL_GATES = new Set(['publication', 'final-delivery']);

function safePath(path) {
  if (!path || path === '/') return '/';
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => (/^[A-Za-z0-9_.-]{1,80}$/.test(segment) ? segment : '?'))
    .join('/')
    .replace(/^/, '/');
}

export class ConfigurationError extends Error {
  constructor(path = '/', reason = 'invalid') {
    super(`Tracked configuration is invalid at ${safePath(path)}.`);
    this.name = 'ConfigurationError';
    this.code = 'ERR_INVALID_TRACKED_CONFIG';
    this.safeMessage = this.message;
    this.details = Object.freeze({ path: safePath(path), reason });
  }
}

function fail(path, reason) {
  throw new ConfigurationError(path, reason);
}

function schemaValidate(name, value) {
  const validate = validators[name];
  if (validate(value)) return;
  const path = validate.errors?.[0]?.instancePath || '/';
  fail(path, 'schema');
}

function scanForSecrets(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (SECRET_KEY.test(key) && !SAFE_SECRET_KEYS.has(key)) fail(childPath, 'secret-key');
    if (typeof child === 'string' && SECRET_VALUE.test(child)) fail(childPath, 'secret-value');
    if (typeof child === 'string' && /^https?:\/\//i.test(child)) assertSafeUrl(child, childPath);
    scanForSecrets(child, childPath);
  }
}

function uniqueBy(items, key, path) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) fail(`${path}/${key}`, 'duplicate-id');
    seen.add(value);
  }
  return seen;
}

function assertSafeUrl(value, path) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(path, 'url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail(path, 'url-scheme');
  if (parsed.username || parsed.password) fail(path, 'url-userinfo');
  if (parsed.hash) fail(path, 'url-fragment');
  let decodedPath = parsed.pathname;
  let stabilized = false;
  for (let pass = 0; pass < 4; pass += 1) {
    let nextPath;
    try {
      nextPath = decodeURIComponent(decodedPath);
    } catch {
      fail(path, 'url-path-encoding');
    }
    if (nextPath === decodedPath) {
      stabilized = true;
      break;
    }
    decodedPath = nextPath;
  }
  if (!stabilized) {
    let nextPath;
    try {
      nextPath = decodeURIComponent(decodedPath);
    } catch {
      fail(path, 'url-path-encoding');
    }
    if (nextPath !== decodedPath) fail(path, 'url-path-encoding-depth');
  }
  if (/%[0-9a-f]{2}/i.test(decodedPath)) fail(path, 'url-path-encoding-depth');
  for (const rawComponent of decodedPath.replace(/\\/g, '/').split('/')) {
    const component = rawComponent.normalize('NFKC');
    if (SECRET_VALUE.test(component)) fail(path, 'url-secret-path');
    const delimiterIndex = component.search(/[=:]/);
    if (delimiterIndex >= 0) {
      const key = component.slice(0, delimiterIndex);
      const componentValue = component.slice(delimiterIndex + 1);
      if (SECRET_KEY.test(key) || SECRET_VALUE.test(componentValue)) fail(path, 'url-secret-path');
    }
  }
  for (const [key, queryValue] of parsed.searchParams) {
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(queryValue)) fail(path, 'url-secret-metadata');
  }
}

function assertTimestamp(value, path) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) fail(path, 'timestamp');
  const date = new Date(value);
  const parts = match.slice(1, 7).map(Number);
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== parts[0]
    || date.getUTCMonth() + 1 !== parts[1]
    || date.getUTCDate() !== parts[2]
    || date.getUTCHours() !== parts[3]
    || date.getUTCMinutes() !== parts[4]
    || date.getUTCSeconds() !== parts[5]
  ) fail(path, 'timestamp');
}

function assertSafeRelativePath(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'unsafe-path');
  const canonical = value.normalize('NFKC');
  if (/[\u0000\r\n:]/.test(canonical)) fail(path, 'unsafe-path');
  const normalized = canonical.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized === '.'
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(canonical)
    || normalized.includes('//')
    || normalized.endsWith('/')
    || segments.some(segment => (
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || WINDOWS_RESERVED_PATH_COMPONENT.test(segment)
    ))
  ) fail(path, 'unsafe-path');
}

function validateConfigSemantics(config) {
  scanForSecrets(config);

  const providerIds = uniqueBy(config.providers.providers, 'id', '/providers/providers');
  if (config.project.deployment && !providerIds.has(config.project.deployment.providerId))
    fail('/project/deployment/providerId', 'provider-reference');
  for (const provider of config.providers.providers) {
    if (provider.endpoint) assertSafeUrl(provider.endpoint, `/providers/providers/${provider.id}/endpoint`);
    for (const [key, envName] of Object.entries(provider.credentials ?? {})) {
      if (!key.endsWith('Env') || !ENV_NAME.test(envName)) fail(`/providers/providers/${provider.id}/credentials/${key}`, 'credential-reference');
    }
    for (const resourceId of provider.resourceIds ?? []) {
      if (/^https?:\/\//i.test(resourceId)) assertSafeUrl(resourceId, `/providers/providers/${provider.id}/resourceIds`);
      else assertSafeRelativePath(resourceId, `/providers/providers/${provider.id}/resourceIds`);
    }
  }

  try { compileProjectCommands(config.project); }
  catch (error) {
    if (error instanceof CommandConfigurationError) fail(error.path, error.reason);
    fail('/project/commands', 'command');
  }
  for (const path of config.project.repository.sensitivePaths ?? []) assertSafeRelativePath(path, '/project/repository/sensitivePaths');

  uniqueBy(config.orchestration.roles, 'id', '/orchestration/roles');
  const profileIds = uniqueBy(config.orchestration.completionProfiles, 'id', '/orchestration/completionProfiles');
  const profileMap = new Map(config.orchestration.completionProfiles.map(profile => [profile.id, profile]));
  const kinds = new Set(config.orchestration.roles.map(role => role.kind));
  for (const requiredKind of ['boss', 'manager', 'worker']) {
    if (!kinds.has(requiredKind)) fail('/orchestration/roles', 'missing-role-kind');
  }
  const bossRoles = config.orchestration.roles.filter(role => role.kind === 'boss');
  if (bossRoles.length !== 1) fail('/orchestration/roles', 'boss-count');
  for (const role of config.orchestration.roles) {
    if (role.harness !== undefined && (role.kind !== 'worker' || !['claude', 'codex'].includes(role.harness))) fail(`/orchestration/roles/${role.id}/harness`, 'worker-harness');
    if (role.kind === 'worker' && role.canDelegate) fail(`/orchestration/roles/${role.id}/canDelegate`, 'worker-delegation');
    if (role.canDelegate !== (role.delegatesTo.length > 0)) fail(`/orchestration/roles/${role.id}/delegatesTo`, 'delegation-policy');
    for (const target of role.delegatesTo) {
      if (!ROLE_DELEGATION_CEILINGS[role.kind].has(target)) fail(`/orchestration/roles/${role.id}/delegatesTo`, 'delegation-ceiling');
    }
    for (const scope of role.authorityScopes) {
      if (!ROLE_AUTHORITY_CEILINGS[role.kind].has(scope)) fail(`/orchestration/roles/${role.id}/authorityScopes`, 'authority-ceiling');
    }
    for (const [permission, enabled] of Object.entries(role.permissions)) {
      if (enabled && !ROLE_PERMISSION_CEILINGS[role.kind].has(permission)) {
        fail(`/orchestration/roles/${role.id}/permissions/${permission}`, 'permission-ceiling');
      }
    }
    if (!profileIds.has(role.completionProfile)) fail(`/orchestration/roles/${role.id}/completionProfile`, 'completion-profile-reference');
    for (const providerRef of role.providerRefs) {
      if (!providerIds.has(providerRef)) fail(`/orchestration/roles/${role.id}/providerRefs`, 'provider-reference');
    }
  }
  for (const mandatoryGate of ['activation', 'external-write', 'final-delivery']) {
    if (!config.orchestration.approvalGates.includes(mandatoryGate)) fail('/orchestration/approvalGates', 'mandatory-approval');
  }
  const bossProfile = profileMap.get(bossRoles[0].completionProfile);
  if (!bossProfile.requiredApprovals.includes('human') || !bossProfile.requiredEvidence.includes('human-approval')) {
    fail(`/orchestration/completionProfiles/${bossProfile.id}`, 'boss-human-approval');
  }

  const commandNames = new Set(Object.keys(config.project.commands));
  const gateIds = uniqueBy(config.quality.commandGates, 'id', '/quality/commandGates');
  for (const gate of config.quality.commandGates) {
    if (!commandNames.has(gate.command)) fail(`/quality/commandGates/${gate.id}/command`, 'command-reference');
  }
  try { compileQualitySteps(config); }
  catch (error) {
    if (error instanceof CommandConfigurationError) fail(error.path, error.reason);
    fail('/quality/commandGates', 'command-expansion');
  }
  for (const mandatoryCommand of ['build', 'test']) {
    if (![...gateIds].some(id => config.quality.commandGates.some(gate => gate.id === id && gate.command === mandatoryCommand && gate.required))) {
      fail('/quality/commandGates', 'mandatory-command-gate');
    }
  }
  if (config.quality.expectations.visual === 'human-baseline' && !config.quality.evidence.requireHumanBaseline) {
    fail('/quality/evidence/requireHumanBaseline', 'human-baseline');
  }
  for (const providerRef of config.quality.providerRefs) {
    if (!providerIds.has(providerRef)) fail('/quality/providerRefs', 'provider-reference');
  }
  for (const profileRef of config.quality.completionProfileRefs) {
    if (!profileIds.has(profileRef)) fail('/quality/completionProfileRefs', 'completion-profile-reference');
  }
  const selectedProfiles = new Set(config.quality.completionProfileRefs);
  const qualityEvidence = new Set(config.quality.evidence.requiredTypes);
  for (const role of config.orchestration.roles) {
    if (!selectedProfiles.has(role.completionProfile)) fail('/quality/completionProfileRefs', 'role-profile-selection');
    for (const evidenceType of profileMap.get(role.completionProfile).requiredEvidence) {
      if (!qualityEvidence.has(evidenceType)) fail('/quality/evidence/requiredTypes', 'profile-evidence-coverage');
    }
  }
  for (const evidenceType of qualityEvidence) {
    if (!EVIDENCE_TYPE_SET.has(evidenceType)) fail('/quality/evidence/requiredTypes', 'evidence-type');
  }
}

export function validateProjectConfiguration(config) {
  for (const name of ['project', 'providers', 'orchestration', 'quality']) {
    schemaValidate(name, config[name]);
  }
  validateConfigSemantics(config);
  return true;
}

function visitDependencies(nodeId, nodeMap, visited) {
  if (visited.has(nodeId)) return;
  const visiting = new Set([nodeId]);
  const stack = [{ nodeId, dependencyIndex: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const dependencies = nodeMap.get(frame.nodeId).dependencies;
    if (frame.dependencyIndex >= dependencies.length) {
      visiting.delete(frame.nodeId);
      visited.add(frame.nodeId);
      stack.pop();
      continue;
    }
    const dependency = dependencies[frame.dependencyIndex];
    frame.dependencyIndex += 1;
    if (visiting.has(dependency)) fail(`/nodes/${dependency}/dependencies`, 'dependency-cycle');
    if (visited.has(dependency)) continue;
    visiting.add(dependency);
    stack.push({ nodeId: dependency, dependencyIndex: 0 });
  }
}

function delegationDepth(nodeId, nodeMap, knownDepths) {
  if (knownDepths.has(nodeId)) return knownDepths.get(nodeId);
  const visiting = new Set();
  const path = [];
  let currentId = nodeId;
  let depth;
  while (true) {
    if (knownDepths.has(currentId)) {
      depth = knownDepths.get(currentId);
      break;
    }
    if (visiting.has(currentId)) fail(`/nodes/${currentId}/parentId`, 'parent-cycle');
    visiting.add(currentId);
    path.push(currentId);
    const parentId = nodeMap.get(currentId).parentId;
    if (!parentId) {
      depth = -1;
      break;
    }
    currentId = parentId;
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    depth += 1;
    knownDepths.set(path[index], depth);
  }
  return knownDepths.get(nodeId);
}

export function validateGoalGraph(graph, config) {
  schemaValidate('goalGraph', graph);
  scanForSecrets(graph);
  const nodeIds = uniqueBy(graph.nodes, 'id', '/nodes');
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) {
      if (!nodeIds.has(dependency)) fail(`/nodes/${node.id}/dependencies`, 'dangling-dependency');
      if (dependency === node.id) fail(`/nodes/${node.id}/dependencies`, 'self-dependency');
    }
    if (node.parentId && !nodeIds.has(node.parentId)) fail(`/nodes/${node.id}/parentId`, 'dangling-parent');
    if (node.parentId === node.id) fail(`/nodes/${node.id}/parentId`, 'self-parent');
  }
  const roots = graph.nodes.filter(node => !node.parentId);
  if (roots.length !== 1 || roots[0].owner.role !== 'boss') fail('/nodes', 'boss-root');
  const finalDeliveryNodes = graph.nodes.filter(node => node.approvalGate === 'final-delivery');
  if (finalDeliveryNodes.length !== 1) fail('/nodes', 'final-delivery-node');
  for (const node of graph.nodes) {
    if (node.approvalGate && HUMAN_FINAL_GATES.has(node.approvalGate)) {
      if (node.owner.role !== 'boss' || !node.requiredEvidenceTypes.includes('human-approval')) {
        fail(`/nodes/${node.id}/approvalGate`, 'human-final-gate');
      }
    }
    if (node.approvalGate && node.owner.role === 'worker') {
      fail(`/nodes/${node.id}/approvalGate`, 'worker-approval-gate');
    }
  }
  const visitedDependencies = new Set();
  for (const node of graph.nodes) visitDependencies(node.id, nodeMap, visitedDependencies);
  const knownDelegationDepths = new Map();
  for (const node of graph.nodes) {
    if (delegationDepth(node.id, nodeMap, knownDelegationDepths) > graph.maxDelegationDepth) fail(`/nodes/${node.id}/parentId`, 'delegation-depth');
  }

  if (config) {
    if (graph.maxDelegationDepth > config.orchestration.maxDelegationDepth) fail('/maxDelegationDepth', 'configured-delegation-depth');
    const providerIds = new Set(config.providers.providers.map(provider => provider.id));
    const roleMap = new Map(config.orchestration.roles.map(role => [role.id, role]));
    const profileIds = new Set(config.orchestration.completionProfiles.map(profile => profile.id));
    const profileMap = new Map(config.orchestration.completionProfiles.map(profile => [profile.id, profile]));
    const rootProfile = profileMap.get(roots[0].completionProfile);
    if (!rootProfile || !rootProfile.requiredApprovals.includes('human') || !rootProfile.requiredEvidence.includes('human-approval')) {
      fail(`/nodes/${roots[0].id}/completionProfile`, 'boss-root-human-approval');
    }
    for (const providerRef of graph.providerRefs) {
      if (!providerIds.has(providerRef)) fail('/providerRefs', 'provider-reference');
    }
    for (const node of graph.nodes) {
      const role = roleMap.get(node.owner.id);
      if (!role || role.kind !== node.owner.role) fail(`/nodes/${node.id}/owner`, 'role-reference');
      if (!profileIds.has(node.completionProfile)) fail(`/nodes/${node.id}/completionProfile`, 'completion-profile-reference');
      if (node.completionProfile !== role.completionProfile) fail(`/nodes/${node.id}/completionProfile`, 'completion-profile-bound');
      if (node.approvalGate && !config.orchestration.approvalGates.includes(node.approvalGate)) fail(`/nodes/${node.id}/approvalGate`, 'approval-reference');
      for (const scope of node.authorityScopes) {
        if (!role.authorityScopes.includes(scope)) fail(`/nodes/${node.id}/authorityScopes`, 'authority-bound');
      }
      for (const budgetName of ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']) {
        if (node.budget[budgetName] > role.budget[budgetName]) fail(`/nodes/${node.id}/budget/${budgetName}`, 'budget-bound');
      }
      const profile = profileMap.get(node.completionProfile);
      if (node.approvalGate && HUMAN_FINAL_GATES.has(node.approvalGate)) {
        if (!profile.requiredApprovals.includes('human') || !profile.requiredEvidence.includes('human-approval')) {
          fail(`/nodes/${node.id}/completionProfile`, 'human-final-profile');
        }
      }
      for (const evidenceType of profile.requiredEvidence) {
        if (!node.requiredEvidenceTypes.includes(evidenceType)) fail(`/nodes/${node.id}/requiredEvidenceTypes`, 'completion-evidence-coverage');
      }
      for (const evidenceType of node.requiredEvidenceTypes) {
        if (!config.quality.evidence.requiredTypes.includes(evidenceType)) fail(`/nodes/${node.id}/requiredEvidenceTypes`, 'quality-evidence-coverage');
      }
      if (node.parentId) {
        const parent = nodeMap.get(node.parentId);
        const parentRole = roleMap.get(parent.owner.id);
        if (node.owner.role === 'boss') {
          const isBoundFinalGate = (
            parent.id === roots[0].id
            && parent.owner.role === 'boss'
            && parent.owner.id === node.owner.id
            && HUMAN_FINAL_GATES.has(node.approvalGate)
            && node.completionProfile === parent.completionProfile
            && node.authorityScopes.every(scope => scope === 'verify')
          );
          if (!isBoundFinalGate) fail(`/nodes/${node.id}/parentId`, 'non-root-boss');
        } else {
          if (!parentRole.canDelegate) fail(`/nodes/${node.id}/parentId`, 'parent-cannot-delegate');
          if (!parentRole.delegatesTo.includes(node.owner.role)) fail(`/nodes/${node.id}/owner`, 'delegation-target');
        }
        for (const scope of node.authorityScopes) {
          if (!parent.authorityScopes.includes(scope)) fail(`/nodes/${node.id}/authorityScopes`, 'parent-authority-bound');
        }
        for (const budgetName of ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']) {
          if (node.budget[budgetName] > parent.budget[budgetName]) fail(`/nodes/${node.id}/budget/${budgetName}`, 'parent-budget-bound');
        }
      }
    }
  }
  return true;
}

function snapshotEventRecord(value, maximumKeys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'event-snapshot');
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys || keys.some(key => typeof key !== 'string' || key === '__proto__')) fail(path, 'event-snapshot');
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) fail(path, 'event-snapshot');
    output[key] = value[key];
  }
  return output;
}

function snapshotEventArray(value, maximumItems, path) {
  if (!Array.isArray(value)) fail(path, 'event-snapshot');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maximumItems) fail(path, 'event-snapshot');
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable) fail(path, 'event-snapshot');
    output.push(value[index]);
  }
  return output;
}

function snapshotEventInput(event) {
  try {
    const stable = snapshotEventRecord(event, 32, '/');
    if (Object.hasOwn(stable, 'actor')) stable.actor = snapshotEventRecord(stable.actor, 4, '/actor');
    if (Object.hasOwn(stable, 'evidenceRefs')) stable.evidenceRefs = snapshotEventArray(stable.evidenceRefs, 64, '/evidenceRefs');
    if (Object.hasOwn(stable, 'authorityDelta')) {
      stable.authorityDelta = snapshotEventRecord(stable.authorityDelta, 2, '/authorityDelta');
      if (Object.hasOwn(stable.authorityDelta, 'added')) stable.authorityDelta.added = snapshotEventArray(stable.authorityDelta.added, 32, '/authorityDelta/added');
      if (Object.hasOwn(stable.authorityDelta, 'removed')) stable.authorityDelta.removed = snapshotEventArray(stable.authorityDelta.removed, 32, '/authorityDelta/removed');
    }
    if (Object.hasOwn(stable, 'budgetDelta')) stable.budgetDelta = snapshotEventRecord(stable.budgetDelta, 4, '/budgetDelta');
    return stable;
  } catch {
    fail('/', 'event-snapshot');
  }
}

export function validateEvent(event) {
  const stable = snapshotEventInput(event);
  schemaValidate('event', stable);
  scanForSecrets(stable);
  assertTimestamp(stable.timestamp, '/timestamp');
  if (stable.type === 'approval-recorded') {
    if (stable.actor.role !== 'human') fail('/actor/role', 'approval-human-actor');
    if (!stable.evidenceRefs.includes(stable.approvalReceiptId)) fail('/approvalReceiptId', 'approval-receipt-reference');
  }
  if (stable.priorState && stable.newState && stable.priorState === stable.newState) fail('/newState', 'unchanged-state');
  return true;
}

export function validateEvidence(evidence, config) {
  schemaValidate('evidence', evidence);
  scanForSecrets(evidence);
  uniqueBy(evidence.items, 'id', '/items');
  if (config) {
    const providerIds = new Set(config.providers.providers.map(provider => provider.id));
    for (const item of evidence.items) {
      if (item.source.providerRef && !providerIds.has(item.source.providerRef)) fail(`/items/${item.id}/source/providerRef`, 'provider-reference');
    }
  }
  for (const item of evidence.items) {
    assertTimestamp(item.timestamp, `/items/${item.id}/timestamp`);
    if (item.location && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.location)) {
      if (!/^https?:\/\//i.test(item.location)) fail(`/items/${item.id}/location`, 'location-scheme');
      assertSafeUrl(item.location, `/items/${item.id}/location`);
    } else if (item.location) assertSafeRelativePath(item.location, `/items/${item.id}/location`);
    if (item.source.resourceId) {
      const resourcePath = `/items/${item.id}/source/resourceId`;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.source.resourceId)) {
        if (!/^https?:\/\//i.test(item.source.resourceId)) fail(resourcePath, 'resource-scheme');
        assertSafeUrl(item.source.resourceId, resourcePath);
      } else {
        assertSafeRelativePath(item.source.resourceId, resourcePath);
      }
    }
    if (item.type === 'human-approval') {
      if (item.producer.role !== 'human') fail(`/items/${item.id}/producer/role`, 'human-approver');
      if (item.approval.actorId !== item.producer.id) fail(`/items/${item.id}/approval/actorId`, 'approver-identity');
      if (item.approval.decision !== item.approvalState) fail(`/items/${item.id}/approvalState`, 'approval-decision-state');
      if (item.approval.decision !== evidence.approvalState) fail('/approvalState', 'bundle-decision-state');
    }
  }
  const approvedHumanItems = evidence.items.filter(item => item.type === 'human-approval' && item.approval.decision === 'approved');
  const rejectedHumanItems = evidence.items.filter(item => item.type === 'human-approval' && item.approval.decision === 'rejected');
  if (evidence.approvalState === 'approved') {
    if (approvedHumanItems.length === 0 || evidence.items.some(item => item.approvalState !== 'approved')) fail('/approvalState', 'approved-bundle-evidence');
  }
  if (evidence.approvalState === 'rejected' && rejectedHumanItems.length === 0) {
    fail('/approvalState', 'rejected-bundle-evidence');
  }
  if (evidence.publicationState === 'approved' && (evidence.approvalState !== 'approved' || approvedHumanItems.length === 0)) {
    fail('/publicationState', 'publication-approval');
  }
  if (evidence.publicationState !== 'approved' && evidence.items.some(item => item.classification === 'public')) {
    fail('/publicationState', 'public-evidence-approval');
  }
  if (evidence.publicationState === 'rejected' && evidence.items.some(item => item.classification === 'public')) {
    fail('/publicationState', 'rejected-publication');
  }
  return true;
}

export const validateConfig = validateProjectConfiguration;
