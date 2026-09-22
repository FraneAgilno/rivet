import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createRuntimeInstance } from '../../src/runtime/instance-store.js';
import { resolveStatePaths } from '../../src/state/paths.js';

const execFile = promisify(execFileCallback);

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'runtime-instance-store-')));
  const root = join(parent, 'repository');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const paths = await resolveStatePaths(root, 'runtime-one');
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, paths };
}

function initial() {
  return { schemaVersion: 1, version: 0, status: 'approved', values: [] };
}

test('persists the orchestrator instance contract with outer locking and runtime CAS versions', async t => {
  const f = await fixture(t);
  const instance = createRuntimeInstance({ id: 'runtime-one', paths: f.paths, initialState: initial() });

  const lock = await instance.acquire();
  assert.equal(JSON.stringify(await instance.read()), JSON.stringify(initial()));
  const committed = await instance.commit(0, { ...initial(), version: 1, values: ['worker-one'] });
  assert.deepEqual(committed.values, ['worker-one']);
  await lock.release();

  const metadata = await lstat(f.paths.snapshotPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  const next = await instance.acquire();
  await assert.rejects(
    () => instance.commit(0, { ...initial(), version: 1 }),
    error => error.code === 'ERR_STATE_VERSION_CONFLICT',
  );
  await next.release();
});

test('serializes callers across instance objects and shares state through linked worktrees', async t => {
  const f = await fixture(t);
  const first = createRuntimeInstance({ id: 'runtime-one', paths: f.paths, initialState: initial() });
  const second = createRuntimeInstance({ id: 'runtime-one', paths: f.paths, initialState: initial() });
  const held = await first.acquire();
  let secondAcquired = false;
  const waiting = second.acquire().then(lock => { secondAcquired = true; return lock; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(secondAcquired, false);
  await held.release();
  const secondLock = await waiting;
  assert.equal(JSON.stringify(await second.read()), JSON.stringify(initial()));
  await secondLock.release();

  const linked = join(f.parent, 'linked');
  await execFile('git', ['-C', f.root, 'worktree', 'add', '--quiet', '-b', 'feature/linked', linked]);
  const linkedPaths = await resolveStatePaths(linked, 'runtime-one');
  assert.equal(linkedPaths.instanceDir, f.paths.instanceDir);
  const linkedInstance = createRuntimeInstance({ id: 'runtime-one', paths: linkedPaths, initialState: initial() });
  const linkedLock = await linkedInstance.acquire();
  assert.equal(JSON.stringify(await linkedInstance.read()), JSON.stringify(initial()));
  await linkedLock.release();
});

test('requires the outer lock for reads and commits and rejects hostile construction', async t => {
  const f = await fixture(t);
  const instance = createRuntimeInstance({ id: 'runtime-one', paths: f.paths, initialState: initial() });
  await assert.rejects(() => instance.read(), /lock/i);
  await assert.rejects(() => instance.commit(0, initial()), /lock/i);
  assert.throws(() => createRuntimeInstance({ id: '../escape', paths: f.paths, initialState: initial() }));
  assert.throws(() => createRuntimeInstance({ id: 'runtime-one', paths: {}, initialState: initial() }));
});
