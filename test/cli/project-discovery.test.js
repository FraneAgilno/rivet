import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { resolveConfiguredProject } from '../../src/cli/project-discovery.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);

test('configured project is inferred from root or a nested directory', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-project-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q']);
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  const nested = join(root, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  assert.equal((await resolveConfiguredProject(root)).root, root);
  assert.equal((await resolveConfiguredProject(root, undefined, {
    env: { PATH: root },
    runner: async command => {
      assert.equal(command.startsWith('/'), true);
      assert.notEqual(command, join(root, 'git'));
      return { code: 0, stdout: `${root}\n`, truncated: { stdout: false } };
    },
  })).root, root);
  assert.equal((await resolveConfiguredProject(nested)).root, root);
  assert.equal((await resolveConfiguredProject(nested, root)).root, root);
  await assert.rejects(() => resolveConfiguredProject(nested, join(root, 'src')),
    /must name the configured Git project root/);
  await mkdir(join(root, 'src', '.rivet'));
  await assert.rejects(() => resolveConfiguredProject(nested), /nested .rivet/);
  assert.equal((await resolveConfiguredProject(nested, root)).root, root);
});

test('configured project discovery supports spaces and linked Git worktree metadata', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet project spaces ')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'main project');
  const worktree = join(parent, 'linked project');
  await mkdir(root);
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q', '-b', 'main']);
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await execFile('/usr/bin/git', ['-C', root, 'add', '.']);
  await execFile('/usr/bin/git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'fixture']);
  await execFile('/usr/bin/git', ['-C', root, 'worktree', 'add', '-q', '-b', 'linked', worktree]);
  const nested = join(worktree, 'nested folder');
  await mkdir(nested);
  assert.equal((await resolveConfiguredProject(nested)).root, worktree);
  assert.equal((await resolveConfiguredProject(nested, worktree)).root, worktree);
});

test('unconfigured or non-Git current directories have actionable errors', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-project-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => resolveConfiguredProject(root), /Git project configured/);
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q']);
  await assert.rejects(() => resolveConfiguredProject(root), /rivet setup --write/);
});
