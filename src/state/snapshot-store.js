import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { acquireLock, LockBusyError } from './lock.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from './paths.js';
import { redactSecrets } from './redact.js';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 2_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600;
}

export class StateVersionExhaustedError extends Error {
  constructor() {
    super('state version is exhausted');
    this.name = 'StateVersionExhaustedError';
    this.code = 'ERR_STATE_VERSION_EXHAUSTED';
  }
}

export class SnapshotDurabilityError extends Error {
  constructor() {
    super('Private snapshot durability is unsupported on this filesystem');
    this.name = 'SnapshotDurabilityError';
    this.code = 'ERR_STATE_DURABILITY_UNSUPPORTED';
  }
}

async function metadataOrNull(path) {
  try {
    const metadata = await lstat(path);
    if (!privateRegularFile(metadata)) throw new Error('Unsafe state snapshot');
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validSnapshot(snapshot) {
  return snapshot
    && typeof snapshot === 'object'
    && !Array.isArray(snapshot)
    && Object.keys(snapshot).length === 2
    && Number.isSafeInteger(snapshot.version)
    && snapshot.version >= 1
    && Object.hasOwn(snapshot, 'data');
}

async function readBoundedUtf8(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error('Invalid state snapshot');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new Error('Invalid state snapshot');
  }
}

async function readSnapshot(path) {
  const before = await metadataOrNull(path);
  if (!before) return null;
  if (before.size <= 0 || before.size > MAX_SNAPSHOT_BYTES) throw new Error('Invalid state snapshot');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!privateRegularFile(opened) || !sameIdentity(before, opened)) throw new Error('Unsafe state snapshot');
    const source = await readBoundedUtf8(handle, MAX_SNAPSHOT_BYTES);
    const after = await lstat(path);
    if (!privateRegularFile(after) || !sameIdentity(opened, after) || after.size !== opened.size) {
      throw new Error('State snapshot identity changed');
    }
    if (!source.endsWith('\n')) throw new Error('Invalid state snapshot');
    let snapshot;
    try { snapshot = JSON.parse(source); } catch { throw new Error('Invalid state snapshot'); }
    if (!validSnapshot(snapshot)) throw new Error('Invalid state snapshot');
    return snapshot;
  } finally {
    await handle?.close();
  }
}

async function acquireWithRetry(path, options) {
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) {
    throw new TypeError('Invalid state lock wait');
  }
  const deadline = Date.now() + lockWaitMs;
  while (true) {
    try {
      return await acquireLock(path, options.lockOptions);
    } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

async function openPrivateDirectory(path) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700) {
    throw new Error('Private state path identity changed');
  }
  const handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(before, opened)) throw new Error('Private state path identity changed');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyPrivateDirectory(paths, handle) {
  await verifyResolvedStatePaths(paths);
  const [opened, current] = await Promise.all([handle.stat(), lstat(paths.instanceDir)]);
  if (!opened.isDirectory() || !current.isDirectory() || !sameIdentity(opened, current)) {
    throw new Error('Private state path identity changed');
  }
}

async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch {
    throw new SnapshotDurabilityError();
  }
}

async function cleanupTemporary(paths, directoryHandle, temporaryPath, expected) {
  if (!expected) return;
  try {
    await verifyPrivateDirectory(paths, directoryHandle);
    const current = await lstat(temporaryPath);
    if (privateRegularFile(current) && sameIdentity(current, expected)) await unlink(temporaryPath);
  } catch {}
}

