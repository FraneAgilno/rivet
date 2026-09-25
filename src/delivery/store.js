import { acquireLock } from '../state/lock.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { verifyResolvedStatePaths } from '../state/paths.js';
import { ensure, hash, plain, validateRecord } from './contract.js';
const stores = new WeakSet();
export function isDeliveryStore(value) {
  return stores.has(value);
}
export function createDeliveryStore(paths, options = {}) {
  const snapshots = createSnapshotStore(paths, options.snapshotOptions ?? {});
  async function read() {
    const snapshot = await readSnapshotWithoutLock(paths);
    return snapshot === null ? null : plain({ ...validateRecord(snapshot.data), version: snapshot.version });
  }
  const store = Object.freeze({
    read,
    async write(input, { expectedVersion }) {
      const value = validateRecord(input);
      const prior = await read();
      ensure((prior?.version ?? 0) === expectedVersion, 'version-conflict');
      if (prior) {
        ensure(
          hash(prior.candidate) === hash(value.candidate) && value.createdAt === prior.createdAt,
          'state-conflict'
        );
        ensure(
          value.operations.length >= prior.operations.length &&
            prior.usedApprovalIds.every((id) => value.usedApprovalIds.includes(id)),
          'state-conflict'
        );
        for (let i = 0; i < prior.operations.length; i++) {
          const old = prior.operations[i],
            next = value.operations[i];
          const { state: oldState, receipt: oldReceipt, ...oldBinding } = old;
          const { state: nextState, receipt: nextReceipt, ...nextBinding } = next;
          ensure(hash(oldBinding) === hash(nextBinding), 'state-conflict');
          ensure(
            oldState === 'dispatching' || oldState === 'indeterminate'
              ? ['indeterminate', 'succeeded', 'not-applied'].includes(nextState)
              : oldState === nextState,
            'state-conflict'
          );
          if (old.state === 'succeeded' || old.state === 'not-applied')
            ensure(hash(old) === hash(next), 'state-conflict');
        }
      }
      const result = await snapshots.write(value, { expectedVersion, environment: {} });
      return plain({ ...result.data, version: result.version });
    },
    async exclusive(operation) {
      await verifyResolvedStatePaths(paths);
      const lock = await acquireLock(paths.operationLockPath ?? `${paths.snapshotPath}.operation.lock`);
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    },
  });
  stores.add(store);
  return store;
}
