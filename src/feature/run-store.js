import { createHash } from 'node:crypto';

import { immutableJson } from '../clients/contract.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { assertResolvedStatePaths } from '../state/paths.js';
import { validateWorkRequest } from '../work-request/contract.js';
import { featurePlanDigest, validateFeaturePlan } from './plan-contract.js';

const STATUSES = new Set(['proposed', 'approved', 'running', 'blocked', 'awaiting-final-approval', 'completed', 'cancelled']);
const TRANSITIONS = Object.freeze({
  proposed: new Set(['approved', 'cancelled']),
  approved: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'awaiting-final-approval', 'completed', 'cancelled']),
  blocked: new Set(['running', 'cancelled']),
  'awaiting-final-approval': new Set(['completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(),
});
const DIGEST = /^[a-f0-9]{64}$/;
const REF = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RECORD_KEYS = new Set([
  'schemaVersion', 'runId', 'status', 'workRequest', 'featurePlan', 'proposalDigest',
  'tracker', 'activation', 'runtimeRefs', 'evidenceRefs', 'createdAt', 'updatedAt',
]);

export class FeatureRunStoreError extends Error {
  constructor() {
    super('Feature run state is invalid.');
    this.name = 'FeatureRunStoreError';
    this.code = 'ERR_INVALID_FEATURE_RUN';
    this.safeMessage = this.message;
  }
}

export class FeatureRunVersionConflictError extends Error {
  constructor() {
    super('Feature run version conflict.');
    this.name = 'FeatureRunVersionConflictError';
    this.code = 'ERR_FEATURE_RUN_VERSION_CONFLICT';
    this.safeMessage = this.message;
  }
}

function fail() { throw new FeatureRunStoreError(); }

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function contentDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) fail();
  let normalized;
  try { normalized = new Date(value).toISOString(); } catch { fail(); }
  if (normalized !== value) fail();
  return value;
}

function exactRecord(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > keys.size || ownKeys.some(key => typeof key !== 'string' || !keys.has(key))
    || [...required].some(key => !ownKeys.includes(key))) fail();
  return value;
}

function refs(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256
    || value.some(ref => typeof ref !== 'string' || !REF.test(ref)) || new Set(value).size !== value.length) fail();
  return value;
}

function tracker(value, request) {
  if (value === null) {
    if (request.source.kind === 'jira' || request.source.kind === 'linear') fail();
    return null;
  }
  exactRecord(value, new Set(['provider', 'ticketId', 'capturedRevision', 'currentRevision', 'drifted', 'checkedAt']));
  if (value.provider !== request.source.kind || value.ticketId !== request.source.ref
    || value.capturedRevision !== request.source.revision || typeof value.currentRevision !== 'string'
    || value.currentRevision.length < 1 || value.currentRevision.length > 256
    || typeof value.drifted !== 'boolean' || value.drifted !== (value.currentRevision !== value.capturedRevision)) fail();
  timestamp(value.checkedAt);
  return value;
}

function activation(value, record) {
  if (value === null) return null;
  exactRecord(value, new Set(['approverId', 'approvedAt', 'requestDigest', 'proposalDigest']));
  if (typeof value.approverId !== 'string' || !ID.test(value.approverId)
    || value.requestDigest !== record.workRequest.digest || value.proposalDigest !== record.proposalDigest) fail();
  timestamp(value.approvedAt);
  return value;
}

function validateRecord(value, runId) {
  exactRecord(value, RECORD_KEYS);
  if (value.schemaVersion !== 1 || value.runId !== runId || !STATUSES.has(value.status)) fail();
  try { validateWorkRequest(value.workRequest); } catch { fail(); }
  if (!value.featurePlan || typeof value.featurePlan !== 'object' || Array.isArray(value.featurePlan)
    || typeof value.proposalDigest !== 'string' || !DIGEST.test(value.proposalDigest)
    || contentDigest(value.featurePlan) !== value.proposalDigest
    || value.featurePlan.workRequestDigest !== value.workRequest.digest) fail();
  tracker(value.tracker, value.workRequest);
  activation(value.activation, value);
  refs(value.runtimeRefs);
  refs(value.evidenceRefs);
  const created = timestamp(value.createdAt);
  const updated = timestamp(value.updatedAt);
  if (Date.parse(updated) < Date.parse(created) || value.status !== 'proposed' && value.activation === null) fail();
  return value;
}

function hydrate(snapshot, runId) {
  if (!snapshot || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) fail();
  const record = immutableJson({ ...snapshot.data, version: snapshot.version });
  const data = { ...record };
  delete data.version;
  validateRecord(data, runId);
  return record;
}

