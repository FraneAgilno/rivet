import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { validateEvent } from '../config/validate.js';
import { acquireLock, LockBusyError } from './lock.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from './paths.js';
import { redactSecrets } from './redact.js';

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 5;
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

export class StateVersionConflictError extends Error {
  constructor() {
    super('state version conflict');
    this.name = 'StateVersionConflictError';
    this.code = 'ERR_STATE_VERSION_CONFLICT';
  }
}

export class StateDurabilityError extends Error {
  constructor() {
    super('Private state durability is unsupported on this filesystem');
    this.name = 'StateDurabilityError';
    this.code = 'ERR_STATE_DURABILITY_UNSUPPORTED';
  }
}

async function existingMetadata(path, label) {
  try {
    const metadata = await lstat(path);
    if (!privateRegularFile(metadata)) throw new Error(`Unsafe ${label}`);
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBoundedUtf8(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error('Invalid event ledger');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new Error('Invalid event ledger');
  }
}

function parseLedger(source) {
  if (!source || !source.endsWith('\n')) throw new Error('Invalid event ledger');
  const lines = source.slice(0, -1).split('\n');
  const events = [];
  const eventIds = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index] || Buffer.byteLength(lines[index]) > MAX_EVENT_BYTES) throw new Error('Invalid event ledger');
    let event;
    try {
      event = JSON.parse(lines[index]);
      validateEvent(event);
    } catch {
      throw new Error('Invalid event ledger');
    }
    if (event.sequence !== index + 1 || eventIds.has(event.eventId)) throw new Error('Invalid event ledger');
    eventIds.add(event.eventId);
    events.push(event);
  }
  return events;
}

async function readOpenedLedger(handle, opened) {
  if (opened.size <= 0 || opened.size > MAX_LEDGER_BYTES) throw new Error('Invalid event ledger');
  return parseLedger(await readBoundedUtf8(handle, MAX_LEDGER_BYTES));
}

async function openExistingLedger(path, before, flags = constants.O_RDONLY) {
  if (!before || before.size <= 0 || before.size > MAX_LEDGER_BYTES) throw new Error('Invalid event ledger');
  const handle = await open(path, flags | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || !privateRegularFile(opened) || opened.size !== before.size) {
      throw new Error('Unsafe event ledger');
    }
    return { handle, opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readLedger(path) {
  const before = await existingMetadata(path, 'event ledger');
  if (!before) return [];
  const { handle, opened } = await openExistingLedger(path, before);
  try {
    const events = await readOpenedLedger(handle, opened);
    const after = await lstat(path);
    if (!privateRegularFile(after) || !sameIdentity(opened, after) || after.size !== opened.size) {
      throw new Error('Event ledger identity changed');
    }
    return events;
  } finally {
    await handle.close();
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
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function createLedger(path) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_RDWR | NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    const opened = await handle.stat();
    if (!privateRegularFile(opened) || opened.size !== 0) throw new Error('Unsafe event ledger');
    return { handle, opened };
  } catch (error) {
    await handle?.close();
    throw error.code === 'EEXIST' ? new Error('Event ledger identity changed') : error;
  }
}

async function removeCreatedLedger(path, expected) {
  try {
    const current = await lstat(path);
    if (privateRegularFile(current) && sameIdentity(current, expected)) await unlink(path);
  } catch {}
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

async function appendLine(handle, opened, path, line) {
  const lineBytes = Buffer.byteLength(line);
  if (opened.size + lineBytes > MAX_LEDGER_BYTES) throw new Error('Event ledger exceeds storage limit');
  await handle.writeFile(line, { encoding: 'utf8' });
  await handle.sync();
  const descriptorAfter = await handle.stat();
  const after = await lstat(path);
  if (
    !privateRegularFile(descriptorAfter)
    || !privateRegularFile(after)
    || !sameIdentity(opened, descriptorAfter)
    || !sameIdentity(descriptorAfter, after)
    || descriptorAfter.size !== opened.size + lineBytes
    || after.size !== descriptorAfter.size
  ) {
    throw new Error('Event ledger identity changed');
  }
}

async function closeHandles(handles) {
  const results = await Promise.allSettled(handles.filter(Boolean).map(handle => handle.close()));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
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
  const syncDirectory = options.syncDirectory ?? (async handle => {
    try {
      await handle.sync();
    } catch {
      throw new StateDurabilityError();
    }
  });
  if (typeof syncDirectory !== 'function') throw new TypeError('Invalid directory sync function');
  return Object.freeze({
    lockWaitMs: options.lockWaitMs,
    lockOptions: captureLockOptions(options.lockOptions),
    secretKeys: options.secretKeys,
    environment: options.environment,
    syncDirectory,
  });
}

function assertPaths(paths) {
  assertResolvedStatePaths(paths);
}

export function createEventStore(paths, options = {}) {
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
      return withLock(() => readLedger(paths.eventsPath));
    },
    async version() {
      return withLock(async () => (await readLedger(paths.eventsPath)).length);
    },
    async append(input, appendOptions = {}) {
      const expectedVersion = appendOptions.expectedVersion;
      const prepared = redactSecrets(input, {
        secretKeys: appendOptions.secretKeys ?? storeOptions.secretKeys,
        environment: appendOptions.environment ?? storeOptions.environment ?? process.env,
      });
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new TypeError('Append requires a non-negative expectedVersion');
      }
      validateEvent({ ...prepared, sequence: prepared?.sequence ?? 1 });
      return withLock(async () => {
        const directoryHandle = await openPrivateDirectory(paths.instanceDir);
        let ledgerHandle;
        try {
          const before = await existingMetadata(paths.eventsPath, 'event ledger');
          let opened;
          let events;
          let created = false;
          if (before) {
            ({ handle: ledgerHandle, opened } = await openExistingLedger(
              paths.eventsPath,
              before,
              constants.O_APPEND | constants.O_RDWR,
            ));
            await verifyResolvedStatePaths(paths);
            events = await readOpenedLedger(ledgerHandle, opened);
          } else {
            events = [];
          }
          const currentVersion = events.length;
          if (expectedVersion !== currentVersion) throw new StateVersionConflictError();
          const nextSequence = currentVersion + 1;
          if (prepared?.sequence !== undefined && prepared.sequence !== nextSequence) throw new Error('Event sequence conflict');
          const persisted = { ...prepared, sequence: nextSequence };
          validateEvent(persisted);
          if (events.some(event => event.eventId === persisted.eventId)) throw new Error('Duplicate event identifier');
          const line = `${JSON.stringify(persisted)}\n`;
          if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error('Event exceeds storage limit');
          if (!ledgerHandle) {
            ({ handle: ledgerHandle, opened } = await createLedger(paths.eventsPath));
            created = true;
            try {
              await verifyResolvedStatePaths(paths);
            } catch (error) {
              const createdHandle = ledgerHandle;
              ledgerHandle = null;
              try {
                await createdHandle.close();
              } finally {
                await removeCreatedLedger(paths.eventsPath, opened);
              }
              throw error;
            }
          }
          await appendLine(ledgerHandle, opened, paths.eventsPath, line);
          if (created) {
            try {
              await storeOptions.syncDirectory(directoryHandle);
            } catch (error) {
              if (error instanceof StateDurabilityError) throw error;
              throw new StateDurabilityError();
            }
          }
          return persisted;
        } finally {
          await closeHandles([ledgerHandle, directoryHandle]);
        }
      });
    },
  });
}
