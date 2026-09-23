import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { featurePlanDigest } from '../../src/feature/plan-contract.js';
import { createFeaturePlanner, createHostFeaturePlan } from '../../src/feature/planner.js';
import { createFeatureRunStore } from '../../src/feature/run-store.js';
import { resolveFeatureRunPaths } from '../../src/state/paths.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);
const NOW = '2029-01-01T00:00:00.000Z';
const BASELINE = 'a'.repeat(40);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-human-task-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q']);
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  return root;
}

async function createRun(root, runId, client = 'codex') {
  const config = await loadProjectConfig(root);
  const workRequest = createWorkRequest({
    source: { kind: 'inline', ref: 'inline' }, title: `Task ${runId}`,
    description: `Implement task ${runId}.`, acceptanceCriteria: [`Complete ${runId}`],
    contextRefs: [], capturedAt: NOW,
  });
  const decomposition = {
    schemaVersion: 1, kind: 'agilno.feature-decomposition',
    workItems: [{ objective: `Complete ${runId}`, ownedPaths: ['app/agenda.js'], acceptanceCriterionIndexes: [1] }],
  };
  const featurePlan = client === 'host'
    ? createHostFeaturePlan({ config, workRequest, baselineCommit: BASELINE, decomposition })
    : await createFeaturePlanner({ planningClient: { async propose() { return decomposition; } } })
      .propose({ config, workRequest, baselineCommit: BASELINE, client });
  const store = createFeatureRunStore(await resolveFeatureRunPaths(root, runId));
  const record = await store.create({ workRequest, featurePlan, createdAt: NOW });
  assert.equal(record.proposalDigest, featurePlanDigest(featurePlan));
  return { store, record };
}

function overrides(root, messages, services = {}) {
  return {
    cwd: () => root,
    output: { log: value => messages.push(value), error: value => messages.push(value), json() {} },
    work: { async status() { return { run: { status: 'proposed' }, nextAction: 'Review the proposal.', verification: null, checkout: null }; } },
    ...services,
  };
}

test('task status selects the sole project-local run without an ID or project flag', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  const messages = [];
  assert.equal(await main(['task', 'status'], overrides(root, messages)), EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'), /Task: Complete first-task/);
  assert.match(messages.join('\n'), /Next: Review the proposal/);
});

test('task deps selects the run but refuses installation before an accepted checkout exists', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  const messages = [];
  let confirmations = 0;
  const result = await main(['task', 'deps'], overrides(root, messages, {
    terminalIsInteractive: () => true,
    confirmDependencyInstall: async () => { confirmations += 1; return true; },
    resolveCommandExecutable: async () => '/usr/bin/git',
  }));
  assert.equal(result, EXIT_CODES.REPOSITORY_CONFLICT, messages.join('\n'));
  assert.equal(confirmations, 0);
  assert.match(messages.join('\n'), /no eligible isolated checkout/);
});

test('multiple or corrupt private runs cannot be silently inferred', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  await createRun(root, 'second-task');
  const messages = [];
  assert.equal(await main(['task', 'status'], overrides(root, messages)), EXIT_CODES.INVALID_INPUT);
  assert.match(messages.join('\n'), /first-task.*second-task/s);
  const paths = await resolveFeatureRunPaths(root, 'second-task');
  await writeFile(paths.snapshotPath, '{broken\n', { mode: 0o600 });
  const after = [];
  assert.equal(await main(['task', 'status'], overrides(root, after)), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.match(after.join('\n'), /unsafe state|discovery failed/i);
});

test('host resume gives guidance without launching a spawned worker', async t => {
  const root = await fixture(t);
  await createRun(root, 'host-task', 'host');
  const messages = [];
  const services = overrides(root, messages, {
    feature: { async resume() { throw new Error('must not spawn'); } },
  });
  assert.equal(await main(['task', 'resume'], services), EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'), /Continue in the coding harness/);
});

test('task status presents the stored check evidence and source paths', async t => {
  const root = await fixture(t);
  await createRun(root, 'checked-task');
  const messages = [];
  const services = overrides(root, messages, {
    work: { async status() { return {
      run: { status: 'blocked' }, nextAction: 'Repair the environment.',
      verification: {
        status: 'fail', commitSha: BASELINE,
        changedPaths: ['app/agenda.js'],
        checks: [{ id: 'test', status: 'failed', cwd: 'backend' }],
        failure: 'Required test failed.',
      },
      checkout: { path: join(root, 'integration'), status: 'clean' },
    }; } },
  });
  assert.equal(await main(['task', 'status'], services), EXIT_CODES.SUCCESS);
  const shown = messages.join('\n');
  assert.match(shown, /Changed: app\/agenda\.js/);
  assert.match(shown, /Check: test failed \(backend\)/);
  assert.match(shown, /Failure: Required test failed/);
});
