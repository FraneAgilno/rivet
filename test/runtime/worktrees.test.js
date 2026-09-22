import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createReservedWorktree as createReservedWorktreeAtClock, verifyReservedWorktree as verifyReservedWorktreeAtClock } from '../../src/git/worktrees.js';
import { resolveStatePaths } from '../../src/state/paths.js';
import { formatWorktreeResult, runWorktreeCommand as runWorktreeCommandAtClock } from '../../src/commands/worktrees.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';

// Inject the fixture clock only into lease operations; lock timing stays real.
const createReservedWorktree = (input, options = {}) => createReservedWorktreeAtClock(input, { nowMs: Date.parse('2026-09-20T10:00:00.000Z'), ...options });
const verifyReservedWorktree = (input, options = {}) => verifyReservedWorktreeAtClock(input, { nowMs: Date.parse('2026-09-20T10:00:00.000Z'), ...options });
const runWorktreeCommand = (input, options = {}) => runWorktreeCommandAtClock(input, { nowMs: Date.parse('2026-09-20T10:00:00.000Z'), ...options });

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

async function fixture(t, instance = 'conference-demo') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agilno-worktrees-')));
  const root = join(parent, 'repository');
  await execFile('git', ['init', '--quiet', '-b', 'main', root]);
  const baseSha = await commit(root, 'fixture', {
    'README.md': 'fixture\n',
    'src/feature.js': 'export const feature = 1;\n',
  });
  const statePaths = await resolveStatePaths(root, instance);
  const client = await createGitClient({ gitExecutable: await gitExecutable() });
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return { parent, root, baseSha, statePaths, client };
}

function request(f, overrides = {}) {
  return {
    projectRoot: f.root,
    statePaths: f.statePaths,
    nodeId: 'worker-one',
    branch: 'agent/worker-one',
    worktreePath: join(f.parent, 'worker-one'),
    ownerId: 'manager-one',
    baseSha: f.baseSha,
    responsibilities: ['src/feature.js'],
    intendedPaths: ['src/feature.js'],
    expiresAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  };
}

async function markerExecutable(root, name, marker, passthrough = false) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf marker > "${marker}"\n${passthrough ? 'cat\n' : 'exit 0\n'}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function recoveryControls(reservation, suffix = 'one') {
  const nowMs = Date.parse('2026-09-20T10:00:00.000Z');
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  return {
    gitClient: reservation.client,
    nowMs,
    authority: createAuthorityEnvelope({
      actorId: 'manager-one', principal: 'agent', actions: ['git.worktree.recover'],
      ownedPaths: [], providers: [], commands: [],
    }),
    approvalRegistry: registry,
    expectedApproverId: 'human-owner',
    approval: createApprovalReceipt({
      id: `recover-${suffix}`,
      approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'manager-one',
      action: 'git.worktree.recover', resource: `worktree-lease:${reservation.leaseId}`,
      policyId: 'worktree.stale-recovery', decision: 'approved',
      expiresAt: '2026-09-20T11:00:00.000Z', singleUse: true,
    }),
  };
}

test('reserves before creating a clean isolated worktree at the requested base', async t => {
  const f = await fixture(t);
  const result = await createReservedWorktree(request(f), {
    gitClient: f.client,
    nowMs: Date.parse('2026-09-20T10:00:00.000Z'),
  });

  assert.equal(result.reservation.status, 'active');
  assert.equal(result.reservation.baseSha, f.baseSha);
  assert.equal(result.reservation.ownerId, 'manager-one');
  assert.equal(result.reservation.cooperationBoundary, 'cooperating-orchestrator-actors');
  assert.equal((await git(result.reservation.worktreePath, 'rev-parse', 'HEAD')).stdout.trim(), f.baseSha);
  assert.equal((await git(result.reservation.worktreePath, 'branch', '--show-current')).stdout.trim(), 'agent/worker-one');
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 1);
});

