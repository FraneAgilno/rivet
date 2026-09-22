import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createCheckpoint } from '../../demo/conference/scripts/checkpoint.mjs';
import { selectFixtureMode } from '../../demo/conference/scripts/fixture-mode.mjs';
import { prepareConferenceDemo } from '../../demo/conference/scripts/prepare.mjs';
import { verifyRecording } from '../../demo/conference/scripts/verify-recording.mjs';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return (await execFile('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function repository(prefix = 'conference-checkpoint-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'demo@example.invalid');
  await git(root, 'config', 'user.name', 'Conference Demo');
  await writeFile(path.join(root, 'README.md'), '# Demo\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'initial');
  return root;
}

async function preparedPair() {
  const platformRoot = await repository('conference-platform-');
  const applicationRoot = await repository('conference-app-');
  await mkdir(path.join(platformRoot, 'demo/conference/fixtures/jira'), { recursive: true });
  await mkdir(path.join(platformRoot, 'demo/conference/fixtures/confluence'), { recursive: true });
  await writeFile(path.join(platformRoot, 'demo/conference/goal-graph.yaml'), 'schemaVersion: 1\n');
  await writeFile(path.join(platformRoot, 'demo/conference/authority.yaml'), 'schemaVersion: 1\n');
  await writeFile(path.join(platformRoot, 'demo/conference/completion-profile.yaml'), 'schemaVersion: 1\n');
  await writeFile(path.join(platformRoot, 'demo/conference/fixtures/jira/issues.json'), '{}\n');
  await writeFile(path.join(platformRoot, 'demo/conference/fixtures/confluence/pages.json'), '{}\n');
  await mkdir(path.join(applicationRoot, '.rivet'), { recursive: true });
  await mkdir(path.join(applicationRoot, 'design'), { recursive: true });
  await writeFile(path.join(applicationRoot, 'package.json'), '{}\n');
  await writeFile(path.join(applicationRoot, 'bitbucket-pipelines.yml'), 'pipelines: {}\n');
  await writeFile(path.join(applicationRoot, '.rivet/acceptance.yaml'), '{}\n');
  await writeFile(path.join(applicationRoot, 'design/design-system-manifest.json'), '{}\n');
  await git(platformRoot, 'add', '.');
  await git(platformRoot, 'commit', '-qm', 'conference demo');
  await git(applicationRoot, 'add', '.');
  await git(applicationRoot, 'commit', '-qm', 'conference app');
  return { platformRoot, applicationRoot };
}

test('creates exact idempotent Git checkpoints without changing the worktree', async () => {
  const root = await repository();
  const head = await git(root, 'rev-parse', 'HEAD');
  const first = await createCheckpoint({ repositoryRoot: root, name: 'corrected', expectedHead: head });
  const second = await createCheckpoint({ repositoryRoot: root, name: 'corrected', expectedHead: head });

  assert.deepEqual(first, { name: 'corrected', ref: 'refs/tags/conference-demo/corrected', commit: head, created: true });
  assert.deepEqual(second, { name: 'corrected', ref: 'refs/tags/conference-demo/corrected', commit: head, created: false });
  assert.equal(await git(root, 'rev-parse', 'refs/tags/conference-demo/corrected'), head);
  assert.equal(await git(root, 'status', '--porcelain'), '');
});

test('checkpoint creation rejects dirty, mismatched, unsafe, and symlinked repositories', async () => {
  const root = await repository();
  const head = await git(root, 'rev-parse', 'HEAD');
  await assert.rejects(() => createCheckpoint({ repositoryRoot: root, name: '../escape', expectedHead: head }));
  await assert.rejects(() => createCheckpoint({ repositoryRoot: root, name: 'baseline', expectedHead: '0'.repeat(40) }));
  await writeFile(path.join(root, 'README.md'), '# Changed\n');
  await assert.rejects(() => createCheckpoint({ repositoryRoot: root, name: 'baseline', expectedHead: head }));

  const parent = await mkdtemp(path.join(tmpdir(), 'conference-checkpoint-link-'));
  const linked = path.join(parent, 'linked');
  await symlink(root, linked);
  await assert.rejects(() => createCheckpoint({ repositoryRoot: linked, name: 'baseline', expectedHead: head }));
});

test('prepare validates two clean explicit repositories and never requires cloud credentials', async () => {
  const { platformRoot, applicationRoot } = await preparedPair();
  const result = await prepareConferenceDemo({ platformRoot, applicationRoot, minimumNodeMajor: 18 });

  assert.equal(result.ready, true);
  assert.equal(result.mode, 'local-fixture');
  assert.match(result.platformCommit, /^[0-9a-f]{40}$/);
  assert.match(result.applicationCommit, /^[0-9a-f]{40}$/);
  assert.equal(Object.hasOwn(result, 'credentials'), false);

  await writeFile(path.join(applicationRoot, 'package.json'), '{"changed":true}\n');
  await assert.rejects(() => prepareConferenceDemo({ platformRoot, applicationRoot, minimumNodeMajor: 18 }));
});

test('fixture mode writes one bounded visible provenance record and rejects live claims', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'conference-mode-'));
  const fixture = await selectFixtureMode({ demoRoot: root, mode: 'fixture', commit: 'a'.repeat(40) });
  assert.equal(fixture.mode, 'fixture');
  assert.equal(fixture.provenance, 'sanitized-read-only-fixtures');
  const stored = JSON.parse(await readFile(path.join(root, '.state/mode.json'), 'utf8'));
  assert.deepEqual(stored, fixture);
  await assert.rejects(() => selectFixtureMode({ demoRoot: root, mode: 'live', commit: 'a'.repeat(40) }));
  await assert.rejects(() => selectFixtureMode({ demoRoot: root, mode: 'recording', commit: 'a'.repeat(40) }));
});