function createTracker(request, at) {
  if (request.source.kind !== 'jira' && request.source.kind !== 'linear') return null;
  if (!request.source.revision) fail();
  return {
    provider: request.source.kind,
    ticketId: request.source.ref,
    capturedRevision: request.source.revision,
    currentRevision: request.source.revision,
    drifted: false,
    checkedAt: at,
  };
}

function mapVersionConflict(error) {
  if (error?.code === 'ERR_STATE_VERSION_CONFLICT' || /state version conflict/i.test(error?.message ?? '')) {
    throw new FeatureRunVersionConflictError();
  }
  throw error;
}

export function createFeatureRunStore(paths) {
  assertResolvedStatePaths(paths);
  if (typeof paths.runId !== 'string' || !ID.test(paths.runId) || paths.runDir !== paths.instanceDir) fail();
  const snapshots = createSnapshotStore(paths, { environment: {} });

  async function read() {
    const snapshot = await snapshots.read();
    return snapshot === null ? null : hydrate(snapshot, paths.runId);
  }

  return Object.freeze({
    read,
    async readOnly() {
      const snapshot = await readSnapshotWithoutLock(paths);
      return snapshot === null ? null : hydrate(snapshot, paths.runId);
    },
    async create(input) {
      try {
        exactRecord(input, new Set(['workRequest', 'featurePlan', 'createdAt']));
        validateWorkRequest(input.workRequest);
        validateFeaturePlan(input.featurePlan);
        if (input.featurePlan.workRequestDigest !== input.workRequest.digest) fail();
        const createdAt = timestamp(input.createdAt);
        const record = {
          schemaVersion: 1,
          runId: paths.runId,
          status: 'proposed',
          workRequest: input.workRequest,
          featurePlan: input.featurePlan,
          proposalDigest: featurePlanDigest(input.featurePlan),
          tracker: createTracker(input.workRequest, createdAt),
          activation: null,
          runtimeRefs: [],
          evidenceRefs: [],
          createdAt,
          updatedAt: createdAt,
        };
        validateRecord(record, paths.runId);
        return hydrate(await snapshots.write(record, { expectedVersion: 0 }), paths.runId);
      } catch (error) {
        if (error instanceof FeatureRunStoreError || error instanceof FeatureRunVersionConflictError) throw error;
        try { mapVersionConflict(error); } catch (mapped) {
          if (mapped instanceof FeatureRunVersionConflictError) throw mapped;
        }
        fail();
      }
    },
    async update(input, options = {}) {
      try {
        const allowed = new Set(['status', 'updatedAt', 'activation', 'trackerRevision', 'runtimeRefs', 'evidenceRefs']);
        exactRecord(input, allowed, new Set(['status', 'updatedAt', 'runtimeRefs', 'evidenceRefs']));
        if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 1) fail();
        const current = await read();
        if (!current || current.version !== options.expectedVersion) throw new FeatureRunVersionConflictError();
        if (!STATUSES.has(input.status) || !TRANSITIONS[current.status].has(input.status)) fail();
        const updatedAt = timestamp(input.updatedAt);
        if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) fail();
        refs(input.runtimeRefs);
        refs(input.evidenceRefs);
        if (current.runtimeRefs.some(ref => !input.runtimeRefs.includes(ref))
          || current.evidenceRefs.some(ref => !input.evidenceRefs.includes(ref))) fail();
        const next = {
          ...current,
          status: input.status,
          updatedAt,
          runtimeRefs: input.runtimeRefs,
          evidenceRefs: input.evidenceRefs,
          activation: input.activation ?? current.activation,
        };
        delete next.version;
        if (current.activation && input.activation && canonical(current.activation) !== canonical(input.activation)) fail();
        if (input.trackerRevision !== undefined) {
          if (!current.tracker || typeof input.trackerRevision !== 'string' || input.trackerRevision.length < 1
            || input.trackerRevision.length > 256) fail();
          next.tracker = {
            ...current.tracker,
            currentRevision: input.trackerRevision,
            drifted: input.trackerRevision !== current.tracker.capturedRevision,
            checkedAt: updatedAt,
          };
        }
        validateRecord(next, paths.runId);
        return hydrate(await snapshots.write(next, { expectedVersion: options.expectedVersion }), paths.runId);
      } catch (error) {
        if (error instanceof FeatureRunStoreError || error instanceof FeatureRunVersionConflictError) throw error;
        try { mapVersionConflict(error); } catch (mapped) {
          if (mapped instanceof FeatureRunVersionConflictError) throw mapped;
        }
        fail();
      }
    },
  });
}
