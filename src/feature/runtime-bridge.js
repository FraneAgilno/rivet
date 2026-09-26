import {assertSelectedProtocolRefs, selectedProtocolStatus} from '../protocols/project.js';
import {createProtocolPresentation} from '../protocols/presentation.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { immutableJson } from '../clients/contract.js';
import { loadProjectConfig } from '../config/load.js';
import { compileQualitySteps } from '../config/commands.js';
import { validateProjectConfiguration } from '../config/validate.js';
import { prepareIntegrationWorktree } from '../git/integration-worktree.js';
import { reconcileWorktree } from '../git/reconcile.js';
import { createAcceptedIntegrationStore } from './accepted-integration.js';
import { createVerificationReportStore, verificationReport } from './verification-report.js';
import { acceptedIntegrationPaths, resolveFeatureRunPaths, resolveStatePaths, verificationReportPaths } from '../state/paths.js';
import { createReservationStore } from '../git/reservations.js';
import { createReservedWorktree, verifyReservedWorktree } from '../git/worktrees.js';
import { validatedGraphSnapshot } from '../graph/validate.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { buildLaunchContract, validateLaunchPayload } from '../prompts/launch-contract.js';
import { runQualityGates } from '../quality/runner.js';
import { createRuntimeInstance } from '../runtime/instance-store.js';
import { createOrchestrator } from '../runtime/orchestrator.js';
import { bootstrapWorktreeDependencies, inspectWorktreeDependencies, WorktreeBootstrapError } from '../runtime/worktree-bootstrap.js';
import { validateWorkRequest } from '../work-request/contract.js';
import { createFeaturePlan, featurePlanDigest } from './plan-contract.js';
import { executionForNode } from './client-profile.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class FeatureRuntimeBridgeError extends Error {
  constructor() {
    super('Feature runtime bridge input is invalid.');
    this.name = 'FeatureRuntimeBridgeError';
    this.code = 'ERR_FEATURE_RUNTIME_BRIDGE';
    this.safeMessage = this.message;
  }
}

function fail() { throw new FeatureRuntimeBridgeError(); }

function captureInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('config') || !keys.includes('run')) fail();
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof FeatureRuntimeBridgeError) throw error;
    fail();
  }
}

function captureRun(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
    const allowed = new Set([
      'schemaVersion',
      'runId', 'status', 'workRequest', 'featurePlan', 'proposalDigest', 'tracker', 'activation',
      'runtimeRefs', 'evidenceRefs', 'createdAt', 'updatedAt', 'version',
    ]);
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || !['runId', 'workRequest', 'featurePlan', 'proposalDigest', 'activation'].every(key => keys.includes(key))) fail();
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof FeatureRuntimeBridgeError) throw error;
    fail();
  }
}

function validRun(config, input) {
  const run = captureRun(input);
  let featurePlan;
  try {
    validateProjectConfiguration(config);
    validateWorkRequest(run.workRequest);
    featurePlan = createFeaturePlan({
      proposal: run.featurePlan,
      config,
      workRequest: run.workRequest,
      baselineCommit: run.featurePlan?.baselineCommit,
      client: run.featurePlan?.client,
    });
  } catch { fail(); }
  const validated = Object.freeze({ ...run, featurePlan });
  if ((validated.schemaVersion !== undefined && validated.schemaVersion !== 1)
    || typeof validated.runId !== 'string' || validated.runId.length > 64 || !ID.test(validated.runId)
    || !['claude', 'codex', 'host'].includes(validated.featurePlan.client)
    || validated.featurePlan.workRequestDigest !== validated.workRequest.digest
    || typeof validated.proposalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(validated.proposalDigest)
    || featurePlanDigest(validated.featurePlan) !== validated.proposalDigest
    || !validated.activation || typeof validated.activation !== 'object' || Array.isArray(validated.activation)
    || validated.activation.requestDigest !== validated.workRequest.digest
    || validated.activation.proposalDigest !== validated.proposalDigest) fail();
  const roles = new Map(config.orchestration.roles.map(role => [role.id, role]));
  const commands = new Set(Object.keys(config.project.commands));
  for (const node of validated.featurePlan.nodes) {
    const role = roles.get(node.roleId);
    if (!role || role.kind !== node.role
      || node.authorityScopes.some(scope => !role.authorityScopes.includes(scope))
      || node.commandIds.some(command => !commands.has(command))
      || node.budget.timeMinutes > role.budget.timeMinutes
      || node.budget.tokenLimit > role.budget.tokenLimit
      || node.budget.costUsd > role.budget.costUsd
      || node.budget.taskLimit > role.budget.taskLimit) fail();
  }
  return validated;
}

