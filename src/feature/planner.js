import { AgentContractError, immutableJson } from '../clients/contract.js';
import { validateProjectConfiguration } from '../config/validate.js';
import { validateWorkRequest } from '../work-request/contract.js';
import {
  FeatureDecompositionError,
  createFeatureDecomposition,
} from './decomposition-contract.js';
import {
  FeaturePlanError,
  createFeaturePlan,
  featurePlanDigest,
} from './plan-contract.js';
import { clientProfileFor } from './client-profile.js';

const MAX_PLANNING_ATTEMPTS = 2;
const REPAIRABLE_PATH_VIOLATIONS = new Set(['owned-path-invalid', 'owned-path-protected', 'owned-path-duplicate']);

function fail(reason) { throw new FeaturePlanError(reason); }

function slug(value, fallback = 'feature') {
  const normalized = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const candidate = /^[a-z]/.test(normalized) ? normalized : `${fallback}-${normalized}`;
  return (candidate || fallback).slice(0, 64).replace(/-+$/g, '') || fallback;
}

function uniqueNodeId(objective, used) {
  const base = slug(objective, 'work-item');
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, 64 - tail.length).replace(/-+$/g, '')}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function intersect(...values) {
  const [first = [], ...rest] = values;
  return first.filter(value => rest.every(items => items.includes(value)));
}

function boundedBudget(...roles) {
  return Object.freeze(Object.fromEntries(
    ['timeMinutes', 'tokenLimit', 'costUsd', 'taskLimit']
      .map(name => [name, Math.min(...roles.map(role => role.budget[name]))]),
  ));
}

function roleChain(config) {
  for (const boss of config.orchestration.roles.filter(role => role.kind === 'boss' && role.delegatesTo.includes('manager'))) {
    for (const manager of config.orchestration.roles.filter(role => role.kind === 'manager'
      && role.delegatesTo.includes('worker'))) {
      const worker = config.orchestration.roles.find(role => role.kind === 'worker');
      if (worker) return { boss, manager, worker };
    }
  }
  fail('compiled-plan-invalid');
}

function requiredEvidence(config, role, { humanApproval = false } = {}) {
  const profile = config.orchestration.completionProfiles.find(value => value.id === role.completionProfile);
  if (!profile) fail('compiled-plan-invalid');
  return [...new Set([...profile.requiredEvidence, ...(humanApproval ? ['human-approval'] : [])])];
}

function compileFeaturePlan({ decomposition, config, workRequest, baselineCommit, client }) {
  const { boss, manager, worker } = roleChain(config);
  const managerScopes = intersect(manager.authorityScopes, boss.authorityScopes);
  const workerScopes = intersect(worker.authorityScopes, managerScopes);
  if (managerScopes.length === 0 || workerScopes.length === 0) fail('compiled-plan-invalid');
  const configuredProviders = new Set(config.providers.providers.map(provider => provider.id));
  const providerRefs = intersect(boss.providerRefs, manager.providerRefs, worker.providerRefs)
    .filter(provider => configuredProviders.has(provider));
  const commandIds = config.quality.commandGates.filter(gate => gate.required).map(gate => gate.command);
  const used = new Set(['activation', 'management', 'final-delivery']);
  const workers = decomposition.workItems.map(item => ({
    id: uniqueNodeId(item.objective, used),
    parentId: 'management',
    role: 'worker',
    roleId: worker.id,
    objective: item.objective,
    dependencies: ['management'],
    ownedPaths: item.ownedPaths,
    authorityScopes: workerScopes,
    commandIds,
    budget: boundedBudget(boss, manager, worker),
    requiredEvidenceTypes: requiredEvidence(config, worker),
    acceptanceCriteria: item.acceptanceCriterionIndexes.map(criterionIndex => (
      workRequest.acceptanceCriteria[criterionIndex - 1]
    )),
    status: 'proposed',
  }));
  for (let index = 1; index < workers.length; index += 1) {
    workers[index].dependencies = [workers[index - 1].id];
  }
  const finalScopes = boss.authorityScopes.includes('verify') ? ['verify'] : [boss.authorityScopes[0]];
  const clientProfile = clientProfileFor(client);
  return {
    schemaVersion: 1,
    id: slug(workRequest.title),
    baselineCommit,
    workRequestDigest: workRequest.digest,
    client,
    ...(clientProfile === undefined ? {} : { clientProfile }),
    providerRefs,
    nodes: [
      {
        id: 'activation', role: 'boss', roleId: boss.id, objective: 'Approve the exact feature plan.',
        dependencies: [], ownedPaths: [], authorityScopes: boss.authorityScopes, commandIds: [],
        budget: boundedBudget(boss), requiredEvidenceTypes: requiredEvidence(config, boss, { humanApproval: true }),
        acceptanceCriteria: [], status: 'proposed', approvalGate: 'activation',
      },
      {
        id: 'management', parentId: 'activation', role: 'manager', roleId: manager.id,
        objective: 'Coordinate implementation and verification.', dependencies: ['activation'], ownedPaths: [],
        authorityScopes: managerScopes, commandIds: [], budget: boundedBudget(boss, manager),
        requiredEvidenceTypes: requiredEvidence(config, manager), acceptanceCriteria: [], status: 'proposed',
      },
      ...workers,
      {
        id: 'final-delivery', parentId: 'activation', role: 'boss', roleId: boss.id,
        objective: 'Review evidence and approve final delivery.', dependencies: workers.map(node => node.id),
        ownedPaths: [], authorityScopes: finalScopes, commandIds,
        budget: boundedBudget(boss), requiredEvidenceTypes: requiredEvidence(config, boss, { humanApproval: true }),
        acceptanceCriteria: [], status: 'proposed', approvalGate: 'final-delivery',
      },
    ],
  };
}

