import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { CONFIG_DIRECTORY } from '../../src/config/defaults.js';
import { resolveStatePaths, resolveFeatureRunPaths } from '../../src/state/paths.js';
import { runCli } from '../helpers/run-cli.js';

test('Rivet owns its package, executable and project configuration', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@agilno/rivet');
  assert.deepEqual(Object.keys(pkg.bin), ['rivet']);
  assert.equal(pkg.private, true, 'unpublished namespace must not be published accidentally');
  assert.equal(CONFIG_DIRECTORY, '.rivet');
  assert.equal(Object.values(pkg.dependencies).some(version => /^(?:file:|link:|workspace:)/.test(version)), false);
});

test('CLI help identifies the Rivet command', async () => {
  const result = (await runCli(['--help'])).assertSuccess();
  assert.match(result.stdout, /rivet install/);
  assert.match(result.stdout, /^Usage:\n\s+rivet /);
});

test('private run state uses independent Rivet directories', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-identity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  const orchestration = await resolveStatePaths(root, 'example');
  const feature = await resolveFeatureRunPaths(root, 'example');
  assert.equal(orchestration.stateRoot, join(root, '.git', 'rivet'));
  assert.equal(feature.featureRoot, join(root, '.git', 'rivet'));
});

test('install and uninstall preserve a same-named skill owned by another framework', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-coexistence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"private":true}');
  const original = join(root, '.claude', 'skills', 'design', 'SKILL.md');
  await mkdir(join(root, '.claude', 'skills', 'design'), { recursive: true });
  await writeFile(original, 'existing project skill');
  (await runCli(['install', '--all', '--target=claude'], { cwd: root })).assertSuccess();
  assert.equal(await readFile(original, 'utf8'), 'existing project skill');
  assert.match(await readFile(join(root, '.claude', 'skills', 'rivet-design', 'SKILL.md'), 'utf8'), /name: rivet-design/);
  (await runCli(['uninstall', '--all', '--target=claude'], { cwd: root })).assertSuccess();
  assert.equal(await readFile(original, 'utf8'), 'existing project skill');
});
