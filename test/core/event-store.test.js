import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readdirSync, renameSync, symlinkSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createEventStore } from '../../src/state/event-store.js';
import { resolveStatePaths } from '../../src/state/paths.js';
import { createSnapshotStore } from '../../src/state/snapshot-store.js';

const execFile = promisify(execFileCallback);

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'agilno-state-repo-'));
  await execFile('git', ['init', '--quiet', root]);
  return root;
}

async function setup(instance = 'conference-demo') {
  const root = await temporaryRepository();
  const paths = await resolveStatePaths(root, instance);
  return { root, paths, store: createEventStore(paths) };
}

let id = 0;
function event(type = 'graph-created', extra = {}) {
  id += 1;
  const heartbeat = type === 'heartbeat' ? { nodeId: 'worker-one', instanceId: 'conference-demo', leaseId: 'worker-lease', heartbeatSequence: id, heartbeatIntervalMs: 100 } : {};
  return {
    schemaVersion: 1,
    eventId: `event-${id}`,
    graphId: 'graph-demo',
    timestamp: '2026-08-13T12:00:00.000Z',
    actor: { role: 'boss', id: 'portfolio-boss' },
    type,
    ...heartbeat,
    ...extra,
  };
}

test('resolves private instance state beneath the real Git common directory', async () => {
  const root = await temporaryRepository();
  const paths = await resolveStatePaths(join(root, 'nested', '..'), 'conference-demo');
  const gitCommonDir = await realpath(join(root, '.git'));

  assert.equal(paths.gitCommonDir, gitCommonDir);
  assert.equal(paths.instanceDir, join(gitCommonDir, 'rivet', 'conference-demo'));
  assert.equal((await lstat(paths.instanceDir)).isDirectory(), true);
  assert.equal((await lstat(paths.instanceDir)).mode & 0o777, 0o700);
  await assert.rejects(() => resolveStatePaths(root, '../escape'), /invalid state instance/i);
});

test('rejects a state root symlink that resolves outside the Git common directory', async () => {
  const root = await temporaryRepository();
  const outside = await mkdtemp(join(tmpdir(), 'agilno-state-outside-'));
  await symlink(outside, join(root, '.git', 'rivet'));

  await assert.rejects(() => resolveStatePaths(root, 'conference-demo'), /outside the Git common directory/);
});

test('linked worktrees resolve the same private state instance', async () => {
  const root = await temporaryRepository();
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await execFile('git', ['-C', root, 'add', 'README.md']);
  await execFile('git', [
    '-C', root,
    '-c', 'user.name=Agilno Test',
    '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const worktree = await mkdtemp(join(tmpdir(), 'agilno-linked-worktree-parent-'));
  const linked = join(worktree, 'linked');
  await execFile('git', ['-C', root, 'worktree', 'add', '--quiet', '-b', 'fixture-linked', linked]);

  const primary = await resolveStatePaths(root, 'conference-demo');
  const secondary = await resolveStatePaths(linked, 'conference-demo');
  assert.equal(primary.gitCommonDir, secondary.gitCommonDir);
  assert.equal(primary.instanceDir, secondary.instanceDir);
});

test('stores reject caller-forged path objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-forged-state-'));
  const forged = {
    eventsPath: join(root, 'events.jsonl'),
    snapshotPath: join(root, 'snapshot.json'),
    lockPath: join(root, 'state.lock'),
  };
  assert.throws(() => createEventStore(forged), /verified private state paths/);
  assert.throws(() => createSnapshotStore(forged), /verified private state paths/);
});

test('fails closed before mutation when private POSIX semantics are unavailable', async () => {
  const root = await temporaryRepository();
  await assert.rejects(
    () => resolveStatePaths(root, 'windows-demo', { platform: 'win32' }),
    error => error.code === 'ERR_PRIVATE_STATE_UNSUPPORTED_PLATFORM',
  );
  await assert.rejects(() => lstat(join(root, '.git', 'rivet')), { code: 'ENOENT' });
});