function evidenceRefs(node) {
  const digest = createHash('sha256').update(node.id).digest('hex').slice(0, 40);
  return node.requiredEvidenceTypes.map((type, index) => {
    const direct = `${node.id}-${type}-${index + 1}`;
    return direct.length <= 64 ? direct : `e-${digest}-${type}-${index + 1}`;
  });
}

function runtimeNode(node, role) {
  let status = 'ready';
  if (node.approvalGate === 'activation' || node.role === 'manager') status = 'completed';
  return {
    id: node.id,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    objective: node.objective,
    owner: { role: node.role, id: node.roleId },
    dependencies: node.dependencies,
    authorityScopes: node.authorityScopes,
    budget: node.budget,
    completionProfile: role.completionProfile,
    requiredEvidenceTypes: node.requiredEvidenceTypes,
    evidenceRefs: evidenceRefs(node),
    status,
    ...(node.approvalGate === undefined ? {} : { approvalGate: node.approvalGate }),
  };
}

export function createFeatureRuntimeState(input) {
  const value = captureInput(input);
  const run = validRun(value.config, value.run);
  const roles = new Map(value.config.orchestration.roles.map(role => [role.id, role]));
  const graph = validatedGraphSnapshot({
    schemaVersion: 1,
    id: run.featurePlan.id,
    goal: run.workRequest.title,
    providerRefs: run.featurePlan.providerRefs,
    maxDelegationDepth: value.config.orchestration.maxDelegationDepth,
    status: 'approved',
    nodes: run.featurePlan.nodes.map(node => runtimeNode(node, roles.get(node.roleId))),
  });
  const rootBudget = run.featurePlan.nodes.find(node => node.approvalGate === 'activation')?.budget;
  if (!rootBudget) fail();
  return immutableJson({
    schemaVersion: 1,
    version: 0,
    activated: false,
    terminal: null,
    graph,
    events: [],
    attempts: {},
    launchIntents: {},
    results: {},
    heartbeats: {},
    evidence: [],
    usage: { tokens: 0, costUsd: '0', retries: 0, timeMinutes: 0, taskLimit: 0 },
    limits: { ...rootBudget, retries: 2 },
  }, 'invalid-contract');
}

export function createFeatureRuntimeControls({ run: runInput, nowMs }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail();
  const run = captureRun(runInput);
  if (!run.activation || typeof run.activation.approverId !== 'string'
    || !ID.test(run.activation.approverId) || run.activation.proposalDigest !== run.proposalDigest) fail();
  const activation = run.featurePlan?.nodes?.find(node => node.approvalGate === 'activation');
  if (!activation || activation.role !== 'boss') fail();
  const expectedApproverId = run.activation.approverId;
  const registry = createApprovalRegistry({ approvers: [{ id: expectedApproverId, principal: 'human' }] });
  const receipt = createApprovalReceipt({
    id: `activation-${run.runId}`.slice(0, 64).replace(/-+$/, ''),
    approverId: expectedApproverId,
    approverPrincipal: 'human',
    subjectId: activation.roleId,
    action: 'activation',
    resource: run.runId,
    policyId: 'authority.human-gate.activation',
    decision: 'approved',
    expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
    singleUse: true,
  });
  const authority = createAuthorityEnvelope({
    actorId: activation.roleId,
    principal: 'agent',
    role: 'boss',
    actions: ['activation'],
    ownedPaths: [],
    providers: [],
    commands: [],
  });
  return Object.freeze({ receipt, registry, authority, expectedApproverId });
}

