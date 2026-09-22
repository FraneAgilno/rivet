import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadProjectConfig } from '../../src/config/load.js';
import { createFeaturePlan, featurePlanDigest } from '../../src/feature/plan-contract.js';
import { FeatureRunStoreError, createFeatureRunStore } from '../../src/feature/run-store.js';
import { resolveFeatureRunPaths } from '../../src/state/paths.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const execFile = promisify(execFileCallback);
const CONFIG_ROOT = new URL('../fixtures/config/valid/', import.meta.url).pathname;
const BASELINE = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2029-01-01T00:00:00.000Z';

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'rivet-feature-run-'));
  await execFile('git', ['init', '--quiet', root]);
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await execFile('git', ['-C', root, 'add', 'README.md']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

function workRequest() {
  return createWorkRequest({
    source: { kind: 'linear', ref: 'DEMO-123', revision: 'v1#sha256:' + 'a'.repeat(64), url: 'https://linear.app/example/issue/DEMO-123/feature' },
    title: 'Smart agenda builder', description: 'Build a deterministic agenda.',
    acceptanceCriteria: ['Preserve accepted sessions'], contextRefs: [], capturedAt: NOW,
  });
}

function budget(timeMinutes, tokenLimit, costUsd, taskLimit) {
  return { timeMinutes, tokenLimit, costUsd, taskLimit };
}

async function featurePlan(request) {
  const config = await loadProjectConfig(CONFIG_ROOT);
  const proposal = {
    schemaVersion: 1, id: 'smart-agenda-builder', baselineCommit: BASELINE,
    workRequestDigest: request.digest, client: 'codex', providerRefs: ['git-ci-main'],
    nodes: [
      { id: 'activation', role: 'boss', roleId: 'portfolio-boss', objective: 'Approve.', dependencies: [], ownedPaths: [], authorityScopes: ['plan', 'implement', 'delegate', 'verify'], commandIds: [], budget: budget(60, 50_000, 10, 10), requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], acceptanceCriteria: [], status: 'proposed', approvalGate: 'activation' },
      { id: 'management', parentId: 'activation', role: 'manager', roleId: 'engineering-manager', objective: 'Coordinate.', dependencies: ['activation'], ownedPaths: [], authorityScopes: ['implement', 'delegate', 'verify'], commandIds: [], budget: budget(60, 50_000, 10, 10), requiredEvidenceTypes: ['commit', 'test'], acceptanceCriteria: [], status: 'proposed' },
      { id: 'implementation', parentId: 'management', role: 'worker', roleId: 'implementation-worker', objective: 'Implement.', dependencies: ['management'], ownedPaths: ['app/agenda'], authorityScopes: ['implement', 'verify'], commandIds: ['build', 'test'], budget: budget(30, 20_000, 4, 4), requiredEvidenceTypes: ['commit', 'test'], acceptanceCriteria: ['Preserve accepted sessions'], status: 'proposed' },
      { id: 'final-delivery', parentId: 'activation', role: 'boss', roleId: 'portfolio-boss', objective: 'Approve delivery.', dependencies: ['implementation'], ownedPaths: [], authorityScopes: ['verify'], commandIds: ['build', 'test', 'lint'], budget: budget(60, 50_000, 10, 10), requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'], acceptanceCriteria: [], status: 'proposed', approvalGate: 'final-delivery' },
    ],
  };
  return createFeaturePlan({ proposal, config, workRequest: request, baselineCommit: BASELINE, client: 'codex' });
}

async function setup(runId = 'run-smart-agenda') {
  const root = await repository();
  const request = workRequest();
  const plan = await featurePlan(request);
  const paths = await resolveFeatureRunPaths(root, runId);
  return { root, request, plan, paths, store: createFeatureRunStore(paths) };
}

test('creates one private checksum-bound run snapshot with owner-only permissions', async () => {
  const { request, plan, paths, store } = await setup();
  const record = await store.create({ workRequest: request, featurePlan: plan, createdAt: NOW });

  assert.equal(record.version, 1);
  assert.equal(record.runId, 'run-smart-agenda');
  assert.equal(record.status, 'proposed');
  assert.equal(record.workRequest.digest, request.digest);
  assert.equal(record.proposalDigest, featurePlanDigest(plan));
  assert.deepEqual({ ...record.tracker }, {
    provider: 'linear', ticketId: 'DEMO-123', capturedRevision: request.source.revision,
    currentRevision: request.source.revision, drifted: false, checkedAt: NOW,
  });
  assert.equal(record.activation, null);
  assert.deepEqual(record.runtimeRefs, []);
  assert.deepEqual(record.evidenceRefs, []);
  assert.equal((await lstat(paths.runDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(paths.snapshotPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(paths.snapshotPath, 'utf8')).includes('/private/tmp/'), false);
});

test('uses expected-version CAS for activation, tracker drift, runtime, and evidence facts', async () => {
  const { request, plan, store } = await setup('run-cas');
  await store.create({ workRequest: request, featurePlan: plan, createdAt: NOW });
  const proposalDigest = featurePlanDigest(plan);
  const activated = await store.update({
    status: 'approved', updatedAt: '2029-01-01T00:01:00.000Z',
    activation: { approverId: 'human-owner', approvedAt: '2029-01-01T00:01:00.000Z', requestDigest: request.digest, proposalDigest },
    trackerRevision: 'v2#sha256:' + 'b'.repeat(64), runtimeRefs: ['graph:smart-agenda'], evidenceRefs: ['approval:activation'],
  }, { expectedVersion: 1 });

  assert.equal(activated.version, 2);
  assert.equal(activated.tracker.drifted, true);
  assert.equal(activated.tracker.checkedAt, '2029-01-01T00:01:00.000Z');
  assert.deepEqual(activated.runtimeRefs, ['graph:smart-agenda']);
  await assert.rejects(() => store.update({
    status: 'running', updatedAt: '2029-01-01T00:02:00.000Z', runtimeRefs: [], evidenceRefs: [],
  }, { expectedVersion: 1 }), error => error.code === 'ERR_FEATURE_RUN_VERSION_CONFLICT');
  assert.equal((await store.read()).version, 2);
});

test('allows only one concurrent no-replace creation to win', async () => {
  const { request, plan, paths } = await setup('run-create-race');
  const input = { workRequest: request, featurePlan: plan, createdAt: NOW };
  const results = await Promise.allSettled([
    createFeatureRunStore(paths).create(input),
    createFeatureRunStore(paths).create(input),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('linked worktrees resolve the same feature run by repository identity', async () => {
  const root = await repository();
  const parent = await mkdtemp(join(tmpdir(), 'rivet-feature-linked-'));
  const linked = join(parent, 'linked');
  await execFile('git', ['-C', root, 'worktree', 'add', '--quiet', '-b', 'linked-feature', linked]);
  const primary = await resolveFeatureRunPaths(root, 'run-shared');
  const secondary = await resolveFeatureRunPaths(linked, 'run-shared');
  assert.equal(primary.gitCommonDir, secondary.gitCommonDir);
  assert.equal(primary.runDir, secondary.runDir);
});

test('rejects symlinked storage, extra secret fields, absolute refs, and mismatched activation bindings', async () => {
  const outsideRoot = await repository();
  const outside = await mkdtemp(join(tmpdir(), 'rivet-feature-outside-'));
  await symlink(outside, join(outsideRoot, '.git', 'rivet'));
  await assert.rejects(() => resolveFeatureRunPaths(outsideRoot, 'run-unsafe'), /outside the Git common directory/);

  const { request, plan, store } = await setup('run-invalid');
  await assert.rejects(() => store.create({ workRequest: request, featurePlan: plan, createdAt: NOW, rawPrompt: 'secret' }), FeatureRunStoreError);
  await store.create({ workRequest: request, featurePlan: plan, createdAt: NOW });
  await assert.rejects(() => store.update({
    status: 'approved', updatedAt: NOW, runtimeRefs: ['/private/tmp/worktree'], evidenceRefs: [],
    activation: { approverId: 'human-owner', approvedAt: NOW, requestDigest: 'f'.repeat(64), proposalDigest: featurePlanDigest(plan) },
  }, { expectedVersion: 1 }), FeatureRunStoreError);
});