test('persists private append-only events with assigned monotonic sequences', async () => {
  const { paths, store } = await setup();
  const first = await store.append(event(), { expectedVersion: 0 });
  const before = await readFile(paths.eventsPath, 'utf8');
  const second = await store.append(event('heartbeat'), { expectedVersion: 1 });
  const after = await readFile(paths.eventsPath, 'utf8');

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(after.startsWith(before), true);
  assert.equal((await lstat(paths.eventsPath)).mode & 0o777, 0o600);
  assert.deepEqual((await store.read()).map(item => item.sequence), [1, 2]);
  assert.equal(await store.version(), 2);
});

test('rejects an append against a stale expected version', async () => {
  const { store } = await setup();
  await store.append(event(), { expectedVersion: 0 });
  await assert.rejects(
    () => store.append(event('heartbeat'), { expectedVersion: 0 }),
    /state version conflict/,
  );
  assert.equal((await store.read()).length, 1);
});

test('rejects caller-forged sequence numbers and duplicate event identifiers', async () => {
  const { store } = await setup();
  const first = event();
  await assert.rejects(
    () => store.append({ ...first, sequence: 2 }, { expectedVersion: 0 }),
    /event sequence conflict/i,
  );
  await store.append(first, { expectedVersion: 0 });
  await assert.rejects(
    () => store.append({ ...event('heartbeat'), eventId: first.eventId }, { expectedVersion: 1 }),
    /duplicate event identifier/i,
  );
});

test('allows exactly one concurrent writer to win a compare-and-set collision', async () => {
  const { paths } = await setup();
  const left = createEventStore(paths);
  const right = createEventStore(paths);
  const results = await Promise.allSettled([
    left.append(event(), { expectedVersion: 0 }),
    right.append(event(), { expectedVersion: 0 }),
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await left.read()).length, 1);
});

test('allows exactly one child process to win CAS with a stable loser classification', async () => {
  const { root, paths, store } = await setup('child-process-cas');
  const pathsModule = new URL('../../src/state/paths.js', import.meta.url).href;
  const storeModule = new URL('../../src/state/event-store.js', import.meta.url).href;
  const source = `
    import { resolveStatePaths } from ${JSON.stringify(pathsModule)};
    import { createEventStore } from ${JSON.stringify(storeModule)};
    const [root, instance, eventId] = process.argv.slice(1);
    const paths = await resolveStatePaths(root, instance);
    try {
      const event = await createEventStore(paths).append({
        schemaVersion: 1,
        eventId,
        graphId: 'graph-demo',
        timestamp: '2026-08-13T12:00:00.000Z',
        actor: { role: 'worker', id: eventId },
        type: 'graph-created'
      }, { expectedVersion: 0 });
      console.log(JSON.stringify({ status: 'success', sequence: event.sequence }));
    } catch (error) {
      console.log(JSON.stringify({ status: 'failure', code: error.code ?? 'UNCLASSIFIED', name: error.name }));
    }
  `;
  const run = eventId => execFile(process.execPath, [
    '--input-type=module', '-e', source, root, 'child-process-cas', eventId,
  ], { cwd: root });

  const outputs = await Promise.all([run('worker-left'), run('worker-right')]);
  const results = outputs.map(({ stdout }) => JSON.parse(stdout.trim()));
  assert.equal(results.filter(result => result.status === 'success').length, 1);
  assert.deepEqual(
    results.filter(result => result.status === 'failure').map(result => result.code),
    ['ERR_STATE_VERSION_CONFLICT'],
    JSON.stringify(results),
  );
  assert.deepEqual((await store.read()).map(item => item.sequence), [1]);
  await assert.rejects(() => lstat(paths.lockPath), { code: 'ENOENT' });
});

