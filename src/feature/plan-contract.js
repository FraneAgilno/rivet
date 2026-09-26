import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { immutableJson } from '../clients/contract.js';
import { validateProjectConfiguration } from '../config/validate.js';
import { validateWorkRequest } from '../work-request/contract.js';
import { matchesClientProfile, matchesWorkerExecution } from './client-profile.js';

const schema = JSON.parse(readFileSync(new URL('../../schemas/feature-plan.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);
const plans = new WeakSet();
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CLIENTS = new Set(['claude', 'codex', 'host']);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const VIOLATIONS = Object.freeze({
  'owned-path-invalid': 'An owned path contains a reserved or non-normalized component.',
  'owned-path-protected': 'An owned path targets repository metadata or a protected project path.',
  'owned-path-duplicate': 'A work item contains owned paths that collide after case normalization.',
  'plan-schema-invalid': 'The compiled plan does not match the governed plan schema.',
  'plan-policy-invalid': 'The compiled plan violates the configured governance policy.',
});

export class FeaturePlanError extends Error {
  constructor(reason = 'invalid-plan', violation) {
    const messages = {
      'invalid-plan': 'Feature plan is invalid.',
      'decomposition-invalid': 'Planning provider returned an invalid feature decomposition.',
      'compiled-plan-invalid': 'Feature decomposition could not be compiled into a valid governed plan.',
    };
    const detail = Object.hasOwn(VIOLATIONS, violation) ? violation : undefined;
    super(`${messages[reason] ?? messages['invalid-plan']}${detail ? ` ${VIOLATIONS[detail]}` : ''}`);
    this.name = 'FeaturePlanError';
    this.code = 'ERR_INVALID_FEATURE_PLAN';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason, ...(detail ? { violation: detail } : {}) });
  }
}

function fail(violation = 'plan-policy-invalid') { throw new FeaturePlanError('invalid-plan', violation); }

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function safeSnapshot(value) {
  try { return immutableJson(value); } catch { fail(); }
}

function validateBindings(bindings) {
  try {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) fail();
    const keys = Reflect.ownKeys(bindings);
    if (keys.length !== 5 || keys.some(key => typeof key !== 'string'
      || !['proposal', 'config', 'workRequest', 'baselineCommit', 'client'].includes(key))) fail();
    validateProjectConfiguration(bindings.config);
    validateWorkRequest(bindings.workRequest);
    if (typeof bindings.baselineCommit !== 'string' || !GIT_OBJECT.test(bindings.baselineCommit)
      || !CLIENTS.has(bindings.client)) fail();
    return bindings;
  } catch (error) {
    if (error instanceof FeaturePlanError) throw error;
    fail();
  }
}

function safeOwnedPath(path, sensitivePaths) {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || WINDOWS_RESERVED.test(part))) fail('owned-path-invalid');
  const folded = parts.map(part => part.toLowerCase()).join('/');
  if (folded === '.git' || folded.startsWith('.git/') || folded === '.rivet' || folded.startsWith('.rivet/')
    || folded === '.rivet.cjs' || folded.startsWith('.rivet.cjs/')) fail('owned-path-protected');
  for (const pattern of sensitivePaths) {
    const prefix = pattern.replaceAll('\\', '/').split('*', 1)[0].replace(/\/$/, '').toLowerCase();
    if (folded === prefix || folded.startsWith(`${prefix}/`)) fail('owned-path-protected');
  }
  return folded;
}

function pathOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function visit(id, nodeMap, visiting, visited) {
  if (visited.has(id)) return;
  if (visiting.has(id)) fail();
  visiting.add(id);
  const node = nodeMap.get(id);
  for (const dependency of node.dependencies) visit(dependency, nodeMap, visiting, visited);
  visiting.delete(id);
  visited.add(id);
}

function dependsOn(node, targetId, nodeMap) {
  const pending = [...node.dependencies];
  const seen = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...nodeMap.get(id).dependencies);
  }
  return false;
}

