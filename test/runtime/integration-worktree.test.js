import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import {
  IntegrationWorktreeError,
  prepareIntegrationWorktree,
} from '../../src/git/integration-worktree.js';
import { resolveStatePaths } from '../../src/state/paths.js';

const execFile = promisify(execFileCallback);

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

async function fixture(t) {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-integration-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const repository = await gitClient.inspectRepository(root);
  const statePaths = await resolveStatePaths(root, 'feature-run');
  const parent = join(dirname(root), '.rivet-worktrees', repository.repositoryId, 'feature-run');
  return {
    root, gitClient, repository, statePaths,
    request: {
      projectRoot: root,
      statePaths,
      branch: 'feature/smart-agenda',
      worktreePath: join(parent, 'integration'),
      baseSha: repository.headSha,
    },
  };
}

test('creates and resumes one isolated integration worktree without moving the source checkout', async t => {
  const value = await fixture(t);
  const before = await value.gitClient.inspectRepository(value.root);
  const created = await prepareIntegrationWorktree(value.request, { gitClient: value.gitClient });

  assert.equal(created.reused, false);
  assert.equal(created.branch, 'feature/smart-agenda');
  assert.equal(created.headSha, before.headSha);
  assert.equal((await value.gitClient.inspectRepository(value.root)).branch, 'main');
  assert.equal((await value.gitClient.inspectRepository(value.root)).headSha, before.headSha);

  const resumed = await prepareIntegrationWorktree(value.request, { gitClient: value.gitClient });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.path, created.path);
  assert.equal(resumed.repositoryId, created.repositoryId);
});

test('rejects baseline, topology, dirtiness, branch, and target-path drift on resume', async t => {
  const value = await fixture(t);
  await assert.rejects(
    () => prepareIntegrationWorktree({ ...value.request, baseSha: 'f'.repeat(40) }, { gitClient: value.gitClient }),
    error => error instanceof IntegrationWorktreeError && error.details.reason === 'baseline-drift',
  );

  await prepareIntegrationWorktree(value.request, { gitClient: value.gitClient });
  await writeFile(join(value.request.worktreePath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    () => prepareIntegrationWorktree(value.request, { gitClient: value.gitClient }),
    error => error instanceof IntegrationWorktreeError && error.details.reason === 'dirty-integration',
  );

  const other = await fixture(t);
  await assert.rejects(
    () => prepareIntegrationWorktree({ ...other.request, worktreePath: join(other.statePaths.instanceDir, 'elsewhere') }, { gitClient: other.gitClient }),
    error => error instanceof IntegrationWorktreeError && error.details.reason === 'unsafe-path',
  );
});

test('never exposes push, merge, cleanup, or remote mutation capabilities', async () => {
  const module = await import('../../src/git/integration-worktree.js');
  assert.deepEqual(Object.keys(module).sort(), [
    'IntegrationWorktreeError',
    'prepareIntegrationWorktree',
  ]);
  for (const retained of ['push', 'merge', 'remove', 'cleanup', 'publish']) assert.equal(Object.hasOwn(module, retained), false);
});
