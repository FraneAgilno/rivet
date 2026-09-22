import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_DISCOVERY_ENTRIES,
  MAX_DISCOVERY_MANIFESTS,
  discoverProject,
} from '../../src/discovery/project.js';

async function packageJson(root, relative, value) {
  const directory = join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(value));
}

async function vowlifyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rivet-vowlify-'));
  await packageJson(root, '.', { name: 'vowlify' });
  await packageJson(root, 'backend', {
    name: 'backend',
    scripts: { build: 'nest build', test: 'jest' },
  });
  await packageJson(root, 'frontend', {
    name: 'frontend',
    scripts: { build: 'next build', 'type-check': 'tsc --noEmit' },
  });
  return root;
}

test('discovers the exact Vowlify command groups with provenance and a frontend test warning', async () => {
  const root = await vowlifyFixture();

  const result = await discoverProject(root);

  assert.equal(result.proposal.schemaVersion, 2);
  assert.deepEqual(result.proposal.commands, {
    build: { steps: [
      { cwd: 'backend', argv: ['npm', 'run', 'build'] },
      { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
    ] },
    test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    typecheck: { steps: [{ cwd: 'frontend', argv: ['npm', 'run', 'type-check'] }] },
  });
  assert.equal(result.provenance['commands.build.steps[0]'], 'backend/package.json#scripts.build');
  assert.equal(result.provenance['commands.build.steps[1]'], 'frontend/package.json#scripts.build');
  assert.equal(result.provenance['commands.typecheck.steps[0]'], 'frontend/package.json#scripts.type-check');
  assert.deepEqual(result.warnings, [{
    code: 'package-missing-test',
    package: 'frontend',
    message: "Package 'frontend' has build/typecheck coverage but no test script.",
  }]);
  assert.deepEqual(result.unresolved, []);
});

test('root scripts take precedence per logical command without duplicate child execution', async () => {
  const root = await vowlifyFixture();
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  rootManifest.scripts = { build: 'run all builds' };
  await writeFile(join(root, 'package.json'), JSON.stringify(rootManifest));

  const result = await discoverProject(root);

  assert.deepEqual(result.proposal.commands.build, {
    steps: [{ cwd: '.', argv: ['npm', 'run', 'build'] }],
  });
  assert.deepEqual(result.proposal.commands.test, {
    steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }],
  });
});

test('inherits one root package manager across child steps for npm, pnpm, yarn, and bun', async t => {
  for (const [manager, lockfile] of [
    ['npm', 'package-lock.json'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lockb'],
  ]) {
    await t.test(manager, async () => {
      const root = await vowlifyFixture();
      await writeFile(join(root, lockfile), Buffer.alloc(300_000));
      const result = await discoverProject(root);
      assert.equal(result.proposal.stack.packageManager, manager);
      assert.deepEqual(result.proposal.commands.build.steps.map(step => step.argv[0]), [manager, manager]);
    });
  }
});

test('reports conflicting package-manager evidence instead of silently selecting one', async () => {
  const root = await vowlifyFixture();
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await writeFile(join(root, 'frontend', 'yarn.lock'), '# yarn');

  await assert.rejects(() => discoverProject(root), error => (
    error.code === 'PACKAGE_MANAGER_CONFLICT'
    && error.details.managers.join(',') === 'pnpm,yarn'
  ));
});

test('never follows child symlinks and ignores hidden, dependency, and generated directories', async () => {
  const root = await vowlifyFixture();
  const external = await mkdtemp(join(tmpdir(), 'rivet-external-package-'));
  await packageJson(external, '.', { scripts: { build: 'external' } });
  await symlink(external, join(root, 'linked'), 'dir');
  for (const directory of ['.hidden', '.git', 'node_modules', 'dist', 'build', 'coverage', '.next']) {
    await packageJson(root, directory, { scripts: { build: 'ignored' } });
  }

  const result = await discoverProject(root);

  assert.deepEqual(result.proposal.commands.build.steps.map(step => step.cwd), ['backend', 'frontend']);
  assert.ok(!result.inspectedFiles.some(path => path.startsWith('linked/')));
});

test('enforces explicit immediate-entry and manifest-count discovery limits', async t => {
  await t.test('entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-entry-limit-'));
    await packageJson(root, '.', { name: 'bounded', scripts: { build: 'x', test: 'x' } });
    for (let index = 0; index < MAX_DISCOVERY_ENTRIES; index += 1) {
      await mkdir(join(root, `empty-${String(index).padStart(3, '0')}`));
    }
    await assert.rejects(() => discoverProject(root), /entry limit/i);
  });
  await t.test('manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-manifest-limit-'));
    await packageJson(root, '.', { name: 'bounded' });
    for (let index = 0; index < MAX_DISCOVERY_MANIFESTS; index += 1) {
      await packageJson(root, `package-${String(index).padStart(3, '0')}`, { name: `package-${index}` });
    }
    await assert.rejects(() => discoverProject(root), /manifest limit/i);
  });
});

test('enforces the aggregate manifest read limit independently of per-file limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-aggregate-limit-'));
  await packageJson(root, '.', { name: 'bounded' });
  for (let index = 0; index < 9; index += 1) {
    await packageJson(root, `package-${index}`, { name: `package-${index}`, padding: 'x'.repeat(240_000) });
  }
  await assert.rejects(() => discoverProject(root), /aggregate read limit/i);
});