async function atomicWrite(paths, source, temporaryId, directoryHandle) {
  const path = paths.snapshotPath;
  const temporaryPath = join(paths.instanceDir, `.${basename(path)}.${temporaryId}.tmp`);
  const targetBefore = await metadataOrNull(path);
  let handle;
  let createdMetadata;
  let temporaryMetadata;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
    createdMetadata = await handle.stat();
    if (!privateRegularFile(createdMetadata) || createdMetadata.size !== 0) {
      throw new Error('Unsafe state snapshot temporary file');
    }
    await handle.chmod(0o600);
    await handle.writeFile(source, { encoding: 'utf8' });
    await handle.sync();
    temporaryMetadata = await handle.stat();
    if (
      !privateRegularFile(temporaryMetadata)
      || !sameIdentity(createdMetadata, temporaryMetadata)
      || temporaryMetadata.size !== Buffer.byteLength(source)
    ) {
      throw new Error('State snapshot temporary identity changed');
    }
    await handle.close();
    handle = null;
    await verifyPrivateDirectory(paths, directoryHandle);
    const targetNow = await metadataOrNull(path);
    if (
      (targetBefore === null) !== (targetNow === null)
      || (targetBefore && !sameIdentity(targetBefore, targetNow))
    ) {
      throw new Error('State snapshot identity changed');
    }
    const temporaryNow = await lstat(temporaryPath);
    if (!privateRegularFile(temporaryNow) || !sameIdentity(temporaryNow, temporaryMetadata)) {
      throw new Error('State snapshot temporary identity changed');
    }
    await rename(temporaryPath, path);
    await syncDirectory(directoryHandle);
    const persisted = await metadataOrNull(path);
    if (!persisted || !sameIdentity(persisted, temporaryMetadata)) throw new Error('State snapshot was not persisted');
  } catch (error) {
    await cleanupTemporary(paths, directoryHandle, temporaryPath, temporaryMetadata ?? createdMetadata);
    if (error.code === 'EEXIST') throw new Error('Unsafe state snapshot temporary file');
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertPaths(paths) {
  assertResolvedStatePaths(paths);
}

function captureLockOptions(lockOptions) {
  if (lockOptions === undefined) return undefined;
  if (!lockOptions || typeof lockOptions !== 'object') throw new TypeError('Invalid state lock options');
  return Object.freeze({
    staleAfterMs: lockOptions.staleAfterMs,
    now: lockOptions.now,
  });
}

function captureStoreOptions(options) {
  const beforeCommit = options.beforeCommit;
  const temporaryIdFactory = options.temporaryIdFactory ?? randomUUID;
  if (beforeCommit !== undefined && typeof beforeCommit !== 'function') {
    throw new TypeError('Invalid snapshot hook');
  }
  if (typeof temporaryIdFactory !== 'function') throw new TypeError('Invalid snapshot temporary ID factory');
  return Object.freeze({
    lockWaitMs: options.lockWaitMs,
    lockOptions: captureLockOptions(options.lockOptions),
    secretKeys: options.secretKeys,
    environment: options.environment,
    beforeCommit,
    temporaryIdFactory,
  });
}

export function createSnapshotStore(paths, options = {}) {
  assertPaths(paths);
  const storeOptions = captureStoreOptions(options);

  async function withLock(operation) {
    await verifyResolvedStatePaths(paths);
    const lock = await acquireWithRetry(paths.lockPath, storeOptions);
    try {
      await verifyResolvedStatePaths(paths);
      return await operation();
    } finally {
      await lock.release();
    }
  }

  return Object.freeze({
    async read() {
      return withLock(() => readSnapshot(paths.snapshotPath));
    },
    async version() {
      return withLock(async () => (await readSnapshot(paths.snapshotPath))?.version ?? 0);
    },
    async write(data, writeOptions = {}) {
      const expectedVersion = writeOptions.expectedVersion;
      const preparedData = redactSecrets(data, {
        secretKeys: writeOptions.secretKeys ?? storeOptions.secretKeys,
        environment: writeOptions.environment ?? storeOptions.environment ?? process.env,
      });
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new TypeError('Snapshot write requires a non-negative expectedVersion');
      }
      if (storeOptions.beforeCommit) await storeOptions.beforeCommit();
      const temporaryId = storeOptions.temporaryIdFactory();
      if (typeof temporaryId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(temporaryId)) {
        throw new TypeError('Invalid snapshot temporary identifier');
      }
      return withLock(async () => {
        const directoryHandle = await openPrivateDirectory(paths.instanceDir);
        try {
          await verifyPrivateDirectory(paths, directoryHandle);
          const current = await readSnapshot(paths.snapshotPath);
          const currentVersion = current?.version ?? 0;
          if (expectedVersion !== currentVersion) throw new Error('state version conflict');
          if (currentVersion >= Number.MAX_SAFE_INTEGER) throw new StateVersionExhaustedError();
          const snapshot = {
            version: currentVersion + 1,
            data: preparedData,
          };
          const source = `${JSON.stringify(snapshot)}\n`;
          if (Buffer.byteLength(source) > MAX_SNAPSHOT_BYTES) throw new Error('State snapshot exceeds storage limit');
          await atomicWrite(paths, source, temporaryId, directoryHandle);
          return snapshot;
        } finally {
          await directoryHandle.close();
        }
      });
    },
  });
}