test('rejects repo-local fsmonitor without executing it', async t => {
  const f = await fixture(t, 'fsmonitor-boundary');
  const marker = join(f.parent, 'fsmonitor-executed');
  const executable = await markerExecutable(f.parent, 'fsmonitor-hook', marker);
  await git(f.root, 'config', '--local', 'core.fsmonitor', executable);

  let failure;
  try { await f.client.inspectRepository(f.root); } catch (error) { failure = error; }
  await assert.rejects(() => lstat(marker), { code: 'ENOENT' });
  assert.equal(failure?.code, 'ERR_GIT_EXECUTABLE_CONFIG');
});

test('rejects repo-local smudge filters before worktree checkout can execute them', async t => {
  const f = await fixture(t, 'filter-boundary');
  const marker = join(f.parent, 'smudge-executed');
  const executable = await markerExecutable(f.parent, 'smudge-filter', marker, true);
  await git(f.root, 'config', '--local', 'filter.inert.smudge', executable);
  await git(f.root, 'config', '--local', 'filter.inert.clean', 'cat');
  await git(f.root, 'config', '--local', 'filter.inert.required', 'true');
  f.baseSha = await commit(f.root, 'filtered fixture', {
    '.gitattributes': 'filtered.txt filter=inert\n',
    'filtered.txt': 'inert content\n',
  });

  let failure;
  try { await createReservedWorktree(request(f), { gitClient: f.client }); } catch (error) { failure = error; }
  await assert.rejects(() => lstat(marker), { code: 'ENOENT' });
  assert.equal(failure?.code, 'ERR_GIT_EXECUTABLE_CONFIG');
});

test('command adapter returns structured local results without external side effects', async t => {
  const f = await fixture(t, 'command-adapter');
  const created = await runWorktreeCommand({ action: 'create', ...request(f) }, { gitClient: f.client });
  const inspected = await runWorktreeCommand({
    action: 'inspect', projectRoot: f.root, statePaths: f.statePaths,
    nodeId: 'worker-one', ownerId: 'manager-one', leaseId: created.reservation.leaseId,
  }, { gitClient: f.client });
  assert.equal(inspected.reservation.leaseId, created.reservation.leaseId);
  assert.equal(formatWorktreeResult(created), 'Worktree: active.');
  assert.equal(JSON.parse(formatWorktreeResult({ status: 'ready' }, { json: true })).status, 'ready');
});

test('refuses dirty or detached sources and leaves no branch, path, or reservation', async t => {
  const dirty = await fixture(t, 'dirty-source');
  await writeFile(join(dirty.root, 'untracked.txt'), 'preserve me\n');
  await assert.rejects(
    () => createReservedWorktree(request(dirty), { gitClient: dirty.client }),
    error => error.code === 'ERR_WORKTREE_DIRTY_SOURCE',
  );
  assert.equal((await createReservationStore(dirty.statePaths).list()).reservations.length, 0);
  await assert.rejects(() => lstat(join(dirty.parent, 'worker-one')), { code: 'ENOENT' });
  assert.equal((await readFile(join(dirty.root, 'untracked.txt'), 'utf8')), 'preserve me\n');

  const detached = await fixture(t, 'detached-source');
  await git(detached.root, 'checkout', '--quiet', '--detach', detached.baseSha);
  await assert.rejects(
    () => createReservedWorktree(request(detached), { gitClient: detached.client }),
    error => error.code === 'ERR_WORKTREE_DETACHED_SOURCE',
  );
});