function planningContract({ config, workRequest, baselineCommit, client }) {
  return immutableJson({
    schemaVersion: 1,
    baselineCommit,
    client,
    workRequest,
    policy: {
      projectId: config.project.id,
      defaultBranch: config.project.repository.defaultBranch,
      branchPattern: config.project.repository.branchPattern,
      sensitivePaths: config.project.repository.sensitivePaths ?? [],
      commands: config.project.commands,
      providers: config.providers.providers.map(provider => ({
        id: provider.id, kind: provider.kind, mode: provider.mode, capabilities: provider.capabilities,
      })),
      roles: config.orchestration.roles.map(role => ({
        id: role.id, kind: role.kind, delegatesTo: role.delegatesTo, providerRefs: role.providerRefs,
        authorityScopes: role.authorityScopes, permissions: role.permissions, budget: role.budget,
        completionProfile: role.completionProfile,
      })),
      approvalGates: config.orchestration.approvalGates,
      completionProfiles: config.orchestration.completionProfiles,
      quality: {
        commandGates: config.quality.commandGates,
        evidence: config.quality.evidence,
      },
    },
  });
}

function parseProposal(value) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value) > 512 * 1024) fail();
  try { return JSON.parse(value); } catch { fail(); }
}

export function createFeaturePlanner(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, 'planningClient')
      || !input.planningClient || typeof input.planningClient !== 'object'
      || typeof input.planningClient.propose !== 'function') fail();
  } catch (error) {
    if (error instanceof FeaturePlanError) throw error;
    fail();
  }
  const planningClient = input.planningClient;
  return Object.freeze({
    async propose(request) {
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request)
          || Reflect.ownKeys(request).length !== 4
          || !['config', 'workRequest', 'baselineCommit', 'client'].every(key => Object.hasOwn(request, key))) fail();
        validateProjectConfiguration(request.config);
        validateWorkRequest(request.workRequest);
        const contract = planningContract(request);
        let repair;
        // At most two read-only provider calls; never retry provider or policy failures.
        for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
          const payload = repair ? immutableJson({ ...contract, repair }) : contract;
          const proposal = parseProposal(await planningClient.propose(payload));
          let decomposition;
          try {
            decomposition = createFeatureDecomposition(proposal, request.workRequest.acceptanceCriteria.length);
          } catch (error) {
            if (error instanceof FeatureDecompositionError) fail('decomposition-invalid');
            throw error;
          }
          const compiled = compileFeaturePlan({ decomposition, ...request });
          try { return createFeaturePlan({ proposal: compiled, ...request }); }
          catch (error) {
            if (!(error instanceof FeaturePlanError)) throw error;
            const violation = error.details.violation;
            if (attempt < MAX_PLANNING_ATTEMPTS && REPAIRABLE_PATH_VIOLATIONS.has(violation)) {
              repair = { attempt: attempt + 1, reason: violation };
              continue;
            }
            throw new FeaturePlanError('compiled-plan-invalid', violation);
          }
        }
      } catch (error) {
        if (error instanceof FeaturePlanError || error instanceof AgentContractError) throw error;
        fail();
      }
    },
  });
}

export { FeaturePlanError, featurePlanDigest };
