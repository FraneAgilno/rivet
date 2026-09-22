import assert from 'node:assert/strict';
import * as filesystem from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { CliError, EXIT_CODES } from '../../src/cli/output.js';
import { install } from '../../src/commands/install.js';
import { uninstall } from '../../src/commands/uninstall.js';
import { inspectManagedInstall, managedInstall } from '../../src/install/managed.js';

const SKILL_TEXT = `---
name: rivet
description: Use Rivet's CLI-managed engineering workflow.
---

# Rivet

Run \`rivet --help\` for the current CLI surface.
`;

async function fixture(t, name = 'project with spaces') {
  const root = await mkdtemp(join(tmpdir(), 'rivet-managed-'));
  const project = join(root, name);
  const packageRoot = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  await mkdir(join(packageRoot, 'templates', 'harness'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@agilno/rivet',
    version: '1.2.3',
  }));
  await writeFile(join(packageRoot, 'templates', 'harness', 'SKILL.md'), SKILL_TEXT);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, packageRoot, home };
}

function captureOutput() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    output: {
      log: value => stdout.push(String(value)),
      warn: value => stderr.push(String(value)),
      error: value => stderr.push(String(value)),
      json: (value, stream = 'stdout') => (stream === 'stderr' ? stderr : stdout).push(value),
    },
  };
}

function dependencies(state, overrides = {}) {
  const capture = captureOutput();
  return {
    fs: filesystem,
    cwd: () => state.project,
    home: () => state.home,
    env: {},
    packageRoot: state.packageRoot,
    output: capture.output,
    capture,
    ...overrides,
  };
}

function parsed(command = 'install', flags = {}) {
  return { command, subcommand: null, operands: [], flags: { minimal: true, ...flags } };
}

test('inspection plans both exact project destinations without writing', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);

  const plan = inspectManagedInstall(parsed('install', {
    project: state.project,
    target: 'both',
  }), deps);

  assert.equal(plan.scope, 'project');
  assert.equal(plan.projectRoot, resolve(state.project));
  assert.deepEqual(plan.targets.map(item => item.target), ['claude', 'codex']);
  const canonicalProject = filesystem.realpathSync(state.project);
  assert.deepEqual(plan.targets.map(item => item.skillDir), [
    join(canonicalProject, '.claude', 'skills', 'rivet'),
    join(canonicalProject, '.agents', 'skills', 'rivet'),
  ]);
  assert.equal(filesystem.existsSync(join(state.project, '.claude')), false);
  assert.equal(filesystem.existsSync(join(state.project, '.agents')), false);
});

test('minimal install writes only the namespaced skill and manifest to both targets', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);

  assert.equal(await managedInstall(parsed('install', {
    project: state.project,
    target: 'both',
    json: true,
  }), deps), EXIT_CODES.SUCCESS);

  for (const harness of ['.claude', '.agents']) {
    const skillDir = join(state.project, harness, 'skills', 'rivet');
    assert.deepEqual((await readdir(skillDir)).sort(), ['.rivet-install.json', 'SKILL.md']);
    assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_TEXT);
    const manifest = JSON.parse(await readFile(join(skillDir, '.rivet-install.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.package.name, '@agilno/rivet');
    assert.equal(manifest.package.version, '1.2.3');
    assert.deepEqual(manifest.files.map(file => file.path), ['SKILL.md']);
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(deps.capture.stdout.length, 1);
  assert.equal(deps.capture.stdout[0].ok, true);
});

test('global install uses the current Codex .agents path and ignores CODEX_HOME', async t => {
  const state = await fixture(t);
  const codexHome = join(state.root, 'custom codex home');
  const deps = dependencies(state, { env: { CODEX_HOME: codexHome } });

  await managedInstall(parsed('install', { global: true, target: 'both' }), deps);

  assert.equal(filesystem.existsSync(join(state.home, '.claude', 'skills', 'rivet', 'SKILL.md')), true);
  assert.equal(filesystem.existsSync(join(state.home, '.agents', 'skills', 'rivet', 'SKILL.md')), true);
  assert.equal(filesystem.existsSync(codexHome), false);
  assert.equal(filesystem.existsSync(join(state.project, '.claude')), false);
  assert.equal(filesystem.existsSync(join(state.project, '.agents')), false);
});

test('prevalidation rejects an unowned collision before writing another target', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const collision = join(state.project, '.agents', 'skills', 'rivet');
  await mkdir(collision, { recursive: true });
  await writeFile(join(collision, 'SKILL.md'), 'user owned\n');

  assert.throws(
    () => inspectManagedInstall(parsed('install', { project: state.project, target: 'both' }), deps),
    error => error instanceof CliError && error.code === 'REPOSITORY_CONFLICT',
  );
  assert.equal(filesystem.existsSync(join(state.project, '.claude')), false);
});