test('rejects duplicate branches, duplicate paths, traversal, protected branches, and stale bases', async t => {
  const f = await fixture(t);
  await createReservedWorktree(request(f), { gitClient: f.client });

  await assert.rejects(
    () => createReservedWorktree(request(f, {
      nodeId: 'worker-two', ownerId: 'manager-two', worktreePath: join(f.parent, 'worker-two'),
      responsibilities: ['docs/'], intendedPaths: ['docs/demo.md'],
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_BRANCH_COLLISION',
  );
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      nodeId: 'worker-three', ownerId: 'manager-three', branch: 'agent/worker-three',
      responsibilities: ['docs/'], intendedPaths: ['docs/demo.md'],
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_PATH_COLLISION',
  );
  for (const overrides of [
    { nodeId: '../escape', branch: 'agent/escape', worktreePath: join(f.parent, 'escape') },
    { branch: '../escape', worktreePath: join(f.parent, 'escape') },
    { branch: 'main', worktreePath: join(f.parent, 'protected') },
    { responsibilities: ['../private'], intendedPaths: ['src/feature.js'], branch: 'agent/escape', worktreePath: join(f.parent, 'escape') },
    { baseSha: '0'.repeat(40), branch: 'agent/stale', worktreePath: join(f.parent, 'stale') },
  ]) {
    await assert.rejects(() => createReservedWorktree(request(f, overrides), { gitClient: f.client }));
  }
});

test('allows exactly one reservation winner for overlapping responsibility leases', async t => {
  const f = await fixture(t, 'lease-collision');
  const results = await Promise.allSettled([
    createReservedWorktree(request(f), { gitClient: f.client }),
    createReservedWorktree(request(f, {
      nodeId: 'worker-two', ownerId: 'manager-two', branch: 'agent/worker-two',
      worktreePath: join(f.parent, 'worker-two'), responsibilities: ['src/'],
    }), { gitClient: f.client }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 1);
});

test('detects case-folded responsibility collisions', async t => {
  const f = await fixture(t, 'case-folded-collision');
  const store = createReservationStore(f.statePaths);
  const repository = await f.client.inspectRepository(f.root);
  await store.reserve({
    ...request(f, { responsibilities: ['Src/'], intendedPaths: ['Src/demo.js'] }),
    repositoryId: repository.repositoryId,
  }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  await assert.rejects(
    () => store.reserve({
      ...request(f, {
        nodeId: 'worker-two', ownerId: 'manager-two', branch: 'agent/worker-two',
        worktreePath: join(f.parent, 'worker-two'), responsibilities: ['src/demo.js'], intendedPaths: ['src/demo.js'],
      }),
      repositoryId: repository.repositoryId,
    }, { expectedVersion: 1, nowMs: Date.parse('2026-09-20T08:00:00.000Z') }),
    error => error.code === 'ERR_WORKTREE_LEASE_COLLISION',
  );
});

test('rejects adjacent case aliases between responsibility and intended paths', async t => {
  const f = await fixture(t, 'case-alias-input');
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      responsibilities: ['src/K.js'], intendedPaths: ['src/k.js'],
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_INVALID_RESERVATION',
  );
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 0);
});

test('rejects Git metadata aliases in every responsibility and intended path component', async t => {
  const aliases = ['.GIT/file.js', 'dir/.git/file.js', 'dir/.GiT/file.js', 'dir/.ｇｉｔ/file.js'];
  for (const [index, alias] of aliases.entries()) {
    const f = await fixture(t, `git-alias-${index}`);
    await assert.rejects(
      () => createReservedWorktree(request(f, {
        branch: `agent/git-alias-${index}`, worktreePath: join(f.parent, `git-alias-${index}`),
        responsibilities: [alias], intendedPaths: [alias],
      }), { gitClient: f.client }),
      error => error.code === 'ERR_WORKTREE_INVALID_RESERVATION',
      alias,
    );
    assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 0, alias);
  }
});

test('serializes reservation CAS across separate processes', async t => {
  const f = await fixture(t, 'process-cas');
  const repository = await f.client.inspectRepository(f.root);
  const pathsModule = new URL('../../src/state/paths.js', import.meta.url).href;
  const reservationsModule = new URL('../../src/git/reservations.js', import.meta.url).href;
  const source = `
    import { resolveStatePaths } from ${JSON.stringify(pathsModule)};
    import { createReservationStore } from ${JSON.stringify(reservationsModule)};
    const [root, repositoryId, nodeId, branch, path] = process.argv.slice(1);
    const store = createReservationStore(await resolveStatePaths(root, 'process-cas'));
    try {
      const result = await store.reserve({
        nodeId, branch, worktreePath: path, ownerId: nodeId, baseSha: '${f.baseSha}', repositoryId,
        responsibilities: ['src/'], intendedPaths: ['src/feature.js'], expiresAt: '2026-09-20T12:00:00.000Z'
      }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
      console.log(JSON.stringify({ status: 'success', version: result.version }));
    } catch (error) {
      console.log(JSON.stringify({ status: 'failure', code: error.code }));
    }
  `;
  const run = (nodeId, branch, path) => execFile(process.execPath, [
    '--input-type=module', '-e', source, f.root, repository.repositoryId, nodeId, branch, path,
  ]).then(({ stdout }) => JSON.parse(stdout.trim()));
  const results = await Promise.all([
    run('worker-left', 'agent/worker-left', join(f.parent, 'worker-left')),
    run('worker-right', 'agent/worker-right', join(f.parent, 'worker-right')),
  ]);
  assert.equal(results.filter(result => result.status === 'success').length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter(result => result.status === 'failure').map(result => result.code), ['ERR_WORKTREE_STATE_VERSION_CONFLICT']);
});

test('allows independent reservations to complete concurrently without losing CAS updates', async t => {
  const f = await fixture(t, 'independent-leases');
  const results = await Promise.allSettled([
    createReservedWorktree(request(f), { gitClient: f.client }),
    createReservedWorktree(request(f, {
      nodeId: 'worker-two', ownerId: 'manager-two', branch: 'agent/worker-two',
      worktreePath: join(f.parent, 'worker-two'), responsibilities: ['docs/'], intendedPaths: ['docs/demo.md'],
    }), { gitClient: f.client }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2, JSON.stringify(results));
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 2);
});

test('captures caller-owned responsibility arrays before asynchronous work begins', async t => {
  const f = await fixture(t, 'capture-once');
  const responsibilities = ['src/feature.js'];
  const pending = createReservedWorktree(request(f, { responsibilities }), { gitClient: f.client });
  responsibilities[0] = '../escape-after-capture';
  const created = await pending;
  assert.deepEqual(created.reservation.responsibilities, [{ path: 'src/feature.js', directory: false }]);
});

test('rejects parent-child worktree namespace overlap before reserving or mutating Git', async t => {
  const f = await fixture(t, 'path-overlap');
  const created = await createReservedWorktree(request(f), { gitClient: f.client });
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      nodeId: 'worker-two', ownerId: 'manager-two', branch: 'agent/worker-two',
      worktreePath: join(created.reservation.worktreePath, 'nested-worker'),
      responsibilities: ['docs/'], intendedPaths: ['docs/demo.md'],
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_PATH_COLLISION',
  );
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 1);
});

test('does not silently steal an expired lease and rolls a reservation back when creation fails', async t => {
  const f = await fixture(t, 'lease-recovery');
  const store = createReservationStore(f.statePaths);
  const repository = await f.client.inspectRepository(f.root);
  const reserved = await store.reserve({
    ...request(f),
    repositoryId: repository.repositoryId,
    worktreePath: join(f.parent, 'stale-worker'),
    expiresAt: '2026-09-20T09:00:00.000Z',
  }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  assert.equal(reserved.reservation.status, 'reserved');
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      branch: 'agent/other', worktreePath: join(f.parent, 'other'),
    }), { gitClient: f.client, nowMs: Date.parse('2026-09-20T10:00:00.000Z') }),
    error => error.code === 'ERR_WORKTREE_STALE_LEASE',
  );

  const readonlyParent = join(f.parent, 'readonly');
  await mkdir(readonlyParent, { mode: 0o500 });
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      nodeId: 'worker-three', ownerId: 'manager-three', branch: 'agent/worker-three',
      worktreePath: join(readonlyParent, 'worker-three'), responsibilities: ['docs/'], intendedPaths: ['docs/demo.md'],
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_CREATE_FAILED' && !error.message.includes(f.parent),
  );
  await chmod(readonlyParent, 0o700);
  assert.equal((await store.list()).reservations.length, 1);
});

