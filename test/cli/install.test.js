import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../helpers/run-cli.js';

async function createProject(t, prefix = 'rivet-install-') {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
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

test('install --all --target=both installs the mandatory design skill for Claude and Codex', async (t) => {
  const projectDir = await createProject(t);

  const result = await runCli(['install', '--all', '--target=both'], { cwd: projectDir });
  result.assertSuccess();

  const claudeDesign = await readFile(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md'), 'utf8');
  const codexDesign = await readFile(join(projectDir, '.codex', 'skills', 'rivet-design', 'SKILL.md'), 'utf8');

  assert.equal(claudeDesign, codexDesign);
  assert.match(claudeDesign, /^---\nname: rivet-design\ndescription: "Write a design document for a Jira ticket before any code is written\."\n---\n\n# Design\n/);
});

test('install --target=claude writes mandatory and optional skills only to the Claude project target', async (t) => {
  const projectDir = await createProject(t);

  const result = await runCli(['install', '--all', '--target=claude'], { cwd: projectDir });
  result.assertSuccess();

  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-debugging', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.claude', 'skills', 'rivet-qa-agent', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.codex')), false);
  assert.match(result.stdout, /Installed \d+ skills in project for: claude/);
});

test('install --codex resolves the Codex-only project target', async (t) => {
  const projectDir = await createProject(t);

  const result = await runCli(['install', '--all', '--codex'], { cwd: projectDir });
  result.assertSuccess();

  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-debugging', 'SKILL.md')), true);
  assert.equal(await pathExists(join(projectDir, '.claude')), false);
});

test('project installs resolve an ancestor package root instead of the invocation directory', async (t) => {
  const projectDir = await createProject(t);
  const nestedDir = join(projectDir, 'packages', 'nested');
  await mkdir(nestedDir, { recursive: true });

  const result = await runCli(['install', '--all', '--target=codex'], { cwd: nestedDir });
  result.assertSuccess();

  assert.equal(await pathExists(join(projectDir, '.codex', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(nestedDir, '.codex')), false);
});

test('install rejects a symlinked skills target without writing outside the project', async (t) => {
  const projectDir = await createProject(t, 'rivet-symlink-install-project-');
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-symlink-install-victim-'));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await mkdir(join(projectDir, '.codex'), { recursive: true });
  await symlink(victimDir, join(projectDir, '.codex', 'skills'), 'dir');

  const result = await runCli(['install', '--all', '--target=codex'], { cwd: projectDir });

  result.assertExitCode(6);
  assert.match(result.stderr, /target path contains a symbolic link/i);
  assert.equal((await readdir(victimDir)).length, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(victimDir), false);
});

test('global installs use isolated HOME and CODEX_HOME targets', async (t) => {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'rivet-global-'));
  t.after(() => rm(sandboxDir, { recursive: true, force: true }));
  const fakeHome = join(sandboxDir, 'home');
  const codexHome = join(sandboxDir, 'codex-home');
  const cwd = join(sandboxDir, 'outside-project');
  await mkdir(cwd, { recursive: true });

  const result = await runCli(['install', '--all', '--global', '--target=both'], {
    cwd,
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      XDG_CONFIG_HOME: join(sandboxDir, 'xdg'),
      CODEX_HOME: codexHome,
    },
  });
  result.assertSuccess();

  assert.equal(await pathExists(join(fakeHome, '.claude', 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(codexHome, 'skills', 'rivet-design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(cwd, '.claude')), false);
  assert.equal(await pathExists(join(cwd, '.codex')), false);
});

test('install rejects an invalid target without writing project configuration', async (t) => {
  const projectDir = await createProject(t);

  const result = await runCli(['install', '--all', '--target=vim'], { cwd: projectDir });
  result.assertExitCode(1);

  assert.match(result.stderr, /Invalid --target value/);
  assert.equal(await pathExists(join(projectDir, '.claude')), false);
  assert.equal(await pathExists(join(projectDir, '.codex')), false);
});

test('install rejects conflicting target selectors without writing project configuration', async (t) => {
  const cases = [
    ['--claude', '--target=codex'],
    ['--codex', '--target=claude'],
    ['--claude', '--target=both'],
  ];

  for (const selectors of cases) {
    const projectDir = await createProject(t, 'rivet-conflicting-target-');
    const result = await runCli(['install', '--all', ...selectors], { cwd: projectDir });

    result.assertExitCode(1);
    assert.match(result.stderr, /Conflicting target selectors/);
    assert.equal(await pathExists(join(projectDir, '.claude')), false);
    assert.equal(await pathExists(join(projectDir, '.codex')), false);
  }
});

test('install outside a project reports the missing project root without writing configuration', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-no-project-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const result = await runCli(['install', '--all', '--target=claude'], { cwd });
  result.assertExitCode(1);

  assert.match(result.stderr, /Could not find project root/);
  assert.equal(await pathExists(join(cwd, '.claude')), false);
});

test('EOF cancels optional selection without installing any skills', async (t) => {
  const projectDir = await createProject(t);

  const result = await runCli(['install', '--target=claude'], { cwd: projectDir });
  result.assertSuccess();

  assert.match(result.stdout, /Cancelled\./);
  assert.equal(await pathExists(join(projectDir, '.claude')), false);
});