function captureEnvironment(value) {
  if (value === undefined) return Object.freeze(Object.create(null));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(); }
  if (keys.length > 512 || keys.some(key => typeof key !== 'string')) fail();
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) fail();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function captureExecutor(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
    const allowed = new Set(['gitClient', 'clientFor', 'resolveCommandExecutable', 'now', 'environment']);
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail();
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      result[key] = descriptor.value;
    }
    if (!result.gitClient || typeof result.gitClient.inspectRepository !== 'function'
      || typeof result.clientFor !== 'function' || typeof result.resolveCommandExecutable !== 'function'
      || typeof result.now !== 'function') fail();
    result.environment = captureEnvironment(result.environment);
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof FeatureRuntimeBridgeError) throw error;
    fail();
  }
}

export function featureBranchFor(config, plan, runId) {
  const pattern = config.project.repository.branchPattern;
  if (typeof pattern !== 'string' || pattern.split('{slug}').length !== 2) fail();
  if (typeof runId !== 'string' || !ID.test(runId)) fail();
  return pattern.replace('{slug}', `${plan.id}-${runId}`);
}

export function featureNowMilliseconds(now) {
  let value;
  try { value = now(); } catch { fail(); }
  const milliseconds = Date.parse(value);
  if (typeof value !== 'string' || !Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail();
  return milliseconds;
}

export async function inspectFeatureRuntime(instance) {
  const lock = await instance.acquire();
  try { return await instance.read(); } finally { await lock.release(); }
}

export async function prepareFeatureWorkerParent(worktreeRunRoot) {
  const path = join(worktreeRunRoot, 'workers');
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) fail();
  return path;
}

function exactStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const first = [...left].sort();
  const second = [...right].sort();
  return first.every((value, index) => value === second[index]);
}

function responsibilityStrings(responsibilities) {
  if (!Array.isArray(responsibilities)) fail();
  return responsibilities.map(scope => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || typeof scope.path !== 'string' || typeof scope.directory !== 'boolean') fail();
    return `${scope.path}${scope.directory ? '/' : ''}`;
  });
}

function pathWithinResponsibilities(responsibilities, path) {
  return responsibilities.some(scope => (
    scope.path === path || (scope.directory && path.startsWith(`${scope.path}/`))
  ));
}

export async function reusableWorkerCheckout(input) {
  const {
    gitClient, projectRoot, statePaths, node, planNode, branch, worktreePath,
    baseSha, nowMs, expectedWorktree,
  } = input;
  const reservations = await createReservationStore(statePaths).list();
  const matches = reservations.reservations.filter(item => (
    item.nodeId === node.id && item.ownerId === node.owner.id && item.status === 'active'
  ));
  if (matches.length !== 1) fail();
  const reservation = matches[0];
  if (reservation.branch !== branch || reservation.worktreePath !== worktreePath
    || reservation.baseSha !== baseSha || Date.parse(reservation.expiresAt) <= nowMs
    || !exactStrings(responsibilityStrings(reservation.responsibilities), planNode.ownedPaths)
    || !exactStrings(reservation.intendedPaths, planNode.ownedPaths)) fail();
  const verified = await verifyReservedWorktree({
    projectRoot,
    statePaths,
    nodeId: node.id,
    ownerId: node.owner.id,
    leaseId: reservation.leaseId,
  }, { gitClient, nowMs });
  if (expectedWorktree && (verified.worker.root !== expectedWorktree.path
    || verified.worker.rootIdentity.dev !== expectedWorktree.dev
    || verified.worker.rootIdentity.ino !== expectedWorktree.ino)) fail();
  if (!(await gitClient.isAncestor(
    verified.worker.root,
    reservation.baseSha,
    verified.worker.headSha,
  ))) fail();
  const committedPaths = await gitClient.changedPaths(
    verified.worker.root,
    reservation.baseSha,
    verified.worker.headSha,
  );
  const uncommittedPaths = await gitClient.statusPaths(verified.worker.root);
  if ([...committedPaths, ...uncommittedPaths]
    .some(path => !pathWithinResponsibilities(reservation.responsibilities, path))) fail();
  return Object.freeze({ reservation, worker: verified.worker });
}

