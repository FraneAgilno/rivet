import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import { bootstrapWorktreeDependencies, inspectWorktreeDependencies, WorktreeBootstrapError } from '../../src/runtime/worktree-bootstrap.js';

const execFile = promisify(execFileCallback);

async function fixture(t, files = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-bootstrap-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'project');
  const worktreePath = join(parent, 'integration');
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n');
  await writeFile(join(projectRoot, 'package.json'), '{"private":true}\n');
  for (const [name, contents] of Object.entries(files)) await writeFile(join(projectRoot, name), contents);
  await execFile('git', ['init', '--quiet', '--initial-branch=main', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'add', '.']);
  await execFile('git', ['-C', projectRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  let gitExecutable;
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try {
      gitExecutable = await realpath(candidate);
      await createGitClient({ gitExecutable });
      break;
    } catch { gitExecutable = undefined; }
  }
  if (!gitExecutable) throw new Error('Git fixture executable is unavailable');
  const gitClient = await createGitClient({ gitExecutable });
  const expectedCommit = (await gitClient.inspectRepository(projectRoot)).headSha;
  await execFile('git', ['-C', projectRoot, 'worktree', 'add', '--quiet', '-b', 'feature/bootstrap', worktreePath, expectedCommit]);
  const input = { projectRoot, worktreePath, expectedCommit, expectedBranch: 'feature/bootstrap', manager: 'npm' };
  const installer = join(parent, 'fake-npm');
  await writeFile(installer, '#!/bin/sh\nmkdir -p node_modules\nprintf "ready" > node_modules/installed\n', { mode: 0o700 });
  await chmod(installer, 0o700);
  return { parent, input, gitClient, installer };
}

test('chooses the frozen install command from the configured manager and committed lockfile', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  const plan = await inspectWorktreeDependencies(value.input, { gitClient: value.gitClient });
  assert.equal(plan.lockfile, 'package-lock.json');
  assert.deepEqual(plan.args, ['ci']);
});

test('requires a matching, unambiguous lockfile and clean accepted checkout', async t => {
  const value = await fixture(t, { 'yarn.lock': '# lock\n' });
  await assert.rejects(() => inspectWorktreeDependencies(value.input, { gitClient: value.gitClient }),
    error => error instanceof WorktreeBootstrapError && error.details.reason === 'manager-mismatch');
  await writeFile(join(value.input.worktreePath, 'untracked.txt'), 'dirty\n');
  await assert.rejects(() => inspectWorktreeDependencies(value.input, { gitClient: value.gitClient }),
    error => error instanceof WorktreeBootstrapError && error.details.reason === 'unsafe-checkout');
  await assert.rejects(() => inspectWorktreeDependencies({
    ...value.input, worktreePath: value.input.projectRoot, expectedBranch: 'main',
  }, { gitClient: value.gitClient }),
  error => error instanceof WorktreeBootstrapError && error.details.reason === 'invalid-input');
});

test('decline does not execute and approval installs only in the isolated checkout', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  const options = {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
  };
  assert.deepEqual(await bootstrapWorktreeDependencies(value.input, { ...options, confirm: async () => false }),
    { status: 'declined' });
  await assert.rejects(() => readFile(join(value.input.worktreePath, 'node_modules/installed')));
  const result = await bootstrapWorktreeDependencies(value.input, { ...options, confirm: async () => true });
  assert.equal(result.status, 'ready');
  assert.equal(await readFile(join(value.input.worktreePath, 'node_modules/installed'), 'utf8'), 'ready');
  await assert.rejects(() => readFile(join(value.input.projectRoot, 'node_modules/installed')));
  assert.equal((await value.gitClient.inspectRepository(value.input.worktreePath)).dirty, false);
});

test('refuses a checkout changed after the prompt and rejects installer source edits', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  let resolved = false;
  await assert.rejects(() => bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
    confirm: async () => {
      await writeFile(join(value.input.worktreePath, 'package-lock.json'), '{"changed":true}\n');
      resolved = true;
      return true;
    },
  }), error => error instanceof WorktreeBootstrapError && error.details.reason === 'unsafe-checkout');
  assert.equal(resolved, true);
  await writeFile(join(value.input.worktreePath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(value.installer, '#!/bin/sh\nprintf "changed\\n" > package-lock.json\n', { mode: 0o700 });
  await assert.rejects(() => bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
    confirm: async () => true,
  }), error => error instanceof WorktreeBootstrapError && error.details.reason === 'checkout-changed');
});
