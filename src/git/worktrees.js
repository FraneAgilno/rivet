import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { assertGitClient, GitClientError } from './client.js';
import { createReservationStore, ReservationError } from './reservations.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from '../state/paths.js';
import { evaluateAuthority } from '../policy/authority.js';
import { verifyApproval } from '../policy/approvals.js';

const PROTECTED = /^(?:main|master|trunk|develop|development|production|release(?:\/.*)?)$/i;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class WorktreeError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Worktree request is invalid.',
      'dirty-source': 'Source worktree must be clean.',
      'detached-source': 'Source worktree must have an attached branch.',
      'stale-base': 'Requested worktree base is stale or mismatched.',
      'protected-branch': 'Protected branches cannot be Worker branches.',
      'branch-collision': 'Worker branch is already reserved or present.',
      'path-collision': 'Worker worktree path is already reserved or present.',
      'unsafe-path': 'Worker worktree path is unsafe.',
      'repository-mismatch': 'Repository identity does not match private state.',
      'repository-changed': 'Repository identity or topology changed.',
      'create-failed': 'Worker worktree creation failed safely.',
      'rollback-failed': 'Worker worktree rollback requires explicit reconciliation.',
      'lease-mismatch': 'Worktree lease identity does not match.',
      'stale-lease': 'Expired worktree lease requires explicit reconciliation.',
      'recovery-authority': 'Stale worktree recovery authority denied.',
      'recovery-approval': 'Stale worktree recovery requires human approval.',
      'recovery-failed': 'Stale worktree recovery requires explicit intervention.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'WorktreeError';
    this.code = `ERR_WORKTREE_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new WorktreeError(reason); }

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
    if (error instanceof WorktreeError) throw error;
    fail('invalid-input');
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-input');
  return result;
}

function captureStringArray(value, limit) {
  if (!Array.isArray(value)) fail('invalid-input');
  const result = [];
  try {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length === 0 || length > limit) fail('invalid-input');
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('invalid-input');
      const item = value[index];
      if (typeof item !== 'string') fail('invalid-input');
      result.push(item);
    }
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail('invalid-input');
  }
  return Object.freeze(result);
}

function captureOptions(options) {
  const value = capture(options, new Set(['gitClient', 'nowMs']), ['gitClient']);
  if (value.nowMs !== undefined && (!Number.isSafeInteger(value.nowMs) || value.nowMs < 0)) fail('invalid-input');
  return Object.freeze(value);
}

function captureRecoveryOptions(options) {
  const value = capture(options, new Set([
    'gitClient', 'nowMs', 'authority', 'approval', 'approvalRegistry', 'expectedApproverId',
  ]), [
    'gitClient', 'nowMs', 'authority', 'approvalRegistry', 'expectedApproverId',
  ]);
  if (!Number.isSafeInteger(value.nowMs) || value.nowMs < 0
    || typeof value.expectedApproverId !== 'string') fail('invalid-input');
  return Object.freeze(value);
}

function folded(value) { return value.normalize('NFKC').toLocaleLowerCase('en-US'); }

function validAbsolutePath(value) {
  if (typeof value !== 'string' || value.length <= 1 || value.length > 1_024 || !isAbsolute(value)
    || resolve(value) !== value || /[\u0000\r\n\\:]/.test(value) || value.normalize('NFKC') !== value) return false;
  const parts = value.split(sep).filter(Boolean);
  return parts.every(part => (
    part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ')
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
  ));
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function verifyUnusedTarget(path) {
  if (!validAbsolutePath(path)) fail('unsafe-path');
  const parent = dirname(path);
  if (parent === path || parent === sep) fail('unsafe-path');
  let before;
  try { before = await lstat(parent, { bigint: true }); } catch { fail('unsafe-path'); }
  if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe-path');
  let canonical;
  try { canonical = await realpath(parent); } catch { fail('unsafe-path'); }
  const after = await lstat(parent, { bigint: true });
  if (canonical !== parent || !after.isDirectory() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino) fail('unsafe-path');
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || (!existing.isDirectory() && !existing.isFile())) fail('unsafe-path');
    fail('path-collision');
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    if (error.code !== 'ENOENT') fail('unsafe-path');
  }
  return Object.freeze({ path, parent, parentIdentity: Object.freeze({ dev: after.dev.toString(), ino: after.ino.toString() }) });
}

async function verifyTargetParent(target) {
  const before = await lstat(target.parent, { bigint: true });
  const canonical = await realpath(target.parent);
  const after = await lstat(target.parent, { bigint: true });
  if (canonical !== target.parent || !before.isDirectory() || before.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || after.dev.toString() !== target.parentIdentity.dev || after.ino.toString() !== target.parentIdentity.ino) {
    fail('unsafe-path');
  }
}

function validateCreateInput(input) {
  const value = capture(input, new Set([
    'projectRoot', 'statePaths', 'nodeId', 'branch', 'worktreePath', 'ownerId', 'baseSha',
    'responsibilities', 'intendedPaths', 'expiresAt',
  ]), [
    'projectRoot', 'statePaths', 'nodeId', 'branch', 'worktreePath', 'ownerId', 'baseSha',
    'responsibilities', 'intendedPaths', 'expiresAt',
  ]);
  if (!validAbsolutePath(value.projectRoot)
    || !ID.test(value.nodeId) || value.nodeId.length > 64 || !ID.test(value.ownerId) || value.ownerId.length > 64
    || typeof value.branch !== 'string' || value.branch.length > 200 || value.branch.normalize('NFKC') !== value.branch
    || !SHA.test(value.baseSha) || typeof value.expiresAt !== 'string') fail('invalid-input');
  if (!validAbsolutePath(value.worktreePath)) fail('unsafe-path');
  assertResolvedStatePaths(value.statePaths);
  return Object.freeze({
    ...value,
    responsibilities: captureStringArray(value.responsibilities, 256),
    intendedPaths: captureStringArray(value.intendedPaths, 256),
  });
}

function validateVerifyInput(input) {
  const value = capture(input, new Set([
    'projectRoot', 'statePaths', 'nodeId', 'ownerId', 'leaseId',
  ]), ['projectRoot', 'statePaths', 'nodeId', 'ownerId', 'leaseId']);
  if (!validAbsolutePath(value.projectRoot) || !ID.test(value.nodeId) || !ID.test(value.ownerId) || !LEASE_ID.test(value.leaseId)) {
    fail('invalid-input');
  }
  assertResolvedStatePaths(value.statePaths);
  return Object.freeze(value);
}

function validateRepositoryBinding(repository, input) {
  if (repository.root !== input.projectRoot || repository.gitCommonDir !== input.statePaths.gitCommonDir) fail('repository-mismatch');
  if (repository.detached) fail('detached-source');
  if (repository.dirty) fail('dirty-source');
  if (repository.headSha !== input.baseSha) fail('stale-base');
  if (PROTECTED.test(input.branch)) fail('protected-branch');
}

function topologyCollision(worktrees, branch, path) {
  const branchKey = folded(branch);
  const pathKey = folded(path);
  if (worktrees.some(item => item.branch && folded(item.branch) === branchKey)) fail('branch-collision');
  if (worktrees.some(item => {
    const existing = folded(item.path);
    return existing === pathKey || existing.startsWith(`${pathKey}${sep}`) || pathKey.startsWith(`${existing}${sep}`);
  })) fail('path-collision');
}

function identity(reservation) {
  return Object.freeze({
    nodeId: reservation.nodeId,
    ownerId: reservation.ownerId,
    leaseId: reservation.leaseId,
  });
}

async function rollbackCreation(client, repository, store, reservation, version) {
  try {
    await client.rollbackWorktreeCreation(repository.root, {
      path: reservation.worktreePath,
      branch: reservation.branch,
      baseSha: reservation.baseSha,
    });
  } catch { return false; }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const current = attempt === 0 ? { version } : await store.list();
      await store.rollback(identity(reservation), { expectedVersion: current.version });
      return true;
    } catch (error) {
      if (!(error instanceof ReservationError) || error.details.reason !== 'state-version-conflict') return false;
    }
  }
  return false;
}

async function reserveWithRetry(store, input, nowMs) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const state = await store.list();
    try { return await store.reserve(input, { expectedVersion: state.version, nowMs }); }
    catch (error) {
      if (!(error instanceof ReservationError) || error.details.reason !== 'state-version-conflict') throw error;
    }
  }
  throw new ReservationError('state-version-conflict');
}

async function activateWithRetry(store, reservation, initialVersion) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const expectedVersion = attempt === 0 ? initialVersion : (await store.list()).version;
    try { return await store.activate(identity(reservation), { expectedVersion }); }
    catch (error) {
      if (!(error instanceof ReservationError) || error.details.reason !== 'state-version-conflict') throw error;
    }
  }
  throw new ReservationError('state-version-conflict');
}

async function recoverExpiredWithRetry(store, reservation, nowMs) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const state = await store.list();
    try {
      return await store.recoverExpired(identity(reservation), {
        expectedVersion: state.version,
        nowMs,
      });
    } catch (error) {
      if (!(error instanceof ReservationError) || error.details.reason !== 'state-version-conflict') throw error;
    }
  }
  throw new ReservationError('state-version-conflict');
}

function mapReservationError(error) {
  if (!(error instanceof ReservationError)) throw error;
  if (error.details.reason === 'lease-mismatch') fail('lease-mismatch');
  if (error.details.reason === 'stale-lease') fail('stale-lease');
  throw error;
}

export async function createReservedWorktree(input, options = {}) {
  let value;
  let client;
  try {
    value = validateCreateInput(input);
    options = captureOptions(options);
    client = options.gitClient;
    assertGitClient(client);
    await verifyResolvedStatePaths(value.statePaths);
  } catch (error) {
    if (error instanceof WorktreeError || error instanceof ReservationError) throw error;
    fail('invalid-input');
  }

  const target = await verifyUnusedTarget(value.worktreePath);
  let repository;
  try { repository = await client.inspectRepository(value.projectRoot); } catch (error) {
    if (error instanceof GitClientError && error.details.reason === 'executable-config') throw error;
    fail('repository-mismatch');
  }
  validateRepositoryBinding(repository, value);
  const worktrees = await client.listWorktrees(repository.root);
  topologyCollision(worktrees, value.branch, value.worktreePath);
  const existingBranch = await client.branchTip(repository.root, value.branch);
  if (existingBranch !== null) fail('branch-collision');

  const store = createReservationStore(value.statePaths);
  let reserved;
  try {
    reserved = await reserveWithRetry(store, {
      ...value,
      repositoryId: repository.repositoryId,
    }, options.nowMs);
  } catch (error) { mapReservationError(error); }

  try {
    await verifyTargetParent(target);
    const before = await client.inspectRepository(repository.root);
    if (before.repositoryId !== repository.repositoryId || before.root !== repository.root
      || before.headSha !== repository.headSha || before.branch !== repository.branch || before.dirty || before.detached) {
      fail('repository-changed');
    }
    topologyCollision(await client.listWorktrees(repository.root), value.branch, value.worktreePath);
    if (await client.branchTip(repository.root, value.branch) !== null) fail('branch-collision');
    await client.createWorktree(repository.root, {
      path: value.worktreePath,
      branch: value.branch,
      baseSha: value.baseSha,
    });
    const worker = await client.inspectRepository(value.worktreePath);
    if (worker.repositoryId !== repository.repositoryId || worker.root !== value.worktreePath
      || worker.branch !== value.branch || worker.headSha !== value.baseSha || worker.dirty) {
      fail('repository-changed');
    }
    const topology = await client.listWorktrees(repository.root);
    const matches = topology.filter(item => item.path === value.worktreePath && item.branch === value.branch && item.head === value.baseSha);
    if (matches.length !== 1) fail('repository-changed');
    const active = await activateWithRetry(store, reserved.reservation, reserved.version);
    return Object.freeze({
      reservation: active.reservation,
      repository: Object.freeze({ id: repository.repositoryId, root: repository.root, gitCommonDir: repository.gitCommonDir }),
    });
  } catch (error) {
    const rolledBack = await rollbackCreation(client, repository, store, reserved.reservation, reserved.version);
    if (!rolledBack) fail('rollback-failed');
    if (error instanceof WorktreeError && ['repository-changed', 'branch-collision', 'path-collision', 'unsafe-path'].includes(error.details.reason)) {
      throw error;
    }
    if (error instanceof ReservationError) throw error;
    if (error instanceof GitClientError) fail('create-failed');
    fail('create-failed');
  }
}

export async function verifyReservedWorktree(input, options = {}) {
  let value;
  let client;
  try {
    value = validateVerifyInput(input);
    options = captureOptions(options);
    client = options.gitClient;
    assertGitClient(client);
    await verifyResolvedStatePaths(value.statePaths);
  } catch (error) {
    if (error instanceof WorktreeError || error instanceof ReservationError) throw error;
    fail('invalid-input');
  }
  const store = createReservationStore(value.statePaths);
  let stored;
  try { stored = await store.get({ nodeId: value.nodeId, ownerId: value.ownerId, leaseId: value.leaseId }); }
  catch (error) { mapReservationError(error); }
  const reservation = stored.reservation;
  if (reservation.status !== 'active') fail('lease-mismatch');
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('invalid-input');
  if (Date.parse(reservation.expiresAt) <= nowMs) fail('stale-lease');
  let repository;
  let worker;
  try {
    repository = await client.inspectRepository(value.projectRoot);
    worker = await client.inspectRepository(reservation.worktreePath);
  } catch { fail('repository-changed'); }
  if (repository.repositoryId !== reservation.repositoryId || repository.gitCommonDir !== value.statePaths.gitCommonDir
    || worker.repositoryId !== reservation.repositoryId || worker.root !== reservation.worktreePath
    || worker.branch !== reservation.branch) fail('repository-changed');
  const matches = (await client.listWorktrees(repository.root))
    .filter(item => item.path === reservation.worktreePath && item.branch === reservation.branch);
  if (matches.length !== 1) fail('repository-changed');
  return Object.freeze({
    reservation,
    repository,
    worker,
    stateVersion: stored.version,
    cooperationBoundary: 'cooperating-orchestrator-actors',
  });
}

export async function recoverStaleWorktree(input, options = {}) {
  const value = validateVerifyInput(input);
  const recovery = captureRecoveryOptions(options);
  const client = recovery.gitClient;
  assertGitClient(client);
  await verifyResolvedStatePaths(value.statePaths);
  const store = createReservationStore(value.statePaths);
  let stored;
  try { stored = await store.get({ nodeId: value.nodeId, ownerId: value.ownerId, leaseId: value.leaseId }); }
  catch (error) { mapReservationError(error); }
  const reservation = stored.reservation;
  if (Date.parse(reservation.expiresAt) > recovery.nowMs) fail('stale-lease');

  const authority = evaluateAuthority(recovery.authority, {
    actorId: reservation.ownerId,
    action: 'git.worktree.recover',
    resource: reservation.leaseId,
  });
  if (authority.decision !== 'allow') fail('recovery-authority');

  const repository = await client.inspectRepository(value.projectRoot);
  if (repository.repositoryId !== reservation.repositoryId
    || repository.gitCommonDir !== value.statePaths.gitCommonDir) fail('repository-changed');
  const topology = await client.listWorktrees(repository.root);
  const atPath = topology.filter(item => item.path === reservation.worktreePath);
  const onBranch = topology.filter(item => item.branch === reservation.branch);
  let pathMetadata = null;
  try { pathMetadata = await lstat(reservation.worktreePath); }
  catch (error) { if (error.code !== 'ENOENT') fail('repository-changed'); }
  if (atPath.length > 1 || onBranch.length > 1
    || atPath.some(item => item.branch !== reservation.branch)
    || onBranch.some(item => item.path !== reservation.worktreePath)
    || (atPath.length === 0 && pathMetadata !== null)
    || (atPath.length === 1 && (pathMetadata === null || pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()))) {
    return Object.freeze({
      status: 'blocked', reason: 'topology-mismatch', reservation,
      evidence: Object.freeze({ changedPaths: Object.freeze([]), uncommittedPaths: Object.freeze([]) }),
    });
  }
  const branchTip = await client.branchTip(repository.root, reservation.branch);
  if (atPath.length === 1) {
    const worker = await client.inspectRepository(reservation.worktreePath);
    const changedPaths = await client.changedPaths(worker.root, reservation.baseSha, worker.headSha);
    const evidencePaths = await client.statusPaths(worker.root);
    if (evidencePaths.length > 0 || worker.headSha !== reservation.baseSha || changedPaths.length > 0) {
      return Object.freeze({
        status: 'blocked', reason: 'worker-evidence-preserved', reservation,
        evidence: Object.freeze({ changedPaths, uncommittedPaths: evidencePaths }),
      });
    }
  } else if (branchTip !== null && branchTip !== reservation.baseSha) {
    return Object.freeze({
      status: 'blocked', reason: 'topology-mismatch', reservation,
      evidence: Object.freeze({ changedPaths: Object.freeze([]), uncommittedPaths: Object.freeze([]) }),
    });
  }

  const approval = verifyApproval(recovery.approval, {
    subjectId: reservation.ownerId,
    action: 'git.worktree.recover',
    resource: `worktree-lease:${reservation.leaseId}`,
    policyId: 'worktree.stale-recovery',
  }, {
    registry: recovery.approvalRegistry,
    expectedApproverId: recovery.expectedApproverId,
    requireHumanApprover: true,
    requireSingleUse: true,
    nowMs: recovery.nowMs,
  });
  if (!approval.valid) fail('recovery-approval');

  try {
    await client.rollbackWorktreeCreation(repository.root, {
      path: reservation.worktreePath,
      branch: reservation.branch,
      baseSha: reservation.baseSha,
    });
    await recoverExpiredWithRetry(store, reservation, recovery.nowMs);
  } catch (error) {
    if (error instanceof ReservationError && error.details.reason === 'lease-mismatch') fail('lease-mismatch');
    fail('recovery-failed');
  }
  return Object.freeze({
    status: 'recovered', priorStatus: reservation.status, leaseId: reservation.leaseId,
    cleanup: atPath.length === 1 || branchTip !== null ? 'topology-and-reservation' : 'reservation-only',
  });
}
