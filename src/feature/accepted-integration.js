import { isAbsolute, resolve } from 'node:path';

import { immutableJson } from '../clients/contract.js';
import { assertResolvedStatePaths } from '../state/paths.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function accepted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !ID.test(value.runId)
    || !SHA.test(value.baselineCommit) || !SHA.test(value.commitSha)
    || !Number.isSafeInteger(value.runtimeVersion) || value.runtimeVersion < 1
    || typeof value.path !== 'string' || value.path.length > 4096
    || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || typeof value.branch !== 'string' || value.branch.length > 256) {
    throw new TypeError('Accepted integration identity is invalid');
  }
  return immutableJson({
    schemaVersion: 1,
    runId: value.runId,
    baselineCommit: value.baselineCommit,
    commitSha: value.commitSha,
    runtimeVersion: value.runtimeVersion,
    path: value.path,
    branch: value.branch,
  });
}

export function createAcceptedIntegrationStore(paths) {
  assertResolvedStatePaths(paths);
  const snapshots = createSnapshotStore(paths, { environment: {} });
  return Object.freeze({
    async readOnly() {
      const snapshot = await readSnapshotWithoutLock(paths);
      return snapshot === null ? null : immutableJson({ ...accepted(snapshot.data), version: snapshot.version });
    },
    async write(value) {
      const data = accepted(value);
      const version = await snapshots.version();
      const stored = await snapshots.write(data, { expectedVersion: version, environment: {} });
      return immutableJson({ ...accepted(stored.data), version: stored.version });
    },
  });
}
