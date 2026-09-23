import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { acquireLock, LockBusyError, StaleLockError } from '../state/lock.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from '../state/paths.js';

export class HostRunLockError extends Error {
  constructor(stale = false) {
    super(stale
      ? 'Host run lock needs inspection after an interrupted operation; no lock was removed automatically.'
      : 'Host run is busy. Read work status and retry with the current versions.');
    this.name = 'HostRunLockError';
    this.code = stale ? 'ERR_HOST_RUN_STALE_LOCK' : 'ERR_HOST_RUN_BUSY';
    this.safeMessage = this.message;
  }
}

export async function acquireHostRunLock(paths) {
  assertResolvedStatePaths(paths);
  if (paths.runDir !== paths.instanceDir) throw new TypeError('Host run paths are invalid');
  const deadline = Date.now() + 2_000;
  while (true) {
    await verifyResolvedStatePaths(paths);
    try { return await acquireLock(join(paths.runDir, 'host-operation.lock')); }
    catch (error) {
      if (error instanceof StaleLockError) throw new HostRunLockError(true);
      if (!(error instanceof LockBusyError)) throw error;
      if (Date.now() >= deadline) throw new HostRunLockError();
      await delay(10);
    }
  }
}
