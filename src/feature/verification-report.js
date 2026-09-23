import { immutableJson } from '../clients/contract.js';
import { isAbsolute, resolve } from 'node:path';
import { assertResolvedStatePaths } from '../state/paths.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class VerificationReportVersionConflictError extends Error {
  constructor() {
    super('Verification report changed during this attempt. Read work status before retrying.');
    this.name = 'VerificationReportVersionConflictError';
    this.code = 'ERR_VERIFICATION_REPORT_VERSION_CONFLICT';
    this.safeMessage = this.message;
  }
}

function bounded(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function diagnostic(value) {
  const source = typeof value === 'string' ? value : '';
  const omitted = source.length > 512;
  const marker = '[earlier output omitted]\n';
  return { text: omitted ? `${marker}${source.slice(-(512 - marker.length))}` : source, omitted };
}

function nextAction(status) {
  return status === 'pass'
    ? 'Review the integration diff and executed checks, then make the separate final delivery decision.'
    : 'Repair environment or dependencies in the unchanged integration checkout and retry work verify. Source fixes require a new reviewed proposal.';
}

function checkResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || value.id.length > 64
    || !['passed', 'failed'].includes(value.status)
    || typeof value.required !== 'boolean'
    || typeof value.cwd !== 'string' || value.cwd.length > 500
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || typeof value.executionStatus !== 'string' || value.executionStatus.length > 64
    || !value.output || typeof value.output !== 'object' || Array.isArray(value.output)) {
    throw new TypeError('Verification check is invalid');
  }
  return {
    id: value.id,
    status: value.status,
    required: value.required,
    cwd: value.cwd,
    exitCode: value.exitCode,
    executionStatus: value.executionStatus,
    output: {
      stdout: diagnostic(value.output.stdout).text,
      stderr: diagnostic(value.output.stderr).text,
      truncated: {
        stdout: value.output.truncated?.stdout === true || diagnostic(value.output.stdout).omitted,
        stderr: value.output.truncated?.stderr === true || diagnostic(value.output.stderr).omitted,
        combined: value.output.truncated?.combined === true
          || diagnostic(value.output.stdout).omitted || diagnostic(value.output.stderr).omitted,
      },
      redacted: value.output.redacted === true,
      suppressed: value.output.suppressed === true,
    },
  };
}

function valid(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.schemaVersion !== 1 || !['pass', 'fail'].includes(report.status)
    || !SHA.test(report.baselineCommit) || !SHA.test(report.commitSha)
    || typeof report.runId !== 'string' || report.runId.length > 64 || !ID.test(report.runId)
    || !Number.isSafeInteger(report.runVersion) || report.runVersion < 1
    || !Number.isSafeInteger(report.runtimeVersion) || report.runtimeVersion < 1
    || typeof report.integration?.path !== 'string' || report.integration.path.length > 4096
    || !isAbsolute(report.integration.path) || resolve(report.integration.path) !== report.integration.path
    || typeof report.integration?.branch !== 'string' || report.integration.branch.length > 256
    || /[\u0000-\u001f\u007f]/.test(report.integration.branch)
    || !Array.isArray(report.changedPaths) || report.changedPaths.length > 128
    || report.changedPaths.some(path => typeof path !== 'string' || path.length > 500)
    || !Number.isSafeInteger(report.changedPathCount) || report.changedPathCount < report.changedPaths.length
    || !Array.isArray(report.workerClaims) || report.workerClaims.length > 64
    || report.workerClaims.some(ref => typeof ref !== 'string' || ref.length > 256)
    || !Array.isArray(report.checks) || report.checks.length > 64
    || (report.failure !== null && (typeof report.failure !== 'string' || report.failure.length > 300))
    || typeof report.checkedAt !== 'string' || !Number.isFinite(Date.parse(report.checkedAt))
    || new Date(report.checkedAt).toISOString() !== report.checkedAt) {
    throw new TypeError('Verification report is invalid');
  }
  return immutableJson({
    schemaVersion: 1,
    runId: report.runId,
    runVersion: report.runVersion,
    runtimeVersion: report.runtimeVersion,
    status: report.status,
    baselineCommit: report.baselineCommit,
    commitSha: report.commitSha,
    integration: { path: report.integration.path, branch: report.integration.branch },
    changedPaths: report.changedPaths,
    changedPathCount: report.changedPathCount,
    workerClaims: report.workerClaims,
    checks: report.checks.map(checkResult),
    failure: report.failure,
    nextAction: nextAction(report.status),
    checkedAt: report.checkedAt,
  });
}

export function verificationReport(input) {
  const changedPaths = input.changedPaths.slice(0, 128);
  const workerNodes = new Set(input.state.graph.nodes.filter(node => node.owner?.role === 'worker').map(node => node.id));
  const workerClaims = input.state.evidence.filter(item => workerNodes.has(item.nodeId))
    .map(item => item.id).slice(0, 64);
  const checks = (input.quality?.gates ?? []).map(gate => ({
    id: gate.id,
    status: gate.status,
    required: gate.required,
    cwd: gate.cwd,
    exitCode: gate.exitCode,
    executionStatus: gate.executionStatus,
    output: {
      stdout: gate.output?.stdout ?? '',
      stderr: gate.output?.stderr ?? '',
      truncated: gate.output?.truncated ?? { stdout: false, stderr: false, combined: false },
      redacted: gate.output?.redacted === true,
      suppressed: gate.output?.suppressed === true,
    },
  }));
  return valid({
    schemaVersion: 1,
    runId: input.run.runId,
    runVersion: Number.isSafeInteger(input.run.version) ? input.run.version : 1,
    runtimeVersion: input.state.version,
    status: input.quality?.status === 'pass' ? 'pass' : 'fail',
    baselineCommit: input.run.featurePlan.baselineCommit,
    commitSha: input.commitSha,
    integration: { path: input.integration.path, branch: input.integration.branch },
    changedPaths,
    changedPathCount: input.changedPaths.length,
    workerClaims,
    checks,
    failure: input.failure === undefined ? null : bounded(input.failure, 300),
    nextAction: nextAction(input.quality?.status === 'pass' ? 'pass' : 'fail'),
    checkedAt: input.checkedAt,
  });
}

export function createVerificationReportStore(paths) {
  assertResolvedStatePaths(paths);
  const snapshots = createSnapshotStore(paths, { environment: {} });
  return Object.freeze({
    async readOnly() {
      const snapshot = await readSnapshotWithoutLock(paths);
      return snapshot === null ? null : immutableJson({ ...valid(snapshot.data), version: snapshot.version });
    },
    async write(report) {
      const data = valid(report);
      const version = await snapshots.version();
      let stored;
      try { stored = await snapshots.write(data, { expectedVersion: version, environment: {} }); }
      catch (error) {
        if (/state version conflict/i.test(error?.message ?? '')) throw new VerificationReportVersionConflictError();
        throw error;
      }
      return immutableJson({ ...valid(stored.data), version: stored.version });
    },
  });
}