test('rejects hard-linked and nonregular reservation state', async t => {
  const hardlinked = await fixture(t, 'hardlinked-reservations');
  const hardStore = createReservationStore(hardlinked.statePaths);
  const repository = await hardlinked.client.inspectRepository(hardlinked.root);
  await hardStore.reserve({ ...request(hardlinked), repositoryId: repository.repositoryId }, {
    expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z'),
  });
  await link(join(hardlinked.statePaths.instanceDir, 'worktree-reservations.json'), join(hardlinked.parent, 'reservation-alias'));
  await assert.rejects(() => hardStore.list(), error => error.code === 'ERR_WORKTREE_UNSAFE_STATE');

  const nonregular = await fixture(t, 'nonregular-reservations');
  const nonregularStore = createReservationStore(nonregular.statePaths);
  const secondRepository = await nonregular.client.inspectRepository(nonregular.root);
  const statePath = join(nonregular.statePaths.instanceDir, 'worktree-reservations.json');
  await nonregularStore.reserve({ ...request(nonregular), repositoryId: secondRepository.repositoryId }, {
    expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z'),
  });
  await rename(statePath, `${statePath}.preserved`);
  await mkdir(statePath, { mode: 0o700 });
  await assert.rejects(() => nonregularStore.list(), error => error.code === 'ERR_WORKTREE_UNSAFE_STATE');
});

