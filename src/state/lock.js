import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_LOCK_BYTES = 4 * 1024;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_INITIALIZATION_GRACE_MS = 5_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class LockBusyError extends Error {
  constructor(message = 'State lock is held by another owner') {
    super(message);
    this.name = 'LockBusyError';
    this.code = 'ERR_STATE_LOCKED';
  }
}

export class StaleLockError extends Error {
  constructor() {
    super('Stale state lock requires an explicit recovery command');
    this.name = 'StaleLockError';
    this.code = 'ERR_STALE_STATE_LOCK';
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600;
}

function validOwner(record) {
  return record
    && typeof record === 'object'
    && Object.keys(record).length === 4
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.host === 'string'
    && record.host.length > 0
    && record.host.length <= 255
    && typeof record.timestamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp)
    && Number.isFinite(Date.parse(record.timestamp))
    && typeof record.ownerId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.ownerId);
}

async function readBoundedUtf8(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error('Unsafe state lock file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new Error('Unsafe state lock file');
  }
}

function validateTiming(options = {}) {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0 || staleAfterMs > 24 * 60 * 60 * 1000) {
    throw new TypeError('Invalid state lock expiry');
  }
  if (typeof now !== 'function') throw new TypeError('Invalid state lock clock');
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid state lock clock');
  return { staleAfterMs, nowMs };
}

async function inspectLock(path) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!privateRegularFile(before) || before.size <= 0 || before.size > MAX_LOCK_BYTES) {
    throw new Error('Unsafe state lock file');
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || !privateRegularFile(opened)) throw new Error('Unsafe state lock file');
    const source = await readBoundedUtf8(handle, MAX_LOCK_BYTES);
    const after = await lstat(path);
    if (!privateRegularFile(after) || !sameIdentity(opened, after) || after.size !== opened.size) {
      throw new Error('State lock identity changed');
    }
    let owner;
    try {
      owner = JSON.parse(source);
    } catch {
      throw new Error('Unsafe state lock file');
    }
    if (!validOwner(owner)) throw new Error('Unsafe state lock file');
    return { owner, metadata: after };
  } finally {
    await handle?.close();
  }
}

async function initializingLock(path, staleAfterMs) {
  try {
    const metadata = await lstat(path);
    const ageMs = Date.now() - metadata.mtimeMs;
    return privateRegularFile(metadata)
      && metadata.size <= MAX_LOCK_BYTES
      && ageMs >= -1_000
      && ageMs < Math.min(staleAfterMs, MAX_INITIALIZATION_GRACE_MS);
  } catch (error) {
    return error.code === 'ENOENT' ? null : false;
  }
}

function stale(record, nowMs, staleAfterMs) {
  const timestamp = Date.parse(record.timestamp);
  if (timestamp > nowMs + 1_000) throw new Error('Unsafe state lock timestamp');
  return nowMs - timestamp >= staleAfterMs;
}

async function removeOwnedLock(path, expectedOwnerId, expectedMetadata) {
  const inspected = await inspectLock(path);
  if (!inspected
    || inspected.owner.ownerId !== expectedOwnerId
    || !sameIdentity(inspected.metadata, expectedMetadata)) {
    throw new Error('State lock ownership changed');
  }
  await unlink(path);
}

async function removeIfIdentityMatches(path, expectedMetadata) {
  try {
    const metadata = await lstat(path);
    if (privateRegularFile(metadata) && sameIdentity(metadata, expectedMetadata)) await unlink(path);
  } catch {}
}

export async function acquireLock(path, options = {}) {
  const { staleAfterMs, nowMs } = validateTiming(options);
  const owner = {
    pid: process.pid,
    host: hostname().slice(0, 255) || 'unknown-host',
    timestamp: new Date(nowMs).toISOString(),
    ownerId: randomUUID(),
  };
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let inspected;
    try {
      inspected = await inspectLock(path);
    } catch (inspectionError) {
      const initializing = await initializingLock(path, staleAfterMs);
      if (initializing === null) return acquireLock(path, options);
      if (initializing) throw new LockBusyError('State lock is initializing');
      throw inspectionError;
    }
    if (!inspected) return acquireLock(path, options);
    if (stale(inspected.owner, nowMs, staleAfterMs)) throw new StaleLockError();
    throw new LockBusyError();
  }

  let created;
  try {
    created = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' });
    await handle.sync();
    const metadata = await handle.stat();
    if (!privateRegularFile(metadata)) throw new Error('Unsafe state lock file');
    let released = false;
    return Object.freeze({
      owner: Object.freeze({ ...owner }),
      async release() {
        if (released) return;
        await removeOwnedLock(path, owner.ownerId, metadata);
        released = true;
      },
    });
  } catch (error) {
    if (created) await removeIfIdentityMatches(path, created);
    throw error;
  } finally {
    await handle.close();
  }
}

export async function recoverStaleLock(path, options = {}) {
  const { staleAfterMs, nowMs } = validateTiming(options);
  const inspected = await inspectLock(path);
  if (!inspected) return false;
  if (!stale(inspected.owner, nowMs, staleAfterMs)) throw new LockBusyError();
  await removeOwnedLock(path, inspected.owner.ownerId, inspected.metadata);
  return true;
}

function requireDeadLocalOwner(owner) {
  if (owner.host !== hostname()) throw new LockBusyError('Cannot recover a lock from another host');
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw new LockBusyError('Cannot establish that the lock owner exited');
  }
  throw new LockBusyError('State lock owner is still running');
}

/**
 * Recover only an abandoned local lock. Unlike legacy recoverStaleLock, age alone
 * never grants recovery. The permanent per-owner claim serializes all recoverers
 * that observed that owner, including a recoverer delayed past a new acquisition.
 * An interrupted claim deliberately needs manual investigation; do not remove it
 * automatically. This assumes participants use this recovery protocol (not legacy
 * age-only recovery) and a private directory, not arbitrary external replacement.
 */
export async function recoverAbandonedLock(path, options = {}) {
  const { nowMs } = validateTiming({ now: options.now });
  const inspected = await inspectLock(path);
  if (!inspected) return false;
  if (!stale(inspected.owner, nowMs, DEFAULT_STALE_AFTER_MS)) throw new LockBusyError();
  requireDeadLocalOwner(inspected.owner);
  const claimPath = `${path}.recovered-${inspected.owner.ownerId}`;
  let claim;
  try {
    claim = await open(claimPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new LockBusyError('Lock recovery was already claimed; manual investigation required');
    throw error;
  }
  try {
    await claim.chmod(0o600);
    await claim.writeFile(`${JSON.stringify(inspected.owner)}\n`, { encoding: 'utf8' });
    await claim.sync();
  } finally {
    await claim.close();
  }
  // Recheck identity, owner, file safety and liveness after winning the claim.
  // No other conforming recoverer can unlink this owner, and its process is dead.
  const current = await inspectLock(path);
  if (!current || current.owner.ownerId !== inspected.owner.ownerId
      || !sameIdentity(current.metadata, inspected.metadata)) throw new Error('State lock ownership changed');
  requireDeadLocalOwner(current.owner);
  await removeOwnedLock(path, inspected.owner.ownerId, inspected.metadata);
  return true;
}
