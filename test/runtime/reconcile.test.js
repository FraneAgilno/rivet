import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import { reconcileWorktree as reconcileWorktreeAtClock } from '../../src/git/reconcile.js';
import { createReservedWorktree as createReservedWorktreeAtClock } from '../../src/git/worktrees.js';
import { resolveStatePaths } from '../../src/state/paths.js';

// Inject the fixture clock only into lease operations; lock timing stays real.
const createReservedWorktree = (input, options = {}) => createReservedWorktreeAtClock(input, { nowMs: Date.parse('2026-09-20T10:00:00.000Z'), ...options });
const reconcileWorktree = (input, options = {}) => reconcileWorktreeAtClock(input, { nowMs: Date.parse('2026-09-20T10:00:00.000Z'), ...options });

const execFile = promisify(execFileCallback);

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

async function git(cwd, ...args) {
  return execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 });
}

function gitInput(cwd, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFileCallback('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) rejectPromise(error);
      else resolvePromise({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function commit(root, message, files) {
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  await git(root, 'add', '--', ...Object.keys(files));
  await execFile('git', [
    '-C', root, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', message,
  ]);
  return (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
}

async function fixture(t, instance, options = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agilno-reconcile-')));
  const root = join(parent, 'repository');
  await execFile('git', ['init', '--quiet', '-b', 'main', root]);
  const baseSha = await commit(root, 'fixture', {
    'README.md': 'fixture\n',
    'src/feature.js': 'export const feature = 1;\n',
    ...(options.files ?? {}),
  });
  const statePaths = await resolveStatePaths(root, instance);
  const client = await createGitClient({ gitExecutable: await gitExecutable() });
  const created = await createReservedWorktree({
    projectRoot: root,
    statePaths,
    nodeId: 'worker-one',
    branch: 'agent/worker-one',
    worktreePath: join(parent, 'worker-one'),
    ownerId: 'manager-one',
    baseSha,
    responsibilities: options.responsibilities ?? ['src/feature.js'],
    intendedPaths: options.intendedPaths ?? ['src/feature.js'],
    expiresAt: '2026-09-20T12:00:00.000Z',
  }, { gitClient: client, nowMs: Date.parse('2026-09-20T10:00:00.000Z') });
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return { parent, root, baseSha, statePaths, client, reservation: created.reservation };
}

function reconcileRequest(f, overrides = {}) {
  return {
    projectRoot: f.root,
    statePaths: f.statePaths,
    nodeId: 'worker-one',
    ownerId: 'manager-one',
    leaseId: f.reservation.leaseId,
    integrationBranch: 'main',
    integrate: false,
    ...overrides,
  };
}

test('blocks with preserved evidence when the Worker has uncommitted changes', async t => {
  const f = await fixture(t, 'uncommitted-recovery');
  await writeFile(join(f.reservation.worktreePath, 'src/feature.js'), 'export const feature = 2;\n');

  const report = await reconcileWorktree(reconcileRequest(f), { gitClient: f.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'worker-uncommitted-changes');
  assert.deepEqual(report.evidence.uncommittedPaths, ['src/feature.js']);
  assert.equal(await readFile(join(f.reservation.worktreePath, 'src/feature.js'), 'utf8'), 'export const feature = 2;\n');
});

test('ignores ignored directory markers while retaining ignored file evidence', async t => {
  const f = await fixture(t, 'ignored-directory-marker', { files: { '.gitignore': 'node_modules/\n' } });
  await mkdir(join(f.reservation.worktreePath, 'node_modules', 'fixture-package'), { recursive: true });
  await writeFile(join(f.reservation.worktreePath, 'node_modules', 'fixture-package', 'index.js'), 'ignored\n');

  assert.deepEqual(await f.client.statusPaths(f.reservation.worktreePath), []);
});

test('reports conflicts without modifying either branch', async t => {
  const f = await fixture(t, 'conflict-detection');
  const workerTip = await commit(f.reservation.worktreePath, 'worker edit', {
    'src/feature.js': 'export const feature = "worker";\n',
  });
  const integrationTip = await commit(f.root, 'integration edit', {
    'src/feature.js': 'export const feature = "integration";\n',
  });

  const report = await reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'integration-conflict');
  assert.deepEqual(report.evidence.conflictingPaths, ['src/feature.js']);
  assert.equal((await git(f.root, 'rev-parse', 'HEAD')).stdout.trim(), integrationTip);
  assert.equal((await git(f.reservation.worktreePath, 'rev-parse', 'HEAD')).stdout.trim(), workerTip);
});

test('fails closed on missing intended paths and changes outside responsibility', async t => {
  const missing = await fixture(t, 'missing-intended');
  await commit(missing.reservation.worktreePath, 'wrong file', { 'README.md': 'changed\n' });
  const report = await reconcileWorktree(reconcileRequest(missing), { gitClient: missing.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'scope-mismatch');
  assert.deepEqual(report.evidence.missingIntendedPaths, ['src/feature.js']);
  assert.deepEqual(report.evidence.unexpectedPaths, ['README.md']);
});

test('includes both rename endpoints in scope checks', async t => {
  const f = await fixture(t, 'rename-scope', {
    files: { 'outside.js': 'export const outside = true;\n' },
    responsibilities: ['owned/new.js'], intendedPaths: ['owned/new.js'],
  });
  await mkdir(join(f.reservation.worktreePath, 'owned'));
  await git(f.reservation.worktreePath, 'mv', 'outside.js', 'owned/new.js');
  await execFile('git', [
    '-C', f.reservation.worktreePath, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', 'rename into owned scope',
  ]);
  const report = await reconcileWorktree(reconcileRequest(f), { gitClient: f.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'scope-mismatch');
  assert.deepEqual(report.evidence.changedPaths, ['outside.js', 'owned/new.js']);
  assert.deepEqual(report.evidence.unexpectedPaths, ['outside.js']);
});

test('includes both copy endpoints in scope checks', async t => {
  const f = await fixture(t, 'copy-scope', {
    files: { 'outside.js': 'export const outside = true;\n' },
    responsibilities: ['owned/copied.js'], intendedPaths: ['owned/copied.js'],
  });
  await commit(f.reservation.worktreePath, 'copy into owned scope', {
    'owned/copied.js': 'export const outside = true;\n',
  });
  const report = await reconcileWorktree(reconcileRequest(f), { gitClient: f.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'scope-mismatch');
  assert.deepEqual(report.evidence.changedPaths, ['outside.js', 'owned/copied.js']);
  assert.deepEqual(report.evidence.unexpectedPaths, ['outside.js']);
});

test('replacement refs cannot hide out-of-scope Worker changes from reconciliation', async t => {
  const f = await fixture(t, 'replacement-ref', {
    responsibilities: ['src/feature.js'], intendedPaths: ['src/feature.js'],
  });
  const workerTip = await commit(f.reservation.worktreePath, 'real worker edit', {
    'src/feature.js': 'export const feature = 2;\n',
    'outside.js': 'export const hidden = true;\n',
  });
  await git(f.root, 'switch', '--quiet', '-c', 'replacement-view');
  const replacementTip = await commit(f.root, 'replacement view', {
    'src/feature.js': 'export const feature = 2;\n',
  });
  await git(f.root, 'switch', '--quiet', 'main');
  await git(f.root, 'replace', workerTip, replacementTip);
  await git(f.reservation.worktreePath, 'reset', '--hard', workerTip);

  const report = await reconcileWorktree(reconcileRequest(f), { gitClient: f.client });
  assert.equal(report.status, 'blocked', JSON.stringify(report));
  assert.equal(report.reason, 'worker-uncommitted-changes', JSON.stringify(report));
  assert.deepEqual(report.evidence.uncommittedPaths, ['outside.js']);
});

test('NFKC repository path aliases cannot inherit canonical responsibility', async t => {
  const fullwidth = await fixture(t, 'fullwidth-path', {
    responsibilities: ['src/K.js'], intendedPaths: ['src/K.js'],
  });
  await commit(fullwidth.reservation.worktreePath, 'aliased path', {
    'src/K.js': 'export const owned = true;\n',
    'src/Ｋ.js': 'export const alias = true;\n',
  });
  await assert.rejects(
    () => reconcileWorktree(reconcileRequest(fullwidth), { gitClient: fullwidth.client }),
    error => error.code === 'ERR_GIT_REPOSITORY_PATH_UNSAFE',
  );
});

test('repository paths reject nested case aliases of the Git metadata component', async t => {
  const f = await fixture(t, 'git-component-path', {
    responsibilities: ['dir/'], intendedPaths: ['dir/owned.js'],
  });
  const ownedSource = join(f.parent, 'owned-source');
  const hiddenSource = join(f.parent, 'hidden-source');
  await writeFile(ownedSource, 'export const owned = true;\n');
  await writeFile(hiddenSource, 'export const hidden = true;\n');
  const ownedBlob = (await git(f.root, 'hash-object', '-w', ownedSource)).stdout.trim();
  const hiddenBlob = (await git(f.root, 'hash-object', '-w', hiddenSource)).stdout.trim();
  const metadataTree = (await gitInput(f.root, ['mktree'], `100644 blob ${hiddenBlob}\thidden.js\n`)).stdout.trim();
  const directoryTree = (await gitInput(f.root, ['mktree'], [
    `040000 tree ${metadataTree}\t.GIT`,
    `100644 blob ${ownedBlob}\towned.js`,
    '',
  ].join('\n'))).stdout.trim();
  const baseTree = (await git(f.root, 'ls-tree', f.baseSha)).stdout;
  const tree = (await gitInput(f.root, ['mktree'], `${baseTree}040000 tree ${directoryTree}\tdir\n`)).stdout.trim();
  const craftedTip = (await execFile('git', [
    '-C', f.root, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit-tree', tree, '-p', f.baseSha, '-m', 'metadata alias path',
  ])).stdout.trim();
  await assert.rejects(
    () => f.client.changedPaths(f.root, f.baseSha, craftedTip),
    error => error.code === 'ERR_GIT_REPOSITORY_PATH_UNSAFE',
  );
});

test('fast-forwards a clean integration branch only after scope and lease checks', async t => {
  const f = await fixture(t, 'fast-forward');
  const workerTip = await commit(f.reservation.worktreePath, 'worker edit', {
    'src/feature.js': 'export const feature = 2;\n',
  });

  const preview = await reconcileWorktree(reconcileRequest(f), { gitClient: f.client });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.workerTip, workerTip);
  assert.deepEqual(preview.evidence.changedPaths, ['src/feature.js']);
  assert.equal((await git(f.root, 'rev-parse', 'HEAD')).stdout.trim(), f.baseSha);

  const integrated = await reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client });
  assert.equal(integrated.status, 'integrated');
  assert.equal((await git(f.root, 'rev-parse', 'HEAD')).stdout.trim(), workerTip);
});

test('preserves unrelated integration changes and refuses non-fast-forward integration', async t => {
  const f = await fixture(t, 'preserve-unrelated');
  await commit(f.reservation.worktreePath, 'worker edit', {
    'src/feature.js': 'export const feature = 2;\n',
  });
  const integrationTip = await commit(f.root, 'unrelated integration edit', {
    'docs/decision.md': 'preserve this\n',
  });

  const report = await reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client });
  assert.equal(report.status, 'blocked');
  assert.equal(report.reason, 'non-fast-forward');
  assert.equal((await git(f.root, 'rev-parse', 'HEAD')).stdout.trim(), integrationTip);
  assert.equal(await readFile(join(f.root, 'docs/decision.md'), 'utf8'), 'preserve this\n');

  await writeFile(join(f.root, 'local-note.txt'), 'also preserve\n');
  const dirtyReport = await reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client });
  assert.equal(dirtyReport.status, 'blocked');
  assert.equal(dirtyReport.reason, 'integration-uncommitted-changes');
  assert.equal(await readFile(join(f.root, 'local-note.txt'), 'utf8'), 'also preserve\n');
});

test('integration preserves ignored local evidence that the Worker would overwrite', async t => {
  const f = await fixture(t, 'ignored-integration', {
    files: { '.gitignore': 'generated.txt\n' },
    responsibilities: ['generated.txt'], intendedPaths: ['generated.txt'],
  });
  const workerPath = join(f.reservation.worktreePath, 'generated.txt');
  await writeFile(workerPath, 'worker generated bytes\n');
  await git(f.reservation.worktreePath, 'add', '--force', '--', 'generated.txt');
  await execFile('git', [
    '-C', f.reservation.worktreePath, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', 'force-add generated output',
  ]);
  const integrationPath = join(f.root, 'generated.txt');
  await writeFile(integrationPath, 'local evidence bytes\n');

  const report = await reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client });
  assert.deepEqual({
    status: report.status,
    reason: report.reason,
    uncommittedPaths: report.evidence.uncommittedPaths,
    bytes: await readFile(integrationPath, 'utf8'),
    headSha: (await git(f.root, 'rev-parse', 'HEAD')).stdout.trim(),
  }, {
    status: 'blocked',
    reason: 'integration-uncommitted-changes',
    uncommittedPaths: ['generated.txt'],
    bytes: 'local evidence bytes\n',
    headSha: f.baseSha,
  });
});

test('allows exactly one concurrent fast-forward transaction to report integration', async t => {
  const f = await fixture(t, 'integration-race');
  await commit(f.reservation.worktreePath, 'worker edit', {
    'src/feature.js': 'export const feature = 2;\n',
  });
  const results = await Promise.allSettled([
    reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client }),
    reconcileWorktree(reconcileRequest(f, { integrate: true }), { gitClient: f.client }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 'integrated').length, 1, JSON.stringify(results));
  assert.deepEqual(
    results.filter(result => result.status === 'rejected').map(result => result.reason.code),
    ['ERR_RECONCILE_LEASE_CHANGED'],
    JSON.stringify(results),
  );
});