test('explicitly recovers expired reservation-only and created-but-inactive leases', async t => {
  const { recoverStaleWorktree } = await import('../../src/git/worktrees.js');
  for (const [suffix, createTopology] of [['reservation-only', false], ['created-inactive', true]]) {
    const f = await fixture(t, `recover-${suffix}`);
    const repository = await f.client.inspectRepository(f.root);
    const store = createReservationStore(f.statePaths);
    const reserved = await store.reserve({
      ...request(f, { expiresAt: '2026-09-20T09:00:00.000Z' }), repositoryId: repository.repositoryId,
    }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
    if (createTopology) await f.client.createWorktree(f.root, {
      path: reserved.reservation.worktreePath, branch: reserved.reservation.branch, baseSha: reserved.reservation.baseSha,
    });
    const result = await recoverStaleWorktree({
      projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
      ownerId: 'manager-one', leaseId: reserved.reservation.leaseId,
    }, recoveryControls({ ...reserved.reservation, client: f.client }, suffix));
    assert.equal(result.status, 'recovered');
    assert.equal((await store.list()).reservations.length, 0);
    await assert.rejects(() => lstat(reserved.reservation.worktreePath), { code: 'ENOENT' });
  }
});

test('stale recovery rejects mismatched identity and preserves active Worker evidence', async t => {
  const { recoverStaleWorktree } = await import('../../src/git/worktrees.js');
  const f = await fixture(t, 'recover-active');
  const created = await createReservedWorktree(request(f, {
    expiresAt: '2026-09-20T09:00:00.000Z',
  }), { gitClient: f.client, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  await commit(created.reservation.worktreePath, 'preserved work', { 'src/feature.js': 'export const feature = 2;\n' });
  await assert.rejects(
    () => recoverStaleWorktree({
      projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
      ownerId: 'different-owner', leaseId: created.reservation.leaseId,
    }, recoveryControls({ ...created.reservation, client: f.client }, 'mismatch')),
    error => error.code === 'ERR_WORKTREE_LEASE_MISMATCH',
  );
  const result = await recoverStaleWorktree({
    projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
    ownerId: 'manager-one', leaseId: created.reservation.leaseId,
  }, recoveryControls({ ...created.reservation, client: f.client }, 'active'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'worker-evidence-preserved');
  assert.deepEqual(result.evidence.changedPaths, ['src/feature.js']);
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 1);
  assert.equal(await readFile(join(created.reservation.worktreePath, 'src/feature.js'), 'utf8'), 'export const feature = 2;\n');
});

test('stale recovery preserves unrelated path residue and keeps its reservation', async t => {
  const { recoverStaleWorktree } = await import('../../src/git/worktrees.js');
  const f = await fixture(t, 'recover-residue');
  const repository = await f.client.inspectRepository(f.root);
  const store = createReservationStore(f.statePaths);
  const reserved = await store.reserve({
    ...request(f, { expiresAt: '2026-09-20T09:00:00.000Z' }), repositoryId: repository.repositoryId,
  }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  await mkdir(reserved.reservation.worktreePath);
  await writeFile(join(reserved.reservation.worktreePath, 'unrelated.txt'), 'preserve\n');
  const result = await recoverStaleWorktree({
    projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
    ownerId: 'manager-one', leaseId: reserved.reservation.leaseId,
  }, recoveryControls({ ...reserved.reservation, client: f.client }, 'residue'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'topology-mismatch');
  assert.equal(await readFile(join(reserved.reservation.worktreePath, 'unrelated.txt'), 'utf8'), 'preserve\n');
  assert.equal((await store.list()).reservations.length, 1);
});

test('stale recovery inventories and preserves ignored Worker evidence', async t => {
  const { recoverStaleWorktree } = await import('../../src/git/worktrees.js');
  const f = await fixture(t, 'recover-ignored');
  f.baseSha = await commit(f.root, 'ignore session evidence', { '.gitignore': 'session.log\n' });
  const created = await createReservedWorktree(request(f, {
    expiresAt: '2026-09-20T09:00:00.000Z',
  }), { gitClient: f.client, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  const evidencePath = join(created.reservation.worktreePath, 'session.log');
  await writeFile(evidencePath, 'preserve ignored evidence\n');

  const result = await recoverStaleWorktree({
    projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
    ownerId: 'manager-one', leaseId: created.reservation.leaseId,
  }, recoveryControls({ ...created.reservation, client: f.client }, 'ignored'));
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.reason, 'worker-evidence-preserved', JSON.stringify(result));
  assert.deepEqual(result.evidence.uncommittedPaths, ['session.log']);
  assert.equal(await readFile(evidencePath, 'utf8'), 'preserve ignored evidence\n');
  assert.equal((await createReservationStore(f.statePaths).list()).reservations.length, 1);
});

test('stale recovery requires an explicit single-use human approval', async t => {
  const { recoverStaleWorktree } = await import('../../src/git/worktrees.js');
  const f = await fixture(t, 'recover-approval');
  const repository = await f.client.inspectRepository(f.root);
  const store = createReservationStore(f.statePaths);
  const reserved = await store.reserve({
    ...request(f, { expiresAt: '2026-09-20T09:00:00.000Z' }), repositoryId: repository.repositoryId,
  }, { expectedVersion: 0, nowMs: Date.parse('2026-09-20T08:00:00.000Z') });
  const { approval: _approval, ...withoutApproval } = recoveryControls({
    ...reserved.reservation, client: f.client,
  }, 'approval');
  await assert.rejects(
    () => recoverStaleWorktree({
      projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
      ownerId: 'manager-one', leaseId: reserved.reservation.leaseId,
    }, withoutApproval),
    error => error.code === 'ERR_WORKTREE_RECOVERY_APPROVAL',
  );
  assert.equal((await store.list()).reservations.length, 1);
});

test('rejects unsafe worktree topology and verifies exact lease identity for cooperating actors', async t => {
  const f = await fixture(t, 'topology-identity');
  const outside = await mkdtemp(join(tmpdir(), 'agilno-worktree-outside-'));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(f.parent, 'linked-parent'));
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      branch: 'agent/symlink', worktreePath: join(f.parent, 'linked-parent', 'worker'),
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_UNSAFE_PATH',
  );
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      branch: 'agent/windows-ambiguous', worktreePath: join(f.parent, 'CON'),
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_UNSAFE_PATH',
  );
  await symlink(outside, join(f.parent, 'target-link'));
  await assert.rejects(
    () => createReservedWorktree(request(f, {
      branch: 'agent/target-link', worktreePath: join(f.parent, 'target-link'),
    }), { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_UNSAFE_PATH',
  );

  const created = await createReservedWorktree(request(f), { gitClient: f.client });
  await assert.rejects(
    () => verifyReservedWorktree({
      projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
      ownerId: 'different-owner', leaseId: created.reservation.leaseId,
    }, { gitClient: f.client }),
    error => error.code === 'ERR_WORKTREE_LEASE_MISMATCH',
  );
  const verified = await verifyReservedWorktree({
    projectRoot: f.root, statePaths: f.statePaths, nodeId: 'worker-one',
    ownerId: 'manager-one', leaseId: created.reservation.leaseId,
  }, { gitClient: f.client });
  assert.equal(verified.cooperationBoundary, 'cooperating-orchestrator-actors');
});