export async function finalizeFeatureWorkerCommit(input) {
  const {
    gitClient, statePaths, node, planNode, leaseId, nowMs,
  } = input;
  const verified = await verifyReservedWorktree({
    projectRoot: input.projectRoot,
    statePaths,
    nodeId: node.id,
    ownerId: node.owner.id,
    leaseId,
  }, { gitClient, nowMs });
  const committedPaths = await gitClient.changedPaths(
    verified.worker.root,
    verified.reservation.baseSha,
    verified.worker.headSha,
  );
  const uncommittedPaths = await gitClient.statusPaths(verified.worker.root);
  const allChangedPaths = [...new Set([...committedPaths, ...uncommittedPaths])];
  if (allChangedPaths.some(path => !pathWithinResponsibilities(verified.reservation.responsibilities, path))) return;
  if (uncommittedPaths.length === 0) return;
  await gitClient.commitPaths(verified.worker.root, {
    paths: planNode.ownedPaths,
    expectedHeadSha: verified.worker.headSha,
    branch: verified.reservation.branch,
    message: `rivet: complete ${node.id}`,
  });
}

async function recoverBlockedWorker(input) {
  const {
    state, runtime, instance, gitClient, integration, statePaths, planNodes,
    parent, run, nowMs, recoveryWorktrees,
  } = input;
  if (state.terminal !== 'blocked' || state.graph.status !== 'blocked') fail();
  const candidates = state.graph.nodes.filter(node => node.owner.role === 'worker'
    && !node.approvalGate && node.status === 'blocked');
  if (candidates.length !== 1) fail();
  const node = candidates[0];
  const intent = state.launchIntents[node.id];
  const planNode = planNodes.get(node.id);
  const manager = state.graph.nodes.find(item => item.id === node.parentId);
  if (!intent || intent.status !== 'complete'
    || (!intent.worktree && Object.hasOwn(intent, 'startedAtMs')) || !planNode
    || planNode.role !== 'worker' || !manager || manager.owner.role !== 'manager'
    || state.evidence.some(item => item.nodeId === node.id)) fail();
  const current = await gitClient.inspectRepository(integration.path);
  if (current.branch !== integration.branch || current.dirty) fail();
  const reused = await reusableWorkerCheckout({
    gitClient,
    projectRoot: integration.path,
    statePaths,
    node,
    planNode,
    branch: `worker/${run.runId}/${node.id}`,
    worktreePath: join(parent, node.id),
    baseSha: current.headSha,
    nowMs,
    expectedWorktree: intent.worktree,
  });
  if (intent.worktree) recoveryWorktrees.set(node.id, intent.worktree);
  const authority = createAuthorityEnvelope({
    actorId: manager.owner.id,
    principal: 'agent',
    role: 'manager',
    actions: ['orchestration.retry'],
    ownedPaths: [],
    providers: [],
    commands: [],
  });
  const recovered = await runtime.retryNode(instance, {
    expectedVersion: state.version,
    nodeId: node.id,
    authority,
    reason: 'explicit-feature-resume',
    nowMs,
  });
  return Object.freeze({ state: recovered, leaseId: reused.reservation.leaseId, nodeId: node.id });
}

export function createFeatureLaunchInput(node, intent, planNode, run) {
  const approvedCost = Number(intent.allocation.costUsd);
  const { clientProfile } = executionForNode(run.featurePlan, planNode);
  const maxCostUsd = clientProfile === undefined
    ? approvedCost
    : Math.min(approvedCost, clientProfile.execution.maxCostUsd);
  return {
    nodeId: node.id,
    parentId: node.parentId ?? null,
    objective: `${planNode.objective}\n\nExecution protocol: implement the objective only within the sealed owned paths. The trusted host will validate scope and create the local commit after a successful result, so do not block or return retry merely because you cannot create a Git commit yourself. Return status success only after the implementation and required checks are complete, with exactly the declared evidence references.`,
    ownedPaths: planNode.ownedPaths,
    authority: { actions: planNode.authorityScopes, providers: run.featurePlan.providerRefs },
    commands: planNode.commandIds,
    evidence: node.evidenceRefs,
    budget: {
      maxTokens: intent.allocation.tokenLimit,
      maxRuntimeMs: intent.allocation.timeMinutes * 60_000,
      maxCostUsd,
    },
    worktree: intent.worktree,
    contextRefs: [
      `request:${run.workRequest.digest}`,
      ...run.workRequest.contextRefs.filter(ref => ref.startsWith('protocol:')),
    ],
    heartbeatInterval: 60_000,
    stopConditions: ['objective-complete', 'commit-created', 'evidence-ready'],
  };
}