test('caller event getters cannot redirect an append outside private state', async () => {
  const { paths, store } = await setup('event-getter-swap');
  const outside = await mkdtemp(join(tmpdir(), 'agilno-event-getter-outside-'));
  const original = `${paths.instanceDir}.original`;
  const malicious = event();
  Object.defineProperty(malicious, 'type', {
    enumerable: true,
    get() {
      renameSync(paths.instanceDir, original);
      symlinkSync(outside, paths.instanceDir);
      return 'graph-created';
    },
  });

  await assert.rejects(() => store.append(malicious, { expectedVersion: 0 }));
  await assert.rejects(() => lstat(join(outside, 'events.jsonl')), { code: 'ENOENT' });
  await assert.rejects(() => lstat(join(original, 'state.lock')), { code: 'ENOENT' });
});

test('validates and redacts every event before persistence', async () => {
  const { paths, store } = await setup();
  const secret = 'jira-private-value-12345';
  const persisted = await store.append(event('retry', {
    retryReason: `Authorization: Bearer ${secret}`,
  }), { expectedVersion: 0, environment: { JIRA_API_TOKEN: secret } });
  const raw = await readFile(paths.eventsPath, 'utf8');

  assert.equal(raw.includes(secret), false);
  assert.equal(persisted.retryReason.includes(secret), false);
  const invalid = event('heartbeat', { unexpected: 'field' });
  await assert.rejects(() => store.append(invalid, { expectedVersion: 1 }), /Tracked configuration is invalid/);
  assert.equal((await store.read()).length, 1);
});

test('fails closed on interrupted or tampered JSONL without truncating it', async () => {
  const { paths, store } = await setup();
  await store.append(event(), { expectedVersion: 0 });
  await writeFile(paths.eventsPath, '{"partial":', { flag: 'a' });
  const damaged = await readFile(paths.eventsPath, 'utf8');

  await assert.rejects(() => store.read(), /invalid event ledger/i);
  await assert.rejects(() => store.append(event('heartbeat'), { expectedVersion: 1 }), /invalid event ledger/i);
  assert.equal(await readFile(paths.eventsPath, 'utf8'), damaged);
});

test('fails closed when an interrupted first append leaves a zero-byte ledger', async () => {
  const { paths, store } = await setup('zero-ledger');
  await writeFile(paths.eventsPath, '', { mode: 0o600 });

  await assert.rejects(() => store.read(), /invalid event ledger/i);
  await assert.rejects(() => store.append(event(), { expectedVersion: 0 }), /invalid event ledger/i);
  assert.equal(await readFile(paths.eventsPath, 'utf8'), '');
});

test('fsyncs the instance directory exactly when the ledger entry is first created', async () => {
  const { paths } = await setup('directory-sync');
  let directorySyncs = 0;
  const store = createEventStore(paths, {
    async syncDirectory(handle) {
      directorySyncs += 1;
      await handle.sync();
    },
  });

  await store.append(event(), { expectedVersion: 0 });
  await store.append(event('heartbeat'), { expectedVersion: 1 });
  assert.equal(directorySyncs, 1);
});

test('classifies unsupported directory durability without exposing filesystem details', async () => {
  const { paths } = await setup('directory-sync-failure');
  const store = createEventStore(paths, {
    async syncDirectory() {
      throw new Error('raw filesystem detail must remain private');
    },
  });

  await assert.rejects(
    () => store.append(event(), { expectedVersion: 0 }),
    error => (
      error.code === 'ERR_STATE_DURABILITY_UNSUPPORTED'
      && !error.message.includes('raw filesystem detail')
    ),
  );
  assert.deepEqual((await store.read()).map(item => item.sequence), [1]);
  await assert.rejects(() => lstat(paths.lockPath), { code: 'ENOENT' });
});

test('rejects symlink and over-permissive event ledgers', async () => {
  const { paths } = await setup();
  const target = join(dirname(paths.eventsPath), 'target.jsonl');
  await writeFile(target, '', { mode: 0o600 });
  await symlink(target, paths.eventsPath);
  await assert.rejects(() => createEventStore(paths).read(), /unsafe event ledger/i);

  const alternate = await setup('second-demo');
  await writeFile(alternate.paths.eventsPath, '', { mode: 0o644 });
  await chmod(alternate.paths.eventsPath, 0o644);
  await assert.rejects(() => alternate.store.read(), /unsafe event ledger/i);
});

