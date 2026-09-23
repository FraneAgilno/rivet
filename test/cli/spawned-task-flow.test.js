import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { createFeatureExecutor } from '../../src/feature/runtime-bridge.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createFeatureRunStore } from '../../src/feature/run-store.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';
import { listExistingFeatureRunPaths } from '../../src/state/paths.js';

const execFile = promisify(execFileCallback);
const NOW = '2029-01-01T00:00:00.000Z';
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-spawned-flow-')));
  const root = join(parent, 'project');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Spawned task fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture']);
  const nested = join(root, 'notes');
  await mkdir(nested);
  const gate = join(parent, 'bounded-gate');
  await writeFile(gate, '#!/bin/sh\nprintf DEPENDENCY_SENTINEL >&2\nexit 1\n', { mode: 0o700 });
  await chmod(gate, 0o700);
  return { root, nested, gate };
}

test('one terminal task retains failed checks and resumes verification at the accepted commit', async t => {
  const { root, nested, gate } = await fixture(t);
  const gitClient = await createGitClient({ gitExecutable: await realpath('/opt/homebrew/bin/git') });
  const resolveCommandExecutable = async runner => {
    assert.equal(runner, 'npm');
    return gate;
  };
  const executor = createFeatureExecutor({
    gitClient, now: () => NOW, resolveCommandExecutable,
    clientFor(kind) {
      assert.equal(kind, 'codex');
      return Object.freeze({
        provider: kind,
        async launch(contract) {
          for (const path of contract.ownedPaths) {
            const target = join(contract.worktree.path, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, 'export const greeting = "Hello";\n');
          }
          return {
            version: 1, status: 'success',
            output: { summary: 'Added a greeting.', evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });
  const feature = createFeatureWorkflow({
    gitClient, now: () => NOW,
    planningClientFor: async () => ({
      async propose() {
        return {
          schemaVersion: 1, kind: 'agilno.feature-decomposition',
          workItems: [{ objective: 'Add greeting module', ownedPaths: ['app/greeting.js'], acceptanceCriterionIndexes: [1] }],
        };
      },
    }),
    executeFeature: executor,
  });
  const work = createHostExecution({ gitClient, now: () => NOW, resolveCommandExecutable });
  const messages = [];
  const services = {
    cwd: () => nested,
    terminalIsInteractive: () => true,
    confirmFeatureActivation: async () => true,
    output: { log: value => messages.push(value), error: value => messages.push(value), json() {} },
    harnesses: {
      async discover() { return [{ kind: 'codex', executable: '/usr/bin/codex', version: 'compatible' }]; },
      async select() { return { kind: 'codex', executable: '/usr/bin/codex', version: 'compatible' }; },
    },
    feature, work,
  };
  const failed = await main(['run', 'Add a greeting module'], services);
  assert.equal(failed, EXIT_CODES.FAILED_GATE, messages.join('\n'));
  messages.length = 0;
  assert.equal(await main(['task', 'status'], services), EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'), /Check: build failed/);
  assert.match(messages.join('\n'), /Changed: app\/greeting\.js/);
  assert.match(messages.join('\n'), /DEPENDENCY_SENTINEL/);
  const paths = await listExistingFeatureRunPaths(root);
  const run = await createFeatureRunStore(paths[0]).readOnly();
  const blocked = await work.status({ project: root, runId: run.runId });
  assert.equal(blocked.verification.status, 'fail');
  assert.equal(blocked.checkout.status, 'clean');
  const commit = blocked.verification.commitSha;
  await writeFile(gate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  messages.length = 0;
  assert.equal(await main(['task', 'resume'], services), EXIT_CODES.SUCCESS, messages.join('\n'));
  const final = await work.status({ project: root, runId: blocked.run.runId });
  assert.equal(final.run.status, 'awaiting-final-approval');
  assert.equal(final.verification.status, 'pass');
  assert.equal(final.verification.commitSha, commit);
  assert.equal(final.verification.runVersion, final.run.version - 1);
  assert.equal(final.checkout.status, 'clean');
  assert.match(final.nextAction, /separate final delivery decision/);
  await writeFile(join(final.checkout.path, 'app', 'greeting.js'), 'changed after verification\n');
  const stale = await work.status({ project: root, runId: blocked.run.runId });
  assert.equal(stale.checkout.status, 'stale');
  assert.match(stale.nextAction, /Do not deliver/);
});
