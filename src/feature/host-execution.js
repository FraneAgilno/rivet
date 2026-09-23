import { basename, dirname, join } from 'node:path';

import { immutableJson } from '../clients/contract.js';
import { loadProjectConfig } from '../config/load.js';
import { assertGitClient } from '../git/client.js';
import { prepareIntegrationWorktree } from '../git/integration-worktree.js';
import { reconcileWorktree } from '../git/reconcile.js';
import { createReservationStore } from '../git/reservations.js';
import { createReservedWorktree } from '../git/worktrees.js';
import { buildLaunchContract } from '../prompts/launch-contract.js';
import { runQualityGates } from '../quality/runner.js';
import { createRuntimeInstance } from '../runtime/instance-store.js';
import { createOrchestrator } from '../runtime/orchestrator.js';
import {
  acceptedIntegrationPaths,
  resolveExistingFeatureRunPaths,
  resolveExistingStatePaths,
  resolveFeatureRunPaths,
  resolveStatePaths,
  verificationReportPaths,
} from '../state/paths.js';
import { readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { createWorkAction, validateWorkAction } from './actions.js';
import { createAcceptedIntegrationStore } from './accepted-integration.js';
import { acquireHostRunLock } from './host-run-lock.js';
import { createFeatureRunStore } from './run-store.js';
import { createVerificationReportStore, verificationReport } from './verification-report.js';
import {
  createFeatureLaunchInput,
  createFeatureRuntimeControls,
  createFeatureRuntimeState,
  configuredFeatureGates,
  featureBranchFor,
  featureNowMilliseconds,
  featureQualityAuthority,
  finalizeFeatureWorkerCommit,
  inspectFeatureRuntime,
  prepareFeatureWorkerParent,
  reusableWorkerCheckout,
} from './runtime-bridge.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class HostExecutionError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Host execution input is invalid.',
      'run-missing': 'Feature run was not found.',
      'state-conflict': 'Host execution state changed or does not permit this operation.',
      repository: 'Host execution requires the exact clean approved repository baseline.',
      'verification-failed': 'Configured verification failed. Read work status for the recorded checks and recovery guidance.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'HostExecutionError';
    this.code = `ERR_HOST_EXECUTION_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new HostExecutionError(reason); }

function capture(input, allowed, required = allowed) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-input');
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || [...required].some(key => !keys.includes(key))) fail('invalid-input');
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-input');
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof HostExecutionError) throw error;
    fail('invalid-input');
  }
}

function request(input, versionName = null) {
  const allowed = new Set(['project', 'runId', ...(versionName ? [versionName] : [])]);
  const value = capture(input, allowed);
  if (typeof value.project !== 'string' || !value.project.startsWith('/') || value.project.length > 4096
    || typeof value.runId !== 'string' || value.runId.length > 64 || !RUN_ID.test(value.runId)
    || (versionName && (!Number.isSafeInteger(value[versionName]) || value[versionName] < 1))) fail('invalid-input');
  return value;
}

function runtimeSummary(state) {
  return immutableJson({
    version: state.version,
    terminal: state.terminal,
    activated: state.activated,
    graphStatus: state.graph.status,
    nodes: state.graph.nodes.map(node => ({ id: node.id, status: node.status, owner: node.owner })),
    usage: state.usage,
  });
}

function exactStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const first = [...left].sort();
  const second = [...right].sort();
  return first.every((value, index) => value === second[index]);
}

export function createHostExecution(input) {
  const configured = capture(
    input,
    new Set(['gitClient', 'now', 'resolveCommandExecutable', 'environment']),
    new Set(['gitClient']),
  );
  try { assertGitClient(configured.gitClient); } catch { fail('invalid-input'); }
  const gitClient = configured.gitClient;
  const now = configured.now ?? (() => new Date().toISOString());
  const resolveCommandExecutable = configured.resolveCommandExecutable;
  const environment = configured.environment === undefined ? Object.freeze(Object.create(null)) : immutableJson(configured.environment);
  if (typeof now !== 'function'
    || (resolveCommandExecutable !== undefined && typeof resolveCommandExecutable !== 'function')) fail('invalid-input');

  async function runRecord(project, runId) {
    const paths = await resolveFeatureRunPaths(project, runId);
    const store = createFeatureRunStore(paths);
    const run = await store.read();
    if (run === null) fail('run-missing');
    if (run.featurePlan.client !== 'host') fail('state-conflict');
    return { paths, store, run };
  }

  async function runtimeContext(project, run) {
    const [repository, config] = await Promise.all([
      gitClient.inspectRepository(project),
      loadProjectConfig(project),
    ]).catch(() => fail('repository'));
    if (repository.root !== project || repository.detached || repository.dirty
      || repository.branch !== config.project.repository.defaultBranch
      || repository.headSha !== run.featurePlan.baselineCommit) fail('repository');
    const initialState = createFeatureRuntimeState({ config, run });
    const statePaths = await resolveStatePaths(project, run.runId);
    const integrationBranch = featureBranchFor(config, run.featurePlan, run.runId);
    const worktreeRunRoot = join(dirname(project), '.rivet-worktrees', repository.repositoryId, basename(statePaths.instanceDir));
    const integration = await prepareIntegrationWorktree({
      projectRoot: project,
      statePaths,
      branch: integrationBranch,
      worktreePath: join(worktreeRunRoot, 'integration'),
      baseSha: run.featurePlan.baselineCommit,
    }, { gitClient });
    const parent = await prepareFeatureWorkerParent(worktreeRunRoot);
    const instance = createRuntimeInstance({ id: run.runId, paths: statePaths, initialState });
    const planNodes = new Map(run.featurePlan.nodes.map(node => [node.id, node]));
    const nowMs = () => featureNowMilliseconds(now);
    const runtime = createOrchestrator({
      client: Object.freeze({ async launch() { fail('state-conflict'); } }),
      now: nowMs,
      async prepareWorktree(node, intent) {
        const planNode = planNodes.get(node.id);
        if (!planNode || planNode.role !== 'worker' || intent.attempt !== 1) fail('state-conflict');
        const current = await gitClient.inspectRepository(integration.path);
        if (current.branch !== integration.branch || current.dirty) fail('repository');
        const branch = `worker/${run.runId}/${node.id}`;
        const worktreePath = join(parent, node.id);
        const reservations = await createReservationStore(statePaths).list();
        const existing = reservations.reservations.filter(item => item.nodeId === node.id
          && item.ownerId === node.owner.id && item.status === 'active');
        if (existing.length > 1) fail('state-conflict');
        if (existing.length === 1) {
          const reused = await reusableWorkerCheckout({
            gitClient,
            projectRoot: integration.path,
            statePaths,
            node,
            planNode,
            branch,
            worktreePath,
            baseSha: current.headSha,
            nowMs: nowMs(),
          });
          return Object.freeze({
            path: reused.worker.root,
            dev: reused.worker.rootIdentity.dev,
            ino: reused.worker.rootIdentity.ino,
            reservationId: intent.reservationId,
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
        }, { gitClient, nowMs: nowMs() });
        const worker = await gitClient.inspectRepository(created.reservation.worktreePath);
        return Object.freeze({
          path: worker.root,
          dev: worker.rootIdentity.dev,
          ino: worker.rootIdentity.ino,
          reservationId: intent.reservationId,
        });
      },
      launchFor(node, intent) {
        const planNode = planNodes.get(node.id);
        if (!planNode) fail('state-conflict');
        return createFeatureLaunchInput(node, intent, planNode, run);
      },
      async reconcile(node, intent, result) {
        const reservations = await createReservationStore(statePaths).list();
        const matches = reservations.reservations.filter(item => item.nodeId === node.id
          && item.ownerId === node.owner.id && item.status === 'active');
        if (matches.length !== 1) fail('state-conflict');
        const leaseId = matches[0].leaseId;
        const evidenceMatches = result.status !== 'success' || exactStrings(result.output?.evidence, node.evidenceRefs);
        if (result.status === 'success') {
          await finalizeFeatureWorkerCommit({
            gitClient,
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
        }, { gitClient, nowMs: nowMs() });
        return evidenceMatches ? report : Object.freeze({
          ...report,
          status: 'blocked',
          reason: 'result-evidence-mismatch',
        });
      },
    });
    return { instance, runtime, integration, config, planNodes };
  }

  async function prepare(inputValue) {
    const value = request(inputValue, 'expectedRunVersion');
    const { store, run } = await runRecord(value.project, value.runId);
    if (!['approved', 'running'].includes(run.status) || run.version !== value.expectedRunVersion) fail('state-conflict');
    const preparedContext = await runtimeContext(value.project, run);
    const running = run.status === 'running' ? run : await store.update({
      status: 'running',
      updatedAt: now(),
      runtimeRefs: [...new Set([...run.runtimeRefs, `runtime:${run.runId}`])],
      evidenceRefs: run.evidenceRefs,
    }, { expectedVersion: run.version });
    const context = run.status === 'running' ? preparedContext : await runtimeContext(value.project, running);
    let state = await inspectFeatureRuntime(context.instance);
    if (!state.activated) {
      state = await context.runtime.activate(context.instance, {
        expectedVersion: state.version,
        ...createFeatureRuntimeControls({ run: running, nowMs: featureNowMilliseconds(now) }),
      });
    }
    return immutableJson({ status: 'ready', run: running, runtimeVersion: state.version });
  }

  async function nextAction(inputValue) {
    const value = request(inputValue, 'expectedRuntimeVersion');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    try {
      const { run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running') fail('state-conflict');
      const { instance, runtime } = await runtimeContext(value.project, run);
      const prepared = await runtime.prepareAction(instance, { expectedVersion: value.expectedRuntimeVersion });
      if (prepared.action === null) {
        return immutableJson({ status: 'idle', runtimeVersion: prepared.version, action: null });
      }
      const action = createWorkAction({
        runId: run.runId,
        runtimeVersion: prepared.version,
        nodeId: prepared.action.node.id,
        intentId: prepared.action.intent.id,
        idempotencyKey: prepared.action.intent.idempotencyKey,
        reservationId: prepared.action.intent.reservationId,
        attempt: prepared.action.intent.attempt,
        payload: buildLaunchContract(prepared.action.launch),
      });
      const wasAlreadyStarted = value.expectedRuntimeVersion === prepared.version;
      return immutableJson({
        status: wasAlreadyStarted ? 'waiting-for-result' : 'action',
        runtimeVersion: prepared.version,
        action,
      });
    } finally { await hostLock.release(); }
  }

  async function submitResult(inputValue) {
    const value = capture(inputValue, new Set([
      'project', 'runId', 'expectedRuntimeVersion', 'action', 'result',
    ]));
    request({
      project: value.project,
      runId: value.runId,
      expectedRuntimeVersion: value.expectedRuntimeVersion,
    }, 'expectedRuntimeVersion');
    const action = validateWorkAction(value.action);
    if (action.runId !== value.runId || action.runtimeVersion !== value.expectedRuntimeVersion) fail('state-conflict');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    try {
      const { store, run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running') fail('state-conflict');
      const { instance, runtime, planNodes, integration } = await runtimeContext(value.project, run);
      const state = await inspectFeatureRuntime(instance);
      if (state.version !== value.expectedRuntimeVersion) fail('state-conflict');
      const node = state.graph.nodes.find(item => item.id === action.nodeId && item.status === 'running');
      const intent = state.launchIntents[action.nodeId];
      const planNode = planNodes.get(action.nodeId);
      if (!node || intent?.status !== 'started' || !planNode) fail('state-conflict');
      const expectedAction = createWorkAction({
        runId: run.runId,
        runtimeVersion: state.version,
        nodeId: node.id,
        intentId: intent.id,
        idempotencyKey: intent.idempotencyKey,
        reservationId: intent.reservationId,
        attempt: intent.attempt,
        payload: buildLaunchContract(createFeatureLaunchInput(node, intent, planNode, run)),
      });
      if (JSON.stringify(action) !== JSON.stringify(expectedAction)) fail('state-conflict');
      const submitted = await runtime.submitAction(instance, {
        expectedVersion: value.expectedRuntimeVersion,
        nodeId: action.nodeId,
        intentId: action.intentId,
        idempotencyKey: action.idempotencyKey,
        reservationId: action.reservationId,
        result: value.result,
      });
      if (submitted.nodeStatus === 'completed' && submitted.report?.status === 'integrated') {
        const integrated = await gitClient.inspectRepository(integration.path);
        if (integrated.dirty || integrated.branch !== integration.branch
          || integrated.headSha !== submitted.report.integrationTip) fail('repository');
        const accepted = createAcceptedIntegrationStore(await acceptedIntegrationPaths(hostPaths));
        await accepted.write({
          schemaVersion: 1,
          runId: run.runId,
          baselineCommit: run.featurePlan.baselineCommit,
          commitSha: submitted.report.integrationTip,
          runtimeVersion: submitted.version,
          path: integration.path,
          branch: integration.branch,
        });
      }
      if (submitted.nodeStatus === 'blocked' || ['blocked', 'failed', 'budget-exhausted'].includes(submitted.terminal)) {
        await store.update({
          status: 'blocked',
          updatedAt: now(),
          runtimeRefs: run.runtimeRefs,
          evidenceRefs: run.evidenceRefs,
        }, { expectedVersion: run.version });
      }
      return immutableJson({
        status: submitted.nodeStatus === 'completed' ? 'accepted' : 'blocked',
        runtimeVersion: submitted.version,
        nodeId: submitted.nodeId,
        nodeStatus: submitted.nodeStatus,
        terminal: submitted.terminal,
        reconciliation: submitted.report,
      });
    } finally { await hostLock.release(); }
  }

  async function verify(inputValue) {
    const value = capture(inputValue, new Set([
      'project', 'runId', 'expectedRunVersion', 'expectedRuntimeVersion',
    ]));
    request({
      project: value.project,
      runId: value.runId,
      expectedRunVersion: value.expectedRunVersion,
    }, 'expectedRunVersion');
    if (!Number.isSafeInteger(value.expectedRuntimeVersion) || value.expectedRuntimeVersion < 1) fail('invalid-input');
    if (typeof resolveCommandExecutable !== 'function') fail('state-conflict');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    try {
      const { paths, store, run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running' || run.version !== value.expectedRunVersion) fail('state-conflict');
      const { instance, integration, config } = await runtimeContext(value.project, run);
      const state = await inspectFeatureRuntime(instance);
      if (state.version !== value.expectedRuntimeVersion) fail('state-conflict');
      const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
      if (accepted === null || accepted.runId !== run.runId
        || accepted.baselineCommit !== run.featurePlan.baselineCommit
        || accepted.runtimeVersion > state.version
        || accepted.path !== integration.path || accepted.branch !== integration.branch) fail('repository');
      const finalNode = state.graph.nodes.find(node => node.approvalGate === 'final-delivery');
      const nonHumanComplete = state.graph.nodes.filter(node => !node.approvalGate)
        .every(node => ['completed', 'archived'].includes(node.status));
      if (!nonHumanComplete || finalNode?.status !== 'ready') fail('state-conflict');
      const integrated = await gitClient.inspectRepository(integration.path);
      if (integrated.dirty || integrated.branch !== integration.branch
        || integrated.headSha !== accepted.commitSha
        || integrated.headSha === run.featurePlan.baselineCommit
        || !(await gitClient.isAncestor(integration.path, run.featurePlan.baselineCommit, integrated.headSha))) {
        fail('repository');
      }
      const changedPaths = await gitClient.changedPaths(integration.path, run.featurePlan.baselineCommit, integrated.headSha);
      if (changedPaths.length === 0) fail('repository');
      const reports = createVerificationReportStore(await verificationReportPaths(paths));
      let quality;
      let failure;
      try {
        quality = await runQualityGates({
          projectRoot: integration.path,
          commitSha: integrated.headSha,
          authority: featureQualityAuthority(config),
          gates: await configuredFeatureGates(config, resolveCommandExecutable),
          environment,
        }, { gitClient, now: () => featureNowMilliseconds(now) });
      } catch (error) {
        failure = typeof error?.safeMessage === 'string' ? error.safeMessage : 'Verification could not complete safely.';
      }
      const afterChecks = await gitClient.inspectRepository(integration.path);
      if (afterChecks.dirty || afterChecks.branch !== integration.branch
        || afterChecks.headSha !== accepted.commitSha) fail('repository');
      const currentRun = await store.readOnly();
      if (currentRun?.status !== 'running' || currentRun.version !== run.version) fail('state-conflict');
      await reports.write(verificationReport({
        run, state, integration, commitSha: integrated.headSha, changedPaths,
        quality, failure, checkedAt: now(),
      }));
      if (quality?.status !== 'pass') fail('verification-failed');
      const beforeFinal = await gitClient.inspectRepository(integration.path);
      if (beforeFinal.dirty || beforeFinal.branch !== integration.branch
        || beforeFinal.headSha !== accepted.commitSha) fail('repository');
      return await store.update({
        status: 'awaiting-final-approval',
        updatedAt: now(),
        runtimeRefs: [...new Set([...run.runtimeRefs, `worktree:${run.runId}`])],
        evidenceRefs: [...new Set([
          ...run.evidenceRefs,
          `commit:${integrated.headSha}`,
          ...quality.gates.map(gate => `test:${gate.id}`),
          ...state.evidence.map(item => `evidence:${item.id}`),
        ])],
      }, { expectedVersion: run.version });
    } finally { await hostLock.release(); }
  }

  async function status(inputValue) {
    const value = request(inputValue);
    const paths = await resolveExistingFeatureRunPaths(value.project, value.runId);
    if (paths === null) fail('run-missing');
    const run = await createFeatureRunStore(paths).readOnly();
    if (run === null || run.featurePlan.client !== 'host') fail('run-missing');
    const reports = createVerificationReportStore(await verificationReportPaths(paths));
    const verification = await reports.readOnly();
    if (verification !== null && (verification.runId !== run.runId
      || verification.baselineCommit !== run.featurePlan.baselineCommit)) fail('state-conflict');
    const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
    if (accepted !== null && (accepted.runId !== run.runId
      || accepted.baselineCommit !== run.featurePlan.baselineCommit)) fail('state-conflict');
    let checkout = null;
    if (accepted !== null) {
      let observed = null;
      try {
        const worktrees = await gitClient.listWorktrees(value.project);
        const registered = worktrees.filter(item => item.path === accepted.path && item.branch === accepted.branch);
        if (registered.length === 1) observed = await gitClient.inspectRepository(accepted.path);
      } catch {}
      checkout = {
        status: observed !== null && observed.branch === accepted.branch
          && observed.headSha === accepted.commitSha && !observed.dirty ? 'clean' : 'stale',
        path: accepted.path,
        branch: accepted.branch,
        acceptedCommit: accepted.commitSha,
        observedCommit: observed?.headSha ?? null,
        dirty: observed?.dirty ?? null,
      };
    }
    const statePaths = await resolveExistingStatePaths(value.project, value.runId);
    const snapshot = statePaths === null ? null : await readSnapshotWithoutLock(statePaths);
    const runtime = snapshot === null ? null : runtimeSummary(snapshot.data);
    const blockedNodes = run.status === 'blocked'
      ? (runtime?.nodes ?? []).filter(node => ['blocked', 'failed'].includes(node.status)).map(node => node.id)
      : [];
    const readyForVerification = (runtime?.nodes ?? [])
      .some(node => node.id === 'final-delivery' && node.status === 'ready');
    const verificationStale = verification !== null && accepted !== null
      && (verification.commitSha !== accepted.commitSha || checkout?.status !== 'clean');
    const deliverable = run.status === 'awaiting-final-approval'
      && runtime !== null && readyForVerification
      && accepted !== null && checkout?.status === 'clean'
      && verification?.status === 'pass'
      && verification.runVersion === run.version - 1
      && verification.runtimeVersion === runtime.version
      && verification.commitSha === accepted.commitSha
      && verification.integration.path === accepted.path
      && verification.integration.branch === accepted.branch;
    const nextAction = checkout?.status === 'stale' || verificationStale
      ? 'The integration checkout no longer matches the accepted tested commit. Do not deliver it; create a new reviewed proposal for source changes.'
      : run.status === 'awaiting-final-approval' && !deliverable
      ? 'Final approval evidence is missing or inconsistent. Do not deliver this run; inspect private state and create a new reviewed proposal if it cannot be restored.'
      : deliverable
      ? 'Review the integration diff and executed checks, then make the separate final delivery decision.'
      : run.status === 'blocked'
        ? 'Inspect the blocked nodes and last submission response. Source correction requires a new reviewed proposal.'
        : readyForVerification && accepted === null
          ? 'Accepted integration identity is missing. Do not verify this run; create a new reviewed proposal.'
        : verification?.status === 'fail'
          ? verification.nextAction
          : run.status === 'running' && runtime !== null
            ? 'Use work next with runtime.version to continue or recover the pending action.'
            : run.status === 'approved'
              ? 'Use work prepare with run.version to create the isolated execution state.'
              : 'Review the proposal and current run state before proceeding.';
    return immutableJson({ run, runtime, verification, checkout, blockedNodes, nextAction });
  }

  return Object.freeze({ prepare, nextAction, submitResult, verify, status });
}
