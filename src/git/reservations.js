import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { acquireLock, LockBusyError } from '../state/lock.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from '../state/paths.js';

const RESERVATION_FILE = 'worktree-reservations.json';
const MAX_BYTES = 1024 * 1024;
const MAX_RESERVATIONS = 1_024;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[\]\u0000-\u0020\u007f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export class ReservationError extends Error {
  constructor(reason = 'invalid-reservation') {
    const messages = {
      'invalid-reservation': 'Worktree reservation input is invalid.',
      'state-version-conflict': 'Worktree reservation state changed concurrently.',
      'lease-collision': 'Worktree reservation collides with an active lease.',
      'stale-lease': 'Expired worktree lease requires explicit reconciliation.',
      'lease-mismatch': 'Worktree lease identity does not match.',
      'unsafe-state': 'Worktree reservation state is unsafe.',
      'state-exhausted': 'Worktree reservation state version is exhausted.',
      'lease-not-expired': 'Worktree lease has not expired.',
    };
    super(messages[reason] ?? messages['invalid-reservation']);
    this.name = 'ReservationError';
    this.code = `ERR_WORKTREE_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new ReservationError(reason); }

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateRegular(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600;
}

function captureObject(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-reservation');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-reservation'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-reservation');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail('invalid-reservation');
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof ReservationError) throw error;
    fail('invalid-reservation');
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-reservation');
  return result;
}

function canonicalRelative(value, allowDirectory = true) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || value.normalize('NFKC') !== value
    || isAbsolute(value) || /[\u0000\r\n\\:]/.test(value) || value.includes('//')) fail('invalid-reservation');
  const directory = allowDirectory && value.endsWith('/');
  const normalized = value.replace(/\/$/, '');
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.some(part => (
    !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    || part.toUpperCase().toLowerCase().normalize('NFKC') === '.git'
  ))) fail('invalid-reservation');
  return Object.freeze({ path: normalized, directory });
}

function capturePathList(value, limit, allowDirectory) {
  if (!Array.isArray(value)) fail('invalid-reservation');
  const result = [];
  try {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length === 0 || length > limit) fail('invalid-reservation');
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('invalid-reservation');
      result.push(canonicalRelative(value[index], allowDirectory));
    }
  } catch (error) {
    if (error instanceof ReservationError) throw error;
    fail('invalid-reservation');
  }
  const keys = result.map(item => `${item.path.toLocaleLowerCase('en-US')}${item.directory ? '/' : ''}`);
  if (new Set(keys).size !== keys.length) fail('invalid-reservation');
  return Object.freeze(result);
}

function pathContains(scope, path) {
  return scope.path === path || (scope.directory && path.startsWith(`${scope.path}/`));
}

function responsibilitiesOverlap(left, right) {
  const foldedContains = (scope, path) => {
    const leftPath = scope.path.toLocaleLowerCase('en-US');
    const rightPath = path.toLocaleLowerCase('en-US');
    return leftPath === rightPath || (scope.directory && rightPath.startsWith(`${leftPath}/`));
  };
  return left.some(a => right.some(b => foldedContains(a, b.path) || foldedContains(b, a.path)));
}

function cloneReservation(record) {
  return Object.freeze({
    ...record,
    responsibilities: Object.freeze(record.responsibilities.map(item => Object.freeze({ ...item }))),
    intendedPaths: Object.freeze([...record.intendedPaths]),
  });
}

function captureReservation(input, options = {}) {
  const source = captureObject(input, new Set([
    'projectRoot', 'statePaths', 'nodeId', 'branch', 'worktreePath', 'ownerId', 'baseSha',
    'responsibilities', 'intendedPaths', 'expiresAt', 'repositoryId',
  ]), [
    'nodeId', 'branch', 'worktreePath', 'ownerId', 'baseSha', 'responsibilities',
    'intendedPaths', 'expiresAt', 'repositoryId',
  ]);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !ID.test(source.nodeId) || source.nodeId.length > 64
    || !ID.test(source.ownerId) || source.ownerId.length > 64 || !BRANCH.test(source.branch)
    || source.branch.normalize('NFKC') !== source.branch || !REPOSITORY_ID.test(source.repositoryId)
    || !SHA.test(source.baseSha) || typeof source.worktreePath !== 'string' || source.worktreePath.length > 1_024
    || !isAbsolute(source.worktreePath) || resolve(source.worktreePath) !== source.worktreePath
    || /[\u0000\r\n]/.test(source.worktreePath)) fail('invalid-reservation');
  const expiryMs = Date.parse(source.expiresAt);
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= nowMs || expiryMs - nowMs > 90 * 24 * 60 * 60 * 1000
    || new Date(expiryMs).toISOString() !== source.expiresAt) fail('invalid-reservation');
  const responsibilities = capturePathList(source.responsibilities, 256, true);
  const intended = capturePathList(source.intendedPaths, 256, false);
  if (intended.some(path => path.directory || !responsibilities.some(scope => pathContains(scope, path.path)))) {
    fail('invalid-reservation');
  }
  return Object.freeze({
    schemaVersion: 1,
    leaseId: randomUUID(),
    nodeId: source.nodeId,
    branch: source.branch,
    worktreePath: source.worktreePath,
    ownerId: source.ownerId,
    baseSha: source.baseSha,
    repositoryId: source.repositoryId,
    responsibilities,
    intendedPaths: Object.freeze(intended.map(item => item.path)),
    expiresAt: source.expiresAt,
    status: 'reserved',
    cooperationBoundary: 'cooperating-orchestrator-actors',
  });
}

function validatePersistedReservation(value) {
  const expiryMs = Date.parse(value?.expiresAt);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.keys(value).length !== 13
    || value.schemaVersion !== 1 || !LEASE_ID.test(value.leaseId) || !ID.test(value.nodeId)
    || !BRANCH.test(value.branch) || typeof value.worktreePath !== 'string' || !isAbsolute(value.worktreePath)
    || resolve(value.worktreePath) !== value.worktreePath || !ID.test(value.ownerId) || !SHA.test(value.baseSha)
    || !REPOSITORY_ID.test(value.repositoryId) || !['reserved', 'active'].includes(value.status)
    || value.cooperationBoundary !== 'cooperating-orchestrator-actors'
    || !Array.isArray(value.responsibilities) || !Array.isArray(value.intendedPaths)
    || !Number.isSafeInteger(expiryMs) || new Date(expiryMs).toISOString() !== value.expiresAt) fail('unsafe-state');
  const responsibilities = value.responsibilities.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 2
      || typeof item.path !== 'string' || typeof item.directory !== 'boolean') fail('unsafe-state');
    const canonical = canonicalRelative(`${item.path}${item.directory ? '/' : ''}`, true);
    if (canonical.path !== item.path || canonical.directory !== item.directory) fail('unsafe-state');
    return canonical;
  });
  const intended = value.intendedPaths.map(path => canonicalRelative(path, false).path);
  if (intended.some(path => !responsibilities.some(scope => pathContains(scope, path)))) fail('unsafe-state');
  return cloneReservation({ ...value, responsibilities, intendedPaths: intended });
}

async function fileMetadata(path) {
  try {
    const metadata = await lstat(path);
    if (!privateRegular(metadata) || metadata.size <= 0 || metadata.size > MAX_BYTES) fail('unsafe-state');
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readState(path) {
  const before = await fileMetadata(path);
  if (!before) return Object.freeze({ schemaVersion: 1, version: 0, reservations: Object.freeze([]) });
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!privateRegular(opened) || !sameIdentity(before, opened)) fail('unsafe-state');
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) fail('unsafe-state');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('unsafe-state'); }
    const after = await lstat(path);
    if (!privateRegular(after) || !sameIdentity(opened, after) || after.size !== opened.size || !source.endsWith('\n')) fail('unsafe-state');
    let state;
    try { state = JSON.parse(source); } catch { fail('unsafe-state'); }
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).length !== 3
      || state.schemaVersion !== 1 || !Number.isSafeInteger(state.version) || state.version < 1
      || !Array.isArray(state.reservations) || state.reservations.length > MAX_RESERVATIONS) fail('unsafe-state');
    const reservations = state.reservations.map(validatePersistedReservation);
    if (new Set(reservations.map(item => item.leaseId)).size !== reservations.length) fail('unsafe-state');
    return Object.freeze({ schemaVersion: 1, version: state.version, reservations: Object.freeze(reservations) });
  } finally {
    await handle?.close();
  }
}

async function openPrivateDirectory(path) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700) fail('unsafe-state');
  const handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  const opened = await handle.stat();
  if (!opened.isDirectory() || !sameIdentity(before, opened)) {
    await handle.close();
    fail('unsafe-state');
  }
  return handle;
}

async function atomicWrite(paths, path, state) {
  const source = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(source) > MAX_BYTES) fail('unsafe-state');
  const temporary = join(paths.instanceDir, `.${basename(path)}.${randomUUID()}.tmp`);
  const targetBefore = await fileMetadata(path);
  const directory = await openPrivateDirectory(paths.instanceDir);
  let handle;
  let created;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    created = await handle.stat();
    if (!privateRegular(created) || created.size !== 0) fail('unsafe-state');
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    const written = await handle.stat();
    if (!privateRegular(written) || !sameIdentity(created, written) || written.size !== Buffer.byteLength(source)) fail('unsafe-state');
    await handle.close();
    handle = null;
    await verifyResolvedStatePaths(paths);
    const targetNow = await fileMetadata(path);
    if ((targetBefore === null) !== (targetNow === null)
      || (targetBefore && !sameIdentity(targetBefore, targetNow))) fail('unsafe-state');
    const currentTemp = await lstat(temporary);
    if (!privateRegular(currentTemp) || !sameIdentity(written, currentTemp)) fail('unsafe-state');
    await rename(temporary, path);
    try { await directory.sync(); } catch { fail('unsafe-state'); }
    const persisted = await fileMetadata(path);
    if (!persisted || !sameIdentity(persisted, written)) fail('unsafe-state');
  } catch (error) {
    if (created) {
      try {
        const current = await lstat(temporary);
        if (privateRegular(current) && sameIdentity(current, created)) await unlink(temporary);
      } catch {}
    }
    if (error instanceof ReservationError) throw error;
    fail('unsafe-state');
  } finally {
    await handle?.close();
    await directory.close();
  }
}

async function acquireWithRetry(path) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { return await acquireLock(path); } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

function collides(left, right) {
  const sameRepository = left.repositoryId === right.repositoryId;
  if (!sameRepository) return false;
  const folded = value => value.toLocaleLowerCase('en-US');
  const leftPath = folded(left.worktreePath);
  const rightPath = folded(right.worktreePath);
  const worktreeOverlap = leftPath === rightPath
    || leftPath.startsWith(`${rightPath}${sep}`)
    || rightPath.startsWith(`${leftPath}${sep}`);
  return folded(left.nodeId) === folded(right.nodeId)
    || folded(left.branch) === folded(right.branch)
    || worktreeOverlap
    || responsibilitiesOverlap(left.responsibilities, right.responsibilities);
}

function validateLeaseIdentity(value) {
  const identity = captureObject(value, new Set(['nodeId', 'ownerId', 'leaseId']), ['nodeId', 'ownerId', 'leaseId']);
  if (!ID.test(identity.nodeId) || !ID.test(identity.ownerId) || !LEASE_ID.test(identity.leaseId)) fail('lease-mismatch');
  return identity;
}

function operationOptions(value, allowClock) {
  const allowed = new Set(allowClock ? ['expectedVersion', 'nowMs'] : ['expectedVersion']);
  const options = captureObject(value, allowed, ['expectedVersion']);
  if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0
    || (allowClock && options.nowMs !== undefined && (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0))) {
    fail('invalid-reservation');
  }
  return Object.freeze(options);
}

function recoveryOptions(value) {
  const options = captureObject(value, new Set(['expectedVersion', 'nowMs']), ['expectedVersion', 'nowMs']);
  if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0
    || !Number.isSafeInteger(options.nowMs) || options.nowMs < 0) fail('invalid-reservation');
  return Object.freeze(options);
}

export function createReservationStore(paths) {
  assertResolvedStatePaths(paths);
  const path = join(paths.instanceDir, RESERVATION_FILE);

  async function withLock(operation) {
    await verifyResolvedStatePaths(paths);
    const lock = await acquireWithRetry(paths.lockPath);
    try {
      await verifyResolvedStatePaths(paths);
      return await operation();
    } finally {
      await lock.release();
    }
  }

  return Object.freeze({
    async readOnly() {
      await verifyResolvedStatePaths(paths);
      const state = await readState(path);
      await verifyResolvedStatePaths(paths);
      return Object.freeze({ version: state.version, reservations: Object.freeze(state.reservations.map(cloneReservation)) });
    },

    async list() {
      return withLock(async () => {
        const state = await readState(path);
        return Object.freeze({ version: state.version, reservations: Object.freeze(state.reservations.map(cloneReservation)) });
      });
    },

    async reserve(input, options = {}) {
      const capturedOptions = operationOptions(options, true);
      const candidate = captureReservation(input, capturedOptions);
      const expectedVersion = capturedOptions.expectedVersion;
      const nowMs = capturedOptions.nowMs ?? Date.now();
      return withLock(async () => {
        const state = await readState(path);
        if (state.version !== expectedVersion) fail('state-version-conflict');
        const collision = state.reservations.find(item => collides(item, candidate));
        if (collision) {
          if (Date.parse(collision.expiresAt) <= nowMs) fail('stale-lease');
          fail('lease-collision');
        }
        if (state.version >= Number.MAX_SAFE_INTEGER) fail('state-exhausted');
        if (state.reservations.length >= MAX_RESERVATIONS) fail('invalid-reservation');
        const next = { schemaVersion: 1, version: state.version + 1, reservations: [...state.reservations, candidate] };
        await atomicWrite(paths, path, next);
        return Object.freeze({ version: next.version, reservation: cloneReservation(candidate) });
      });
    },

    async activate(identityInput, options = {}) {
      const identity = validateLeaseIdentity(identityInput);
      const expectedVersion = operationOptions(options, false).expectedVersion;
      return withLock(async () => {
        const state = await readState(path);
        if (state.version !== expectedVersion) fail('state-version-conflict');
        const index = state.reservations.findIndex(item => item.leaseId === identity.leaseId);
        const found = state.reservations[index];
        if (!found || found.nodeId !== identity.nodeId || found.ownerId !== identity.ownerId || found.status !== 'reserved') fail('lease-mismatch');
        if (state.version >= Number.MAX_SAFE_INTEGER) fail('state-exhausted');
        const active = cloneReservation({ ...found, status: 'active' });
        const reservations = [...state.reservations];
        reservations[index] = active;
        const next = { schemaVersion: 1, version: state.version + 1, reservations };
        await atomicWrite(paths, path, next);
        return Object.freeze({ version: next.version, reservation: active });
      });
    },

    async rollback(identityInput, options = {}) {
      const identity = validateLeaseIdentity(identityInput);
      const expectedVersion = operationOptions(options, false).expectedVersion;
      return withLock(async () => {
        const state = await readState(path);
        if (state.version !== expectedVersion) fail('state-version-conflict');
        const found = state.reservations.find(item => item.leaseId === identity.leaseId);
        if (!found || found.nodeId !== identity.nodeId || found.ownerId !== identity.ownerId || found.status !== 'reserved') fail('lease-mismatch');
        if (state.version >= Number.MAX_SAFE_INTEGER) fail('state-exhausted');
        const next = {
          schemaVersion: 1,
          version: state.version + 1,
          reservations: state.reservations.filter(item => item.leaseId !== identity.leaseId),
        };
        await atomicWrite(paths, path, next);
        return Object.freeze({ version: next.version, removed: true });
      });
    },

    async recoverExpired(identityInput, options = {}) {
      const identity = validateLeaseIdentity(identityInput);
      const capturedOptions = recoveryOptions(options);
      return withLock(async () => {
        const state = await readState(path);
        if (state.version !== capturedOptions.expectedVersion) fail('state-version-conflict');
        const found = state.reservations.find(item => item.leaseId === identity.leaseId);
        if (!found || found.nodeId !== identity.nodeId || found.ownerId !== identity.ownerId) fail('lease-mismatch');
        if (Date.parse(found.expiresAt) > capturedOptions.nowMs) fail('lease-not-expired');
        if (state.version >= Number.MAX_SAFE_INTEGER) fail('state-exhausted');
        const next = {
          schemaVersion: 1,
          version: state.version + 1,
          reservations: state.reservations.filter(item => item.leaseId !== identity.leaseId),
        };
        await atomicWrite(paths, path, next);
        return Object.freeze({ version: next.version, removed: true, priorStatus: found.status });
      });
    },

    async get(identityInput) {
      const identity = validateLeaseIdentity(identityInput);
      return withLock(async () => {
        const state = await readState(path);
        const found = state.reservations.find(item => item.leaseId === identity.leaseId);
        if (!found || found.nodeId !== identity.nodeId || found.ownerId !== identity.ownerId) fail('lease-mismatch');
        return Object.freeze({ version: state.version, reservation: cloneReservation(found) });
      });
    },
  });
}