export async function configuredFeatureGates(config, resolveCommandExecutable) {
  const gates = [];
  for (const configured of compileQualitySteps(config)) {
    gates.push(Object.freeze({
      id: configured.id,
      executable: await resolveCommandExecutable(configured.argv[0]),
      args: Object.freeze(configured.argv.slice(1)),
      cwd: configured.cwd,
      packageScript: Object.freeze({ runner: configured.argv[0], script: configured.argv[2] }),
      required: configured.required,
      artifactPaths: Object.freeze([]),
      tests: Object.freeze([]),
    }));
  }
  return Object.freeze(gates);
}

export function featureQualityAuthority(config) {
  const commandIds = compileQualitySteps(config).map(step => step.id);
  return createAuthorityEnvelope({
    actorId: 'quality-worker',
    principal: 'agent',
    role: 'worker',
    actions: commandIds.map(id => `command.${id}`),
    ownedPaths: [],
    providers: [],
    commands: commandIds,
  });
}

function blocked(run, state, summary = 'Feature execution is blocked and can be resumed after the reported condition is corrected.') {
  return immutableJson({
    status: 'blocked',
    summary,
    runtimeRefs: [`runtime:${run.runId}`],
    evidenceRefs: (state?.evidence ?? []).map(item => `evidence:${item.id}`),
  });
}

