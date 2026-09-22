import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LockBusyError,
  StaleLockError,
  acquireLock,
  recoverStaleLock,
} from '../../src/state/lock.js';

async function lockPath() {
  const root = await mkdtemp(join(tmpdir(), 'agilno-lock-'));
  return join(root, 'state.lock');
}

test('acquires a private exclusive lock with bounded owner metadata', async () => {
  const path = await lockPath();
  const lock = await acquireLock(path, { now: () => 1_700_000_000_000 });
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  const mode = (await lstat(path)).mode & 0o777;

  assert.equal(mode, 0o600);
  assert.equal(metadata.pid, process.pid);
  assert.equal(typeof metadata.host, 'string');
  assert.equal(metadata.timestamp, '2023-11-14T22:13:20.000Z');
  assert.equal(typeof metadata.ownerId, 'string');
  assert.ok(metadata.ownerId.length <= 64);

  await assert.rejects(() => acquireLock(path, { now: () => 1_700_000_000_000 }), LockBusyError);
  await lock.release();
  await assert.rejects(() => lstat(path), { code: 'ENOENT' });
});

test('does not automatically remove a stale lock and requires explicit recovery', async () => {
  const path = await lockPath();
  const oldNow = 1_700_000_000_000;
  const lock = await acquireLock(path, { now: () => oldNow });

  await assert.rejects(
    () => acquireLock(path, { now: () => oldNow + 61_000, staleAfterMs: 60_000 }),
    error => error instanceof StaleLockError && /recovery command/i.test(error.message),
  );
  assert.equal((await lstat(path)).isFile(), true);
  await recoverStaleLock(path, { now: () => oldNow + 61_000, staleAfterMs: 60_000 });
  await assert.rejects(() => lstat(path), { code: 'ENOENT' });

  await assert.rejects(lock.release(), /ownership changed/);
  const replacement = await acquireLock(path, { now: () => oldNow + 61_000 });
  await replacement.release();
});

test('refuses recovery of a live lock and refuses to release another owner lock', async () => {
  const path = await lockPath();
  const now = 1_700_000_000_000;
  const lock = await acquireLock(path, { now: () => now });
  await assert.rejects(
    () => recoverStaleLock(path, { now: () => now + 1_000, staleAfterMs: 60_000 }),
    LockBusyError,
  );

  await unlink(path);
  await writeFile(path, `${JSON.stringify({
    pid: 42,
    host: 'replacement-host',
    timestamp: new Date(now).toISOString(),
    ownerId: '00000000-0000-4000-8000-000000000000',
  })}\n`, { mode: 0o600 });
  await assert.rejects(lock.release(), /ownership changed/);
  assert.equal((await lstat(path)).isFile(), true);
});

test('rejects symlink and non-private existing lock files', async () => {
  const path = await lockPath();
  const target = `${path}.target`;
  await writeFile(target, '{}\n', { mode: 0o600 });
  await import('node:fs/promises').then(({ symlink }) => symlink(target, path));
  await assert.rejects(() => acquireLock(path), /unsafe state lock/i);

  await unlink(path);
  await writeFile(path, '{}\n', { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(() => acquireLock(path), /unsafe state lock/i);
});

test('rejects hard-linked lock files without changing the external alias', async () => {
  const path = await lockPath();
  const alias = `${path}.outside-alias`;
  const now = 1_700_000_000_000;
  const lock = await acquireLock(path, { now: () => now });
  await link(path, alias);
  const externalBefore = await readFile(alias, 'utf8');

  await assert.rejects(() => acquireLock(path, { now: () => now }), /unsafe state lock/i);
  assert.equal(await readFile(alias, 'utf8'), externalBefore);

  await unlink(alias);
  await lock.release();
});