test('rerun is idempotent and updates only an unmodified managed file', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const request = parsed('install', { project: state.project, target: 'codex' });
  await managedInstall(request, deps);
  const manifestPath = join(state.project, '.agents', 'skills', 'rivet', '.rivet-install.json');
  const firstManifest = await readFile(manifestPath, 'utf8');

  await managedInstall(request, deps);
  assert.equal(await readFile(manifestPath, 'utf8'), firstManifest);

  await writeFile(join(state.packageRoot, 'package.json'), JSON.stringify({
    name: '@agilno/rivet',
    version: '1.2.4',
  }));
  await writeFile(join(state.packageRoot, 'templates', 'harness', 'SKILL.md'), `${SKILL_TEXT}\nUpdated.\n`);
  await managedInstall(request, deps);
  assert.match(await readFile(join(state.project, '.agents', 'skills', 'rivet', 'SKILL.md'), 'utf8'), /Updated/);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).package.version, '1.2.4');
});

test('edited managed files block updates and uninstall without changing user content', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const request = parsed('install', { project: state.project, target: 'claude' });
  await managedInstall(request, deps);
  const skillPath = join(state.project, '.claude', 'skills', 'rivet', 'SKILL.md');
  await writeFile(skillPath, 'user customization\n');

  assert.throws(() => inspectManagedInstall(request, deps), CliError);
  assert.throws(
    () => inspectManagedInstall(parsed('uninstall', { project: state.project, target: 'claude' }), deps),
    CliError,
  );
  assert.equal(await readFile(skillPath, 'utf8'), 'user customization\n');
});

test('uninstall removes owned unmodified files but keeps added user files', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  await managedInstall(parsed('install', { project: state.project, target: 'codex' }), deps);
  const skillDir = join(state.project, '.agents', 'skills', 'rivet');
  await writeFile(join(skillDir, 'notes.md'), 'keep me\n');

  assert.equal(await managedInstall(parsed('uninstall', {
    project: state.project,
    target: 'codex',
  }), deps), EXIT_CODES.SUCCESS);

  assert.deepEqual(await readdir(skillDir), ['notes.md']);
  assert.equal(await readFile(join(skillDir, 'notes.md'), 'utf8'), 'keep me\n');
});

test('install and uninstall commands route minimal mode to the managed lifecycle', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const installRequest = parsed('install', { project: state.project, target: 'codex' });
  assert.equal(await install(installRequest, deps), EXIT_CODES.SUCCESS);
  assert.equal(filesystem.existsSync(join(state.project, '.agents', 'skills', 'rivet', 'SKILL.md')), true);
  assert.equal(await uninstall(parsed('uninstall', {
    project: state.project,
    target: 'codex',
  }), deps), EXIT_CODES.SUCCESS);
  assert.equal(filesystem.existsSync(join(state.project, '.agents', 'skills', 'rivet', 'SKILL.md')), false);
});

test('selected destination symlinks are rejected without touching their targets', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const outside = join(state.root, 'outside');
  const skillLink = join(state.project, '.agents', 'skills', 'rivet');
  await mkdir(outside, { recursive: true });
  await mkdir(join(state.project, '.agents', 'skills'), { recursive: true });
  await symlink(outside, skillLink, 'dir');

  assert.throws(
    () => inspectManagedInstall(parsed('install', { project: state.project, target: 'codex' }), deps),
    error => error instanceof CliError && error.code === 'REPOSITORY_CONFLICT',
  );
  assert.deepEqual(await readdir(outside), []);
});