test('recording verification checks exact media and backup bytes without claiming creation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'conference-recording-'));
  const header = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 0]);
  const primary = path.join(root, 'rehearsal.mp4');
  const backup = path.join(root, 'rehearsal-backup.mp4');
  await writeFile(primary, header);
  await writeFile(backup, header);
  const verified = await verifyRecording({ recordingPath: primary, backupPath: backup, maximumBytes: 1024 });
  assert.equal(verified.verified, true);
  assert.equal(verified.bytes, header.length);
  assert.match(verified.sha256, /^[0-9a-f]{64}$/);
  assert.equal(verified.createdByTool, false);

  await writeFile(backup, Buffer.concat([header, Buffer.from('different')]));
  await assert.rejects(() => verifyRecording({ recordingPath: primary, backupPath: backup, maximumBytes: 1024 }));
  const link = path.join(root, 'linked.mp4');
  await symlink(primary, link);
  await assert.rejects(() => verifyRecording({ recordingPath: link, backupPath: primary, maximumBytes: 1024 }));
});

test('runbook materials expose provenance, timing, recovery, ownership, and human follow-ups', async () => {
  const documents = Object.fromEntries(await Promise.all([
    'RUNBOOK.md',
    'SPEAKER-NOTES.md',
    'CHECKPOINTS.md',
    'RECOVERY.md',
    'REHEARSAL-CHECKLIST.md',
  ].map(async filename => [filename, await readFile(path.join(new URL('../../demo/conference/', import.meta.url).pathname, filename), 'utf8')])));

  assert.match(documents['RUNBOOK.md'], /60-minute/i);
  assert.match(documents['RUNBOOK.md'], /fixture mode/i);
  assert.match(documents['RUNBOOK.md'], /checkpoint mode/i);
  assert.match(documents['RUNBOOK.md'], /recording mode/i);
  assert.match(documents['RUNBOOK.md'], /responsible/i);
  assert.match(documents['RUNBOOK.md'], /provenance/i);
  assert.match(documents['SPEAKER-NOTES.md'], /simulated evidence/i);
  assert.match(documents['CHECKPOINTS.md'], /does not run `git reset --hard`/i);
  assert.match(documents['RECOVERY.md'], /30 seconds/i);
  for (const failure of ['Bitbucket Pipelines', 'provider', 'model client', 'hosting', 'design']) {
    assert.match(documents['RECOVERY.md'], new RegExp(failure, 'i'));
  }
  assert.match(documents['REHEARSAL-CHECKLIST.md'], /\[ \] Record a complete successful run/);
  assert.match(documents['REHEARSAL-CHECKLIST.md'], /\[ \] Obtain human final approval/);
  assert.match(documents['REHEARSAL-CHECKLIST.md'], /not yet complete/i);
});