export function createFeatureExecutor(input) {
  const configured = captureExecutor(input);
  return async function executeFeature(request, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Reflect.ownKeys(options).some(key => !['signal', 'confirmDependencyInstall'].includes(key))
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      || (options.confirmDependencyInstall !== undefined && typeof options.confirmDependencyInstall !== 'function')) fail();
    const signal = options.signal;
    if (signal?.aborted) fail();
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Reflect.ownKeys(request).length !== 2 || !Object.hasOwn(request, 'project') || !Object.hasOwn(request, 'run')) fail();
    const project = request.project;
    if (typeof project !== 'string') fail();
    const repository = await configured.gitClient.inspectRepository(project).catch(() => fail());
    const config = await loadProjectConfig(project).catch(() => fail());
    const run = validRun(config, request.run);
    assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
    const protocolRecovery = () => selectedProtocolStatus(project, run.workRequest.contextRefs).message;
    if (run.featurePlan.client === 'host') fail();
    if (repository.root !== project || repository.detached || repository.dirty
      || repository.branch !== config.project.repository.defaultBranch
      || repository.headSha !== run.featurePlan.baselineCommit) fail();
    // Only select adapters after the saved approval and current role configuration
    // are validated. Probe before creating integration or worker checkouts.
    const selectedClients = new Map();
    for (const planNode of run.featurePlan.nodes.filter(node => node.role === 'worker')) {
      const execution = executionForNode(run.featurePlan, planNode);
      if (!selectedClients.has(execution.client)) {
        const selected = await configured.clientFor(execution.client, execution.clientProfile, { project, signal });
        if (!selected || selected.provider !== execution.client || typeof selected.launch !== 'function') fail();
        selectedClients.set(execution.client, selected);
      }
    }

    async function prepareDependencies(worker, branch, expectedCommit) {
      const input = {
        projectRoot: project, worktreePath: worker.root, expectedCommit,
        expectedBranch: branch, manager: config.project.stack.packageManager,
      };
      try {
        await inspectWorktreeDependencies(input, { gitClient: configured.gitClient });
      } catch (error) {
        if (error instanceof WorktreeBootstrapError && error.details.reason === 'missing-lockfile') return;
        throw error;
      }
      if (!options.confirmDependencyInstall) throw new WorktreeBootstrapError('approval-required');
      const installed = await bootstrapWorktreeDependencies(input, {
        gitClient: configured.gitClient,
        resolveCommandExecutable: configured.resolveCommandExecutable,
        confirm: options.confirmDependencyInstall,
        signal,
      });
      if (installed.status === 'declined') throw new WorktreeBootstrapError('approval-declined');
      if (installed.status !== 'ready') throw new WorktreeBootstrapError('install-failed');
    }

    const statePaths = await resolveStatePaths(project, run.runId);
    const integrationBranch = featureBranchFor(config, run.featurePlan, run.runId);
    const worktreeRunRoot = join(dirname(project), '.rivet-worktrees', repository.repositoryId, basename(statePaths.instanceDir));
    const integration = await prepareIntegrationWorktree({
      projectRoot: project,
      statePaths,
      branch: integrationBranch,
      worktreePath: join(worktreeRunRoot, 'integration'),
      baseSha: run.featurePlan.baselineCommit,
    }, { gitClient: configured.gitClient });
    const instance = createRuntimeInstance({
      id: run.runId,
      paths: statePaths,
      initialState: createFeatureRuntimeState({ config, run }),
    });
    const planNodes = new Map(run.featurePlan.nodes.map(node => [node.id, node]));
    const parent = await prepareFeatureWorkerParent(worktreeRunRoot);
    const nowMs = () => featureNowMilliseconds(configured.now);
    let preparationReason = null;
    let executionReason = null;
    let reconciliationReason = null;
    let reconciledTip = null;
    const leases = new Map();
    const recoveryWorktrees = new Map();
    const client = Object.freeze({
      provider: run.featurePlan.client,
      async launch(contract, options) {
        try {
          const payload = validateLaunchPayload(buildLaunchContract(contract));
          const planNode = planNodes.get(payload.nodeId);
          if (!planNode || planNode.role !== 'worker') fail();
          const execution = executionForNode(run.featurePlan, planNode);
          const selected = selectedClients.get(execution.client);
          if (!selected) fail();
          const { version, ...sealedInput } = payload;
          const protocolContext = run.workRequest.contextRefs.some(ref => ref.startsWith('protocol:'))
            ? createProtocolPresentation({sourceRoot: project, refs: run.workRequest.contextRefs}) : undefined;
          return await selected.launch(sealedInput, {...options, ...(protocolContext ? {protocolContext} : {})});
        }
        catch (error) {
          const detail = typeof error?.details?.reason === 'string' ? `:${error.details.reason}` : '';
          executionReason = typeof error?.code === 'string' ? `${error.code}${detail}` : 'worker-execution-error';
          throw error;
        }
      },
    });
    const runtime = createOrchestrator({
      client,
      now: nowMs,
      async prepareWorktree(node, intent) {
        try {
          const planNode = planNodes.get(node.id);
          if (!planNode || planNode.role !== 'worker') fail();
          const current = await configured.gitClient.inspectRepository(integration.path);
          if (current.branch !== integration.branch || current.dirty) fail();
          const branch = `worker/${run.runId}/${node.id}`;
          const worktreePath = join(parent, node.id);
          if (intent.attempt > 1) {
            const reused = await reusableWorkerCheckout({
              gitClient: configured.gitClient,
              projectRoot: integration.path,
              statePaths,
              node,
              planNode,
              branch,
              worktreePath,
              baseSha: current.headSha,
              nowMs: nowMs(),
              expectedWorktree: recoveryWorktrees.get(node.id),
            });
            leases.set(node.id, reused.reservation.leaseId);
            if (!recoveryWorktrees.has(node.id)) await prepareDependencies(reused.worker, branch, current.headSha);
            preparationReason = null;
            return Object.freeze({
              path: reused.worker.root,
              dev: reused.worker.rootIdentity.dev,
              ino: reused.worker.rootIdentity.ino,
              reservationId: node.id === intent.nodeId ? intent.reservationId : fail(),
            });
          }
          const created = await createReservedWorktree({
            projectRoot: integration.path,
            statePaths,
            nodeId: node.id,
            branch,
            worktreePath,
            ownerId: node.owner.id,
            baseSha: current.headSha,
            responsibilities: planNode.ownedPaths,
            intendedPaths: planNode.ownedPaths,
            expiresAt: new Date(nowMs() + 24 * 60 * 60 * 1000).toISOString(),
          }, { gitClient: configured.gitClient, nowMs: nowMs() });
          const worker = await configured.gitClient.inspectRepository(created.reservation.worktreePath);
          leases.set(node.id, created.reservation.leaseId);
          await prepareDependencies(worker, branch, current.headSha);
          preparationReason = null;
          return Object.freeze({
            path: worker.root,
            dev: worker.rootIdentity.dev,
            ino: worker.rootIdentity.ino,
            reservationId: node.id === intent.nodeId ? intent.reservationId : fail(),
          });
        } catch (error) {
          preparationReason = typeof error?.code === 'string' ? error.code : 'worktree-preparation-error';
          throw error;
        }
      },
      launchFor(node, intent) {
        try {
          const source = createFeatureLaunchInput(node, intent, planNodes.get(node.id), run);
          buildLaunchContract(source);
          return source;
        } catch (error) {
          executionReason = typeof error?.code === 'string' ? error.code : 'launch-contract-error';
          throw error;
        }
      },
      async reconcile(node, intent, result) {
        try {
          assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
          let leaseId = leases.get(node.id);
          if (leaseId === undefined) {
            const reservations = await createReservationStore(statePaths).list();
            const matches = reservations.reservations.filter(item => item.nodeId === node.id
              && item.ownerId === node.owner.id && item.status === 'active');
            if (matches.length !== 1) fail();
            leaseId = matches[0].leaseId;
          }
          const evidenceMatches = result.status !== 'success' || exactStrings(result.output?.evidence, node.evidenceRefs);
          if (result.status === 'success') {
            await finalizeFeatureWorkerCommit({
              gitClient: configured.gitClient,
              projectRoot: integration.path,
              statePaths,
              node,
              planNode: planNodes.get(node.id),
              leaseId,
              nowMs: nowMs(),
            });
          }
          const report = await reconcileWorktree({
            projectRoot: integration.path,
            statePaths,
            nodeId: node.id,
            ownerId: node.owner.id,
            leaseId,
            integrationBranch: integration.branch,
            integrate: evidenceMatches,
          }, { gitClient: configured.gitClient, nowMs: nowMs() });
          if (!evidenceMatches) {
            reconciliationReason = 'result-evidence-mismatch';
            return Object.freeze({ ...report, status: 'blocked', reason: 'result-evidence-mismatch' });
          }
          reconciliationReason = report.status === 'integrated' ? null : report.reason ?? 'reconciliation-blocked';
          if (report.status === 'integrated') reconciledTip = report.integrationTip;
          return report;
        } catch (error) {
          reconciliationReason = typeof error?.code === 'string' ? error.code : 'reconciliation-error';
          throw error;
        }
      },
    });

    let state = await inspectFeatureRuntime(instance);
    try {
      if (!state.activated) {
        state = await runtime.activate(instance, {
          expectedVersion: state.version,
          ...createFeatureRuntimeControls({ run, nowMs: nowMs() }),
        });
      }
      if (state.terminal === 'blocked') {
        const recovered = await recoverBlockedWorker({
          state,
          runtime,
          instance,
          gitClient: configured.gitClient,
          integration,
          statePaths,
          planNodes,
          parent,
          run,
          nowMs: nowMs(),
          recoveryWorktrees,
        });
        leases.set(recovered.nodeId, recovered.leaseId);
        state = recovered.state;
      }
      const maximumTicks = run.featurePlan.nodes.length * 4 + 8;
      for (let tick = 0; tick < maximumTicks; tick += 1) {
        const outcome = await runtime.tick(instance, { expectedVersion: state.version, maxActiveNodes: 1, signal });
        state = await inspectFeatureRuntime(instance);
        if (['blocked', 'failed', 'budget-exhausted', 'cancelled'].includes(outcome.terminal)) {
          const stopped = state.graph.nodes.filter(node => ['blocked', 'failed', 'cancelled'].includes(node.status)).map(node => node.id);
          const preparation = preparationReason ? ` Preparation reason: ${preparationReason}.` : '';
          const execution = executionReason ? ` Execution reason: ${executionReason}.` : '';
          const reconciliation = reconciliationReason ? ` Reconciliation reason: ${reconciliationReason}.` : '';
          return blocked(run, state, protocolRecovery() ?? `Runtime stopped at ${outcome.terminal}${stopped.length ? ` (${stopped.join(', ')})` : ''}.${preparation}${execution}${reconciliation} Correct the reported condition and resume the feature run.`);
        }
        const finalNode = state.graph.nodes.find(node => node.approvalGate === 'final-delivery');
        const nonHumanComplete = state.graph.nodes
          .filter(node => !node.approvalGate)
          .every(node => ['completed', 'archived'].includes(node.status));
        if (outcome.launched.length === 0 && nonHumanComplete && finalNode?.status === 'ready') break;
        if (outcome.launched.length === 0) return blocked(run, state);
      }
    } catch (error) {
      state = await inspectFeatureRuntime(instance).catch(() => state);
      const reason = typeof error?.code === 'string' ? ` Runtime reason: ${error.code}.` : '';
      return blocked(run, state, protocolRecovery() ?? `Feature execution stopped safely.${reason} Correct the reported condition and resume the feature run.`);
    }

    if (signal?.aborted) return blocked(run, state, 'Feature execution was interrupted. Inspect the run before resuming.');

    const integrated = await configured.gitClient.inspectRepository(integration.path);
    if (integrated.dirty || integrated.branch !== integration.branch) return blocked(run, state);
    const featurePaths = await resolveFeatureRunPaths(project, run.runId);
    const accepted = createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths));
    let identity = await accepted.readOnly();
    if (reconciledTip !== null) {
      if (integrated.headSha !== reconciledTip) return blocked(run, state, 'Integration changed after Worker reconciliation. A new reviewed proposal is required.');
      identity = await accepted.write({
        schemaVersion: 1, runId: run.runId,
        baselineCommit: run.featurePlan.baselineCommit,
        commitSha: reconciledTip,
        runtimeVersion: state.version,
        path: integration.path, branch: integration.branch,
      });
    }
    if (identity === null || identity.runId !== run.runId
      || identity.baselineCommit !== run.featurePlan.baselineCommit
      || identity.path !== integration.path || identity.branch !== integration.branch
      || identity.runtimeVersion > state.version || identity.commitSha !== integrated.headSha
      || identity.commitSha === run.featurePlan.baselineCommit
      || !(await configured.gitClient.isAncestor(integration.path, run.featurePlan.baselineCommit, identity.commitSha))) {
      return blocked(run, state, 'Integration does not match the accepted Worker commit. A new reviewed proposal is required.');
    }
    const changedPaths = await configured.gitClient.changedPaths(integration.path, run.featurePlan.baselineCommit, identity.commitSha);
    if (changedPaths.length === 0) return blocked(run, state, 'Accepted Worker commit has no changed paths.');
    let quality;
    let failure;
    try {
      quality = await runQualityGates({
        projectRoot: integration.path,
        commitSha: identity.commitSha,
        authority: featureQualityAuthority(config),
        gates: await configuredFeatureGates(config, configured.resolveCommandExecutable),
        environment: configured.environment,
      }, { gitClient: configured.gitClient, now: nowMs, signal });
    } catch (error) {
      failure = typeof error?.safeMessage === 'string' ? error.safeMessage : 'Configured quality gates could not complete safely.';
    }
    const afterChecks = await configured.gitClient.inspectRepository(integration.path);
    if (afterChecks.dirty || afterChecks.branch !== integration.branch || afterChecks.headSha !== identity.commitSha) {
      return blocked(run, state, 'Integration changed during verification. A new reviewed proposal is required.');
    }
    const reports = createVerificationReportStore(await verificationReportPaths(featurePaths));
    await reports.write(verificationReport({
      run, state, integration, commitSha: identity.commitSha, changedPaths,
      quality, failure, checkedAt: configured.now(),
    }));
    if (failure) {
      return blocked(run, state, 'Configured quality gates could not complete safely. Correct the gate failure and resume the feature run.');
    }
    if (signal?.aborted) return blocked(run, state, 'Feature verification was interrupted. Inspect the run before resuming.');
    if (quality.status !== 'pass') {
      return blocked(run, state, 'One or more required quality gates failed. Correct the failure and resume the feature run.');
    }
    const beforeFinal = await configured.gitClient.inspectRepository(integration.path);
    if (beforeFinal.dirty || beforeFinal.branch !== integration.branch || beforeFinal.headSha !== identity.commitSha) {
      return blocked(run, state, 'Integration changed before final approval. A new reviewed proposal is required.');
    }
    return immutableJson({
      status: 'awaiting-final-approval',
      summary: 'All approved Workers completed on the isolated local integration branch and required quality gates passed. Final human approval is still required.',
      runtimeRefs: [`runtime:${run.runId}`, `worktree:${run.runId}`],
      evidenceRefs: [
        `commit:${identity.commitSha}`,
        ...quality.gates.map(gate => `test:${gate.id}`),
        ...state.evidence.map(item => `evidence:${item.id}`),
      ],
    });
  };
}