test('manifests cannot claim paths outside the managed skill directory', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const request = parsed('install', { project: state.project, target: 'codex' });
  await managedInstall(request, deps);
  const manifestPath = join(state.project, '.agents', 'skills', 'rivet', '.rivet-install.json');
  const outside = join(state.project, '.agents', 'skills', 'victim.md');
  await writeFile(outside, 'preserve\n');
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    package: { name: '@agilno/rivet', version: '1.2.3' },
    target: 'codex',
    files: [{ path: '../victim.md', sha256: '0'.repeat(64) }],
  }));

  assert.throws(
    () => inspectManagedInstall(parsed('uninstall', { project: state.project, target: 'codex' }), deps),
    error => error instanceof CliError && error.code === 'REPOSITORY_CONFLICT',
  );
  assert.equal(await readFile(outside, 'utf8'), 'preserve\n');
});

test('an interrupted update is recovered only when the published skill matches the package', async t => {
  const state = await fixture(t);
  const deps = dependencies(state);
  const request = parsed('install', { project: state.project, target: 'codex' });
  await managedInstall(request, deps);
  await writeFile(join(state.packageRoot, 'package.json'), JSON.stringify({
    name: '@agilno/rivet',
    version: '1.2.4',
  }));
  await writeFile(join(state.packageRoot, 'templates', 'harness', 'SKILL.md'), `${SKILL_TEXT}\nUpdated.\n`);

  let interrupted = false;
  const failingFs = new Proxy(filesystem, {
    get(target, property) {
      if (property !== 'renameSync') return Reflect.get(target, property);
      return (from, to) => {
        if (!interrupted && String(to).endsWith('.rivet-install.json')) {
          interrupted = true;
          throw new Error('simulated interruption');
        }
        return target.renameSync(from, to);
      };
    },
  });
  await assert.rejects(() => managedInstall(request, dependencies(state, { fs: failingFs })), /simulated interruption/);

  assert.match(await readFile(join(state.project, '.agents', 'skills', 'rivet', 'SKILL.md'), 'utf8'), /Updated/);
  assert.equal(JSON.parse(await readFile(join(state.project, '.agents', 'skills', 'rivet', '.rivet-install.json'), 'utf8')).package.version, '1.2.3');
  assert.equal(await managedInstall(request, dependencies(state)), EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(await readFile(join(state.project, '.agents', 'skills', 'rivet', '.rivet-install.json'), 'utf8')).package.version, '1.2.4');
});

test('a concurrent in-place edit during update is preserved and stops publication', async t => {
  const state = await fixture(t);
  const request = parsed('install', { project: state.project, target: 'codex' });
  await managedInstall(request, dependencies(state));
  await writeFile(join(state.packageRoot, 'package.json'), JSON.stringify({
    name: '@agilno/rivet',
    version: '1.2.4',
  }));
  await writeFile(join(state.packageRoot, 'templates', 'harness', 'SKILL.md'), `${SKILL_TEXT}\nUpdated.\n`);

  const skillPath = join(state.project, '.agents', 'skills', 'rivet', 'SKILL.md');
  let edited = false;
  const racingFs = new Proxy(filesystem, {
    get(target, property) {
      if (property !== 'fsyncSync') return Reflect.get(target, property);
      return descriptor => {
        target.fsyncSync(descriptor);
        if (!edited) {
          edited = true;
          target.writeFileSync(skillPath, 'concurrent user edit\n');
        }
      };
    },
  });

  await assert.rejects(
    () => managedInstall(request, dependencies(state, { fs: racingFs })),
    error => error instanceof CliError && error.code === 'REPOSITORY_CONFLICT',
  );
  assert.equal(await readFile(skillPath, 'utf8'), 'concurrent user edit\n');
});
