import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../helpers/run-cli.js';

async function createProject(t) {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  return projectDir;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('uninstall --all --target=both removes package skills and preserves unrelated files', async (t) => {
  const projectDir = await createProject(t);
  const install = await runCli(['install', '--all', '--target=both'], { cwd: projectDir });
  install.assertSuccess();

  const unrelatedClaude = join(projectDir, '.claude', 'skills', 'rivet-team-owned', 'SKILL.md');
  const unrelatedCodex = join(projectDir, '.codex', 'skills', 'rivet-team-owned', 'SKILL.md');
  await mkdir(join(unrelatedClaude, '..'), { recursive: true });
  await mkdir(join(unrelatedCodex, '..'), { recursive: true });
  await writeFile(unrelatedClaude, 'team owned\n');
  await writeFile(unrelatedCodex, 'team owned\n');
  const governancePath = join(projectDir, '.claude', 'usage-rules.md');
  const governanceBefore = await readFile(governancePath, 'utf8');

  const result = await runCli(['uninstall', '--all', '--target=both'], { cwd: projectDir });
  result.assertSuccess();

  for (const platform of ['.claude', '.codex']) {
    assert.equal(await pathExists(join(projectDir, platform, 'skills', 'rivet-design')), false);
    assert.equal(await pathExists(join(projectDir, platform, 'skills', 'rivet-debugging')), false);
    assert.equal(await pathExists(join(projectDir, platform, 'skills', 'rivet-qa-agent')), false);
  }
  assert.equal(await readFile(unrelatedClaude, 'utf8'), 'team owned\n');
  assert.equal(await readFile(unrelatedCodex, 'utf8'), 'team owned\n');
  assert.equal(await readFile(governancePath, 'utf8'), governanceBefore);
  assert.match(result.stdout, /Uninstalled \d+ skills for: claude, codex/);
});

test('targeted uninstall removes Codex skills while preserving Claude skills', async (t) => {
  const projectDir = await createProject(t);
  const install = await runCli(['install', '--all', '--target=both'], { cwd: projectDir });
  install.assertSuccess();

  const result = await runCli(['uninstall', '--all', '--target=codex'], { cwd: projectDir });
  result.assertSuccess();

  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-design')), false);
  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-debugging')), false);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-debugging', 'SKILL.md')), true);
});

test('uninstall rejects a symlinked skills target without deleting outside the project', async (t) => {
  const projectDir = await createProject(t);
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-symlink-uninstall-victim-'));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  const victimSkill = join(victimDir, 'design', 'SKILL.md');
  await mkdir(join(victimSkill, '..'), { recursive: true });
  await writeFile(victimSkill, 'victim-owned\n');
  await mkdir(join(projectDir, '.codex'), { recursive: true });
  await symlink(victimDir, join(projectDir, '.codex', 'skills'), 'dir');

  const result = await runCli(['uninstall', '--all', '--target=codex'], { cwd: projectDir });

  result.assertExitCode(6);
  assert.match(result.stderr, /target path contains a symbolic link/i);
  assert.equal(await readFile(victimSkill, 'utf8'), 'victim-owned\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(victimDir), false);
});

test('uninstall is a successful no-op when only unrelated skills are present', async (t) => {
  const projectDir = await createProject(t);
  const unrelated = join(projectDir, '.claude', 'skills', 'rivet-team-owned', 'SKILL.md');
  await mkdir(join(unrelated, '..'), { recursive: true });
  await writeFile(unrelated, 'keep me\n');

  const result = await runCli(['uninstall', '--all', '--target=claude'], { cwd: projectDir });
  result.assertSuccess();

  assert.match(result.stderr, /None of this package's skills were found/);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep me\n');
});

test('EOF cancels interactive uninstall and preserves installed files', async (t) => {
  const projectDir = await createProject(t);
  const install = await runCli(['install', '--all', '--target=claude'], { cwd: projectDir });
  install.assertSuccess();

  const result = await runCli(['uninstall', '--target=claude'], { cwd: projectDir });
  result.assertSuccess();

  assert.match(result.stdout, /Cancelled\./);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-debugging', 'SKILL.md')), true);
});

test('uninstall rejects invalid targets without removing installed skills', async (t) => {
  const projectDir = await createProject(t);
  const install = await runCli(['install', '--all', '--target=claude'], { cwd: projectDir });
  install.assertSuccess();

  const result = await runCli(['uninstall', '--all', '--target=vim'], { cwd: projectDir });
  result.assertExitCode(1);

  assert.match(result.stderr, /Invalid --target value/);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
});

test('uninstall rejects conflicting target selectors without removing installed skills', async (t) => {
  const projectDir = await createProject(t);
  const setup = await runCli(['install', '--all', '--target=both'], { cwd: projectDir });
  setup.assertSuccess();

  const result = await runCli([
    'uninstall',
    '--all',
    '--claude',
    '--target=codex',
  ], { cwd: projectDir });

  result.assertExitCode(1);
  assert.match(result.stderr, /Conflicting target selectors/);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-design', 'SKILL.md')), true);
});
