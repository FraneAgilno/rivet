import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { immutableJson } from '../clients/contract.js';
import { acquireLock, LockBusyError } from '../state/lock.js';
import { assertResolvedStatePaths } from '../state/paths.js';
import { createSnapshotStore } from '../state/snapshot-store.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class RuntimeInstanceStoreError extends Error {
  constructor(reason = 'invalid-instance') {
    const messages = {
      'invalid-instance': 'Runtime instance configuration is invalid.',
      'lock-required': 'Runtime instance operation requires the acquired outer lock.',
      'version-conflict': 'Runtime instance state version changed concurrently.',
    };
    super(messages[reason] ?? messages['invalid-instance']);
    this.name = 'RuntimeInstanceStoreError';
    this.code = reason === 'version-conflict' ? 'ERR_STATE_VERSION_CONFLICT' : `ERR_RUNTIME_INSTANCE_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new RuntimeInstanceStoreError(reason); }

function capture(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-instance');
    const allowed = new Set(['id', 'paths', 'initialState']);
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-instance');
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-instance');
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeInstanceStoreError) throw error;
    fail('invalid-instance');
  }
}

async function acquireOuter(path) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { return await acquireLock(path); } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

export function createRuntimeInstance(input) {
  const value = capture(input);
  if (typeof value.id !== 'string' || value.id.length > 64 || !ID.test(value.id)) fail('invalid-instance');
  try { assertResolvedStatePaths(value.paths); } catch { fail('invalid-instance'); }
  if (basename(value.paths.instanceDir) !== value.id
    || typeof value.paths.runtimeLockPath !== 'string') fail('invalid-instance');
  const initialState = immutableJson(value.initialState, 'invalid-contract');
  if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)
    || initialState.version !== 0) fail('invalid-instance');
  const snapshots = createSnapshotStore(value.paths, { environment: {} });
  let held = false;

  async function rawSnapshot() {
    let snapshot = await snapshots.read();
    if (snapshot === null) snapshot = await snapshots.write(initialState, { expectedVersion: 0, environment: {} });
    return snapshot;
  }

  return Object.freeze({
    id: value.id,
    async acquire() {
      const outer = await acquireOuter(value.paths.runtimeLockPath);
      held = true;
      let released = false;
      return Object.freeze({
        async release() {
          if (released) return;
          await outer.release();
          released = true;
          held = false;
        },
      });
    },
    async read() {
      if (!held) fail('lock-required');
      return immutableJson((await rawSnapshot()).data, 'invalid-contract');
    },
    async commit(expectedVersion, nextState) {
      if (!held) fail('lock-required');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('invalid-instance');
      const next = immutableJson(nextState, 'invalid-contract');
      if (!next || typeof next !== 'object' || Array.isArray(next)
        || next.version !== expectedVersion + 1) fail('invalid-instance');
      const current = await rawSnapshot();
      if (current.data?.version !== expectedVersion) fail('version-conflict');
      try {
        const persisted = await snapshots.write(next, { expectedVersion: current.version, environment: {} });
        return immutableJson(persisted.data, 'invalid-contract');
      } catch (error) {
        if (/state version conflict/i.test(error?.message ?? '')) fail('version-conflict');
        throw error;
      }
    },
  });
}