test('rejects a hard-linked event ledger without changing its external alias', async () => {
  const { paths, store } = await setup('hardlink-ledger');
  await store.append(event(), { expectedVersion: 0 });
  const alias = join(await mkdtemp(join(tmpdir(), 'agilno-ledger-alias-')), 'events.jsonl');
  await link(paths.eventsPath, alias);
  const externalBefore = await readFile(alias, 'utf8');

  await assert.rejects(() => store.append(event('heartbeat'), { expectedVersion: 1 }), /unsafe event ledger/i);
  assert.equal(await readFile(alias, 'utf8'), externalBefore);
  await unlink(alias);
});

test('atomically replaces snapshots and preserves the previous value on interruption', async () => {
  const { paths } = await setup();
  const snapshots = createSnapshotStore(paths);
  const first = await snapshots.write({ status: 'ready' }, { expectedVersion: 0 });
  assert.deepEqual(first, { version: 1, data: { status: 'ready' } });
  assert.equal((await lstat(paths.snapshotPath)).mode & 0o777, 0o600);

  const interrupted = createSnapshotStore(paths, {
    beforeCommit() {
      throw new Error('simulated interruption');
    },
  });
  await assert.rejects(
    () => interrupted.write({ status: 'running' }, { expectedVersion: 1 }),
    /simulated interruption/,
  );
  assert.deepEqual(await snapshots.read(), first);
  const names = await (await import('node:fs/promises')).readdir(paths.instanceDir);
  assert.deepEqual(names.filter(name => name.endsWith('.tmp')), []);
  await assert.rejects(
    () => snapshots.write({ status: 'running' }, { expectedVersion: 0 }),
    /state version conflict/,
  );
});

test('snapshot persistence redacts sensitive values', async () => {
  const { paths } = await setup();
  const secret = 'super-secret-value-12345';
  const snapshots = createSnapshotStore(paths, { environment: { DEMO_SECRET: secret } });
  await snapshots.write({ message: `failure: ${secret}` }, { expectedVersion: 0 });
  assert.equal((await readFile(paths.snapshotPath, 'utf8')).includes(secret), false);
});

test('rejects snapshot rollover beyond the maximum safe version without mutation', async () => {
  const { paths } = await setup('snapshot-version-rollover');
  const maximum = { version: Number.MAX_SAFE_INTEGER, data: { status: 'ready' } };
  await writeFile(paths.snapshotPath, `${JSON.stringify(maximum)}\n`, { mode: 0o600 });
  const snapshots = createSnapshotStore(paths);
  const before = await readFile(paths.snapshotPath, 'utf8');

  assert.deepEqual(await snapshots.read(), maximum);
  await assert.rejects(
    () => snapshots.write({ status: 'running' }, { expectedVersion: Number.MAX_SAFE_INTEGER }),
    error => error.code === 'ERR_STATE_VERSION_EXHAUSTED',
  );
  assert.equal(await readFile(paths.snapshotPath, 'utf8'), before);
  await assert.rejects(() => lstat(paths.lockPath), { code: 'ENOENT' });
});

