import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { resetConferenceDemo } from '../../demo/conference/scripts/reset.mjs';

const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  return (await execFile('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'conference-reset-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'demo@example.invalid');
  await git(root, 'config', 'user.name', 'Conference Demo');
  await writeFile(path.join(root, 'README.md'), '# Demo\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'initial');
  const head = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'update-ref', 'refs/tags/conference-demo/baseline', head, '0'.repeat(40));
  return { root, head };
}

async function state(root, entries = ['mode.json', 'instance.json', 'events.jsonl']) {
  const stateRoot = path.join(root, 'demo/conference/.state');
  await mkdir(stateRoot, { recursive: true });
  for (const entry of entries) await writeFile(path.join(stateRoot, entry), `${entry}\n`);
  return stateRoot;
}

test('reset archives only allowlisted demo state after exact confirmation', async () => {
  const { root, head } = await repository();
  await state(root);
  const result = await resetConferenceDemo({
    repositoryRoot: root,
    checkpoint: 'baseline',
    expectedHead: head,
    confirmation: 'RESET conference demo baseline',
  });

  assert.deepEqual(result, {
    checkpoint: 'baseline',
    commit: head,
    archived: true,
    archive: 'demo/conference/.state-archive/baseline',
  });
  await assert.rejects(() => access(path.join(root, 'demo/conference/.state')));
  assert.equal(await readFile(path.join(root, result.archive, 'mode.json'), 'utf8'), 'mode.json\n');
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# Demo\n');

  const repeated = await resetConferenceDemo({
    repositoryRoot: root,
    checkpoint: 'baseline',
    expectedHead: head,
    confirmation: 'RESET conference demo baseline',
  });
  assert.equal(repeated.archived, false);
});

test('reset rejects missing confirmation, dirty tracked files, wrong checkpoints, and unsafe state entries', async () => {
  const { root, head } = await repository();
  await state(root);
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: 'baseline', expectedHead: head, confirmation: 'yes' }));
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: '../escape', expectedHead: head, confirmation: 'RESET conference demo ../escape' }));
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: 'missing', expectedHead: head, confirmation: 'RESET conference demo missing' }));
  await writeFile(path.join(root, 'README.md'), '# Dirty\n');
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: 'baseline', expectedHead: head, confirmation: 'RESET conference demo baseline' }));

  await writeFile(path.join(root, 'README.md'), '# Demo\n');
  await writeFile(path.join(root, 'demo/conference/.state/unexpected.txt'), 'unsafe\n');
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: 'baseline', expectedHead: head, confirmation: 'RESET conference demo baseline' }));
});

test('reset rejects symlinked state and archive roots without touching their targets', async () => {
  const { root, head } = await repository();
  const outside = await mkdtemp(path.join(tmpdir(), 'conference-reset-outside-'));
  await writeFile(path.join(outside, 'sentinel'), 'preserved\n');
  await mkdir(path.join(root, 'demo/conference'), { recursive: true });
  await symlink(outside, path.join(root, 'demo/conference/.state'));
  await assert.rejects(() => resetConferenceDemo({ repositoryRoot: root, checkpoint: 'baseline', expectedHead: head, confirmation: 'RESET conference demo baseline' }));
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserved\n');
});