function validatePlanSemantics(plan, { config, workRequest, baselineCommit, client }) {
  if (plan.baselineCommit !== baselineCommit || plan.workRequestDigest !== workRequest.digest || plan.client !== client
    || !matchesClientProfile(client, plan.clientProfile)) fail();
  if (client === 'host' && config.orchestration.roles.some(role => role.harness !== undefined)) fail();
  const configuredProviders = new Set(config.providers.providers.map(provider => provider.id));
  if (plan.providerRefs.some(provider => !configuredProviders.has(provider))) fail();
  const roles = new Map(config.orchestration.roles.map(role => [role.id, role]));
  const profiles = new Map(config.orchestration.completionProfiles.map(profile => [profile.id, profile]));
  const commands = new Set(Object.keys(config.project.commands));
  const qualityEvidence = new Set(config.quality.evidence.requiredTypes);
  const nodeMap = new Map();
  for (const node of plan.nodes) {
    if (nodeMap.has(node.id)) fail();
    nodeMap.set(node.id, node);
  }
  const roots = plan.nodes.filter(node => node.parentId === undefined);
  const activation = plan.nodes.filter(node => node.approvalGate === 'activation');
  const final = plan.nodes.filter(node => node.approvalGate === 'final-delivery');
  if (roots.length !== 1 || activation.length !== 1 || final.length !== 1 || roots[0] !== activation[0]
    || activation[0].role !== 'boss' || final[0].role !== 'boss' || final[0].parentId !== activation[0].id) fail();
  if (!['boss', 'manager', 'worker'].every(kind => plan.nodes.some(node => node.role === kind))) fail();

  const criteria = new Set(workRequest.acceptanceCriteria);
  const covered = new Set();
  const pathSets = new Map();
  for (const node of plan.nodes) {
    const role = roles.get(node.roleId);
    if (!role || role.kind !== node.role || node.dependencies.includes(node.id)) fail();
    if (!matchesWorkerExecution(role, node.execution)) fail();
    if (node !== roots[0] && (node.dependencies.length === 0 || !node.parentId)) fail();
    if (node.parentId && !nodeMap.has(node.parentId)) fail();
    if (node.dependencies.some(id => !nodeMap.has(id))) fail();
    if (node.authorityScopes.some(scope => !role.authorityScopes.includes(scope))) fail();
    if (node.commandIds.some(command => !commands.has(command))) fail();
    for (const name of ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']) {
      if (node.budget[name] > role.budget[name]) fail();
    }
    const profile = profiles.get(role.completionProfile);
    if (!profile || profile.requiredEvidence.some(type => !node.requiredEvidenceTypes.includes(type))
      || node.requiredEvidenceTypes.some(type => !qualityEvidence.has(type))) fail();
    if (node.approvalGate && !config.orchestration.approvalGates.includes(node.approvalGate)) fail();
    if ((node.approvalGate === 'activation' || node.approvalGate === 'final-delivery')
      && !node.requiredEvidenceTypes.includes('human-approval')) fail();
    if (node.authorityScopes.includes('external-write') && !role.permissions.externalWrites) fail();
    if (node.authorityScopes.includes('merge') && !role.permissions.merge) fail();
    if (node.authorityScopes.includes('deploy') && !role.permissions.deploy) fail();
    if (node.role === 'worker' && node.ownedPaths.length === 0) fail();
    if (node.role !== 'worker' && node.ownedPaths.length > 0) fail();
    const foldedPaths = node.ownedPaths.map(path => safeOwnedPath(path, config.project.repository.sensitivePaths ?? []));
    if (new Set(foldedPaths).size !== foldedPaths.length) fail('owned-path-duplicate');
    pathSets.set(node.id, foldedPaths);
    for (const criterion of node.acceptanceCriteria) {
      if (!criteria.has(criterion)) fail();
      if (node.role === 'worker') covered.add(criterion);
    }
    if (node.role === 'worker' && node.acceptanceCriteria.length === 0) fail();
  }
  if (covered.size !== criteria.size) fail();

  for (const node of plan.nodes) {
    if (!node.parentId) continue;
    const parent = nodeMap.get(node.parentId);
    const parentRole = roles.get(parent.roleId);
    const finalBoss = node === final[0] && parent === activation[0];
    if (!finalBoss && (!parentRole.canDelegate || !parentRole.delegatesTo.includes(node.role))) fail();
    if (node.authorityScopes.some(scope => !parent.authorityScopes.includes(scope))) fail();
    for (const name of ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']) {
      if (node.budget[name] > parent.budget[name]) fail();
    }
  }
  const visited = new Set();
  for (const node of plan.nodes) visit(node.id, nodeMap, new Set(), visited);

  const workers = plan.nodes.filter(node => node.role === 'worker');
  for (let leftIndex = 0; leftIndex < workers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workers.length; rightIndex += 1) {
      const left = workers[leftIndex];
      const right = workers[rightIndex];
      if (dependsOn(left, right.id, nodeMap) || dependsOn(right, left.id, nodeMap)) continue;
      if (pathSets.get(left.id).some(a => pathSets.get(right.id).some(b => pathOverlap(a, b)))) fail();
    }
  }
  const requiredCommands = config.quality.commandGates.filter(gate => gate.required).map(gate => gate.command);
  if (requiredCommands.some(command => !final[0].commandIds.includes(command))) fail();
}

export function createFeaturePlan(bindingsInput) {
  const bindings = validateBindings(bindingsInput);
  const proposal = safeSnapshot(bindings.proposal);
  if (!validateSchema(proposal)) fail('plan-schema-invalid');
  validatePlanSemantics(proposal, bindings);
  plans.add(proposal);
  return proposal;
}

export function validateFeaturePlan(value) {
  if (!plans.has(value)) fail();
  return value;
}

export function featurePlanDigest(value) {
  validateFeaturePlan(value);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
