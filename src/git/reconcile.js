import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { assertGitClient } from './client.js';
import { WorktreeError, verifyReservedWorktree } from './worktrees.js';
import { assertResolvedStatePaths } from '../state/paths.js';
import { acquireLock, LockBusyError } from '../state/lock.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[\]\u0000-\u0020\u007f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class ReconcileError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Worktree reconciliation request is invalid.',
      'lease-changed': 'Worktree lease or topology changed during reconciliation.',
      'integration-failed': 'Fast-forward integration failed safely.',
      'integration-outcome-unknown': 'Fast-forward integration outcome requires explicit inspection.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'ReconcileError';
    this.code = `ERR_RECONCILE_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new ReconcileError(reason); }

function capture(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-input'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-input');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail('invalid-input');
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof ReconcileError) throw error;
    fail('invalid-input');
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-input');
  return result;
}

function validateInput(input) {
  const value = capture(input, new Set([
    'projectRoot', 'statePaths', 'nodeId', 'ownerId', 'leaseId', 'integrationBranch', 'integrate',
  ]), ['projectRoot', 'statePaths', 'nodeId', 'ownerId', 'leaseId', 'integrationBranch', 'integrate']);
  if (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot) || resolve(value.projectRoot) !== value.projectRoot
    || value.projectRoot.length > 1_024 || !ID.test(value.nodeId) || !ID.test(value.ownerId)
    || !LEASE_ID.test(value.leaseId) || !BRANCH.test(value.integrationBranch)
    || value.integrationBranch.normalize('NFKC') !== value.integrationBranch || typeof value.integrate !== 'boolean') fail('invalid-input');
  assertResolvedStatePaths(value.statePaths);
  return Object.freeze(value);
}

function frozenPaths(paths) { return Object.freeze([...paths].sort()); }

function report(status, reason, values) {
  const result = {
    status,
    ...(reason ? { reason } : {}),
    nodeId: values.nodeId,
    branch: values.branch,
    integrationBranch: values.integrationBranch,
    baseSha: values.baseSha,
    workerTip: values.workerTip,
    integrationTip: values.integrationTip,
    cooperationBoundary: 'cooperating-orchestrator-actors',
    evidence: Object.freeze({
      changedPaths: frozenPaths(values.changedPaths ?? []),
      uncommittedPaths: frozenPaths(values.uncommittedPaths ?? []),
      missingIntendedPaths: frozenPaths(values.missingIntendedPaths ?? []),
      unexpectedPaths: frozenPaths(values.unexpectedPaths ?? []),
      conflictingPaths: frozenPaths(values.conflictingPaths ?? []),
    }),
  };
  return Object.freeze(result);
}

function contains(scope, path) {
  return scope.path === path || (scope.directory && path.startsWith(`${scope.path}/`));
}

function baseValues(value, verified) {
  return {
    nodeId: value.nodeId,
    branch: verified.reservation.branch,
    integrationBranch: value.integrationBranch,
    baseSha: verified.reservation.baseSha,
    workerTip: verified.worker.headSha,
    integrationTip: verified.repository.headSha,
  };
}

async function acquireIntegrationLock(path) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { return await acquireLock(path); } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

export async function reconcileWorktree(input, options = {}) {
  const value = validateInput(input);
  const capturedOptions = capture(options, new Set(['gitClient', 'nowMs']), ['gitClient']);
  if (capturedOptions.nowMs !== undefined
    && (!Number.isSafeInteger(capturedOptions.nowMs) || capturedOptions.nowMs < 0)) fail('invalid-input');
  const client = capturedOptions.gitClient;
  assertGitClient(client);
  const verified = await verifyReservedWorktree({
    projectRoot: value.projectRoot,
    statePaths: value.statePaths,
    nodeId: value.nodeId,
    ownerId: value.ownerId,
    leaseId: value.leaseId,
  }, { gitClient: client, nowMs: capturedOptions.nowMs });
  const values = baseValues(value, verified);

  if (verified.repository.detached || verified.repository.branch !== value.integrationBranch) {
    return report('blocked', 'integration-branch-mismatch', values);
  }
  const integrationEvidencePaths = await client.statusPaths(verified.repository.root);
  if (integrationEvidencePaths.length > 0) {
    return report('blocked', 'integration-uncommitted-changes', {
      ...values,
      uncommittedPaths: integrationEvidencePaths,
    });
  }
  if (verified.worker.dirty) {
    return report('blocked', 'worker-uncommitted-changes', {
      ...values,
      uncommittedPaths: verified.worker.dirtyPaths,
    });
  }
  if (!(await client.isAncestor(verified.worker.root, values.baseSha, values.workerTip))) {
    return report('blocked', 'worker-base-mismatch', values);
  }
  if (!(await client.isAncestor(verified.repository.root, values.baseSha, values.integrationTip))) {
    return report('blocked', 'integration-base-mismatch', values);
  }

  const changedPaths = await client.changedPaths(verified.worker.root, values.baseSha, values.workerTip);
  const missingIntendedPaths = verified.reservation.intendedPaths.filter(path => !changedPaths.includes(path));
  const unexpectedPaths = changedPaths.filter(path => !verified.reservation.responsibilities.some(scope => contains(scope, path)));
  if (missingIntendedPaths.length > 0 || unexpectedPaths.length > 0) {
    return report('blocked', 'scope-mismatch', {
      ...values, changedPaths, missingIntendedPaths, unexpectedPaths,
    });
  }

  const fastForward = await client.isAncestor(verified.repository.root, values.integrationTip, values.workerTip);
  if (!fastForward) {
    const integrationPaths = await client.changedPaths(verified.repository.root, values.baseSha, values.integrationTip);
    const conflictingPaths = changedPaths.filter(path => integrationPaths.includes(path));
    return report('blocked', conflictingPaths.length > 0 ? 'integration-conflict' : 'non-fast-forward', {
      ...values, changedPaths, conflictingPaths,
    });
  }

  if (!value.integrate) return report('ready', null, { ...values, changedPaths });

  const lock = await acquireIntegrationLock(join(value.statePaths.instanceDir, 'integration.lock'));
  try {
    // The shared integration lock makes this revalidation and mutation one cooperating transaction.
    const current = await verifyReservedWorktree({
      projectRoot: value.projectRoot,
      statePaths: value.statePaths,
      nodeId: value.nodeId,
      ownerId: value.ownerId,
      leaseId: value.leaseId,
    }, { gitClient: client, nowMs: capturedOptions.nowMs });
    if (current.stateVersion !== verified.stateVersion || current.reservation.repositoryId !== verified.reservation.repositoryId
      || current.worker.headSha !== values.workerTip || current.repository.headSha !== values.integrationTip
      || current.repository.branch !== value.integrationBranch || current.worker.dirty) {
      fail('lease-changed');
    }
    const currentIntegrationEvidencePaths = await client.statusPaths(current.repository.root);
    if (currentIntegrationEvidencePaths.length > 0) {
      return report('blocked', 'integration-uncommitted-changes', {
        ...values,
        uncommittedPaths: currentIntegrationEvidencePaths,
      });
    }
    try {
      await client.fastForward(current.repository.root, {
        branch: value.integrationBranch,
        expectedTip: values.integrationTip,
        newTip: values.workerTip,
      });
    } catch {
      let observed;
      try { observed = await client.inspectRepository(current.repository.root); }
      catch { fail('integration-outcome-unknown'); }
      if (observed.repositoryId !== current.repository.repositoryId
        || observed.branch !== value.integrationBranch) fail('integration-outcome-unknown');
      if (observed.headSha === values.workerTip && !observed.dirty) {
        return report('integrated', null, { ...values, integrationTip: values.workerTip, changedPaths });
      }
      return report('blocked', 'integration-concurrent-change', {
        ...values,
        integrationTip: observed.headSha,
        changedPaths,
        uncommittedPaths: observed.dirtyPaths,
      });
    }
    return report('integrated', null, { ...values, integrationTip: values.workerTip, changedPaths });
  } catch (error) {
    if (error instanceof ReconcileError || error instanceof WorktreeError) throw error;
    fail('integration-failed');
  } finally {
    await lock.release();
  }
}