test('rejects hard-linked snapshots and deterministic temp aliases without changing external files', async () => {
  const first = await setup('hardlink-snapshot');
  const snapshots = createSnapshotStore(first.paths);
  await snapshots.write({ status: 'ready' }, { expectedVersion: 0 });
  const snapshotAlias = join(await mkdtemp(join(tmpdir(), 'agilno-snapshot-alias-')), 'snapshot.json');
  await link(first.paths.snapshotPath, snapshotAlias);
  const snapshotBefore = await readFile(snapshotAlias, 'utf8');
  await assert.rejects(
    () => snapshots.write({ status: 'running' }, { expectedVersion: 1 }),
    /unsafe state snapshot/i,
  );
  assert.equal(await readFile(snapshotAlias, 'utf8'), snapshotBefore);
  await unlink(snapshotAlias);

  const second = await setup('hardlink-temp');
  const fixture = join(await mkdtemp(join(tmpdir(), 'agilno-temp-alias-')), 'fixture.txt');
  await writeFile(fixture, 'outside fixture remains unchanged\n', { mode: 0o600 });
  const fixtureBefore = await readFile(fixture, 'utf8');
  const temporaryId = 'hardlink-temp';
  const temporaryPath = join(
    second.paths.instanceDir,
    `.${basename(second.paths.snapshotPath)}.${temporaryId}.tmp`,
  );
  await link(fixture, temporaryPath);
  const tempSnapshots = createSnapshotStore(second.paths, { temporaryIdFactory: () => temporaryId });
  await assert.rejects(
    () => tempSnapshots.write({ status: 'ready' }, { expectedVersion: 0 }),
    /unsafe state snapshot temporary|EEXIST/i,
  );
  assert.equal(await readFile(fixture, 'utf8'), fixtureBefore);
});

test('snapshot interruption hook runs before state paths, locks, or temps are touched', async () => {
  const { paths } = await setup('snapshot-boundary');
  const baseline = createSnapshotStore(paths);
  await baseline.write({ status: 'ready' }, { expectedVersion: 0 });
  const originalSnapshot = await readFile(paths.snapshotPath, 'utf8');
  const outside = await mkdtemp(join(tmpdir(), 'agilno-snapshot-boundary-outside-'));
  const original = `${paths.instanceDir}.original`;
  let artifactsSeen = false;
  const interrupted = createSnapshotStore(paths, {
    beforeCommit() {
      artifactsSeen = readdirSync(paths.instanceDir).some(name => name === 'state.lock' || name.endsWith('.tmp'));
      renameSync(paths.instanceDir, original);
      symlinkSync(outside, paths.instanceDir);
      throw new Error('simulated pre-commit interruption');
    },
  });

  await assert.rejects(
    () => interrupted.write({ status: 'running' }, { expectedVersion: 1 }),
    /simulated pre-commit interruption/,
  );
  assert.equal(artifactsSeen, false);
  await assert.rejects(() => lstat(join(outside, 'snapshot.json')), { code: 'ENOENT' });
  await assert.rejects(() => lstat(join(original, 'state.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(original, 'snapshot.json'), 'utf8'), originalSnapshot);
});

test('caller snapshot traps run before locking and cannot redirect persistence', async () => {
  const { paths } = await setup('snapshot-proxy-swap');
  const outside = await mkdtemp(join(tmpdir(), 'agilno-snapshot-proxy-outside-'));
  const original = `${paths.instanceDir}.original`;
  let swapped = false;
  const data = new Proxy({ status: 'ready' }, {
    ownKeys(target) {
      if (!swapped) {
        renameSync(paths.instanceDir, original);
        symlinkSync(outside, paths.instanceDir);
        swapped = true;
      }
      return Reflect.ownKeys(target);
    },
  });

  await assert.rejects(() => createSnapshotStore(paths).write(data, { expectedVersion: 0 }));
  await assert.rejects(() => lstat(join(outside, 'snapshot.json')), { code: 'ENOENT' });
  await assert.rejects(() => lstat(join(original, 'state.lock')), { code: 'ENOENT' });
});

test('rejects symlink and over-permissive snapshots', async () => {
  const first = await setup('snapshot-link');
  const target = join(first.paths.instanceDir, 'target.json');
  await writeFile(target, '{}\n', { mode: 0o600 });
  await symlink(target, first.paths.snapshotPath);
  await assert.rejects(() => createSnapshotStore(first.paths).read(), /unsafe state snapshot/i);

  const second = await setup('snapshot-mode');
  await writeFile(second.paths.snapshotPath, '{}\n', { mode: 0o644 });
  await chmod(second.paths.snapshotPath, 0o644);
  await assert.rejects(() => createSnapshotStore(second.paths).read(), /unsafe state snapshot/i);
});
