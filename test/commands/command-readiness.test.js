import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectCommandReadiness } from '../../src/config/command-readiness.js';

const tools = {
  npm: { present: true, version: '10.0.0', supported: true },
};

function config(commands) {
  return {
    project: { schemaVersion: 2, stack: { packageManager: 'npm' }, commands },
    quality: { commandGates: [
      { id: 'build', command: 'build', required: true },
      { id: 'test', command: 'test', required: true },
    ] },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rivet-command-readiness-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  await mkdir(join(root, 'backend'));
  await mkdir(join(root, 'frontend'));
  await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'x' } }));
  await writeFile(join(root, 'frontend', 'package.json'), JSON.stringify({ scripts: { build: 'x', 'type-check': 'x' } }));
  return root;
}

test('verifies every exact bounded child script without executing it', async () => {
  const root = await fixture();
  const value = config({
    build: { steps: [
      { cwd: 'backend', argv: ['npm', 'run', 'build'] },
      { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
    ] },
    test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
  });

  const result = inspectCommandReadiness(root, value, { fs: nodeFs, tools });

  assert.equal(result.ready, true);
  assert.deepEqual(result.steps.map(step => [step.id, step.cwd, step.script, step.status]), [
    ['build-1', 'backend', 'build', 'ready'],
    ['build-2', 'frontend', 'build', 'ready'],
    ['test', 'backend', 'test', 'ready'],
  ]);
});

test('reports absent effective scripts and package-manager mismatches as unavailable', async () => {
  const root = await fixture();
  const value = config({
    build: { steps: [{ cwd: 'frontend', argv: ['npm', 'run', 'build'] }] },
    test: { steps: [{ cwd: 'frontend', argv: ['npm', 'run', 'test'] }] },
  });

  const absent = inspectCommandReadiness(root, value, { fs: nodeFs, tools });
  assert.equal(absent.ready, false);
  assert.deepEqual(absent.steps.map(step => step.status), ['ready', 'missing-script']);

  value.project.commands.test.steps[0].argv[0] = 'yarn';
  const mismatch = inspectCommandReadiness(root, value, { fs: nodeFs, tools });
  assert.equal(mismatch.steps[1].status, 'manager-mismatch');
});

test('rejects configured symlink ancestors and directory identity changes', async t => {
  await t.test('symlink ancestor', async () => {
    const root = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'rivet-command-external-'));
    await writeFile(join(external, 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'x' } }));
    await symlink(external, join(root, 'linked'), 'dir');
    const value = config({
      build: { steps: [{ cwd: 'linked', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    });
    const result = inspectCommandReadiness(root, value, { fs: nodeFs, tools });
    assert.equal(result.steps[0].status, 'unsafe-directory');
  });

  await t.test('identity change', async () => {
    const root = await fixture();
    const value = config({
      build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    });
    let checks = 0;
    const fs = {
      ...nodeFs,
      statSync(path, options) {
        const metadata = nodeFs.statSync(path, options);
        if (path.endsWith('/backend') && ++checks >= 1) {
          return new Proxy(metadata, { get(target, property) {
            if (property === 'ino') return target.ino + 1;
            const child = Reflect.get(target, property, target);
            return typeof child === 'function' ? child.bind(target) : child;
          } });
        }
        return metadata;
      },
    };
    const result = inspectCommandReadiness(root, value, { fs, tools });
    assert.equal(result.steps[0].status, 'directory-identity-changed');
  });

  await t.test('identity change before manifest read', async () => {
    const root = await fixture();
    const value = config({
      build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    });
    let checks = 0;
    const fs = {
      ...nodeFs,
      lstatSync(path, options) {
        const metadata = nodeFs.lstatSync(path, options);
        if (path.endsWith('/backend') && ++checks > 2) {
          return new Proxy(metadata, { get(target, property) {
            if (property === 'ino') return target.ino + 1;
            const child = Reflect.get(target, property, target);
            return typeof child === 'function' ? child.bind(target) : child;
          } });
        }
        return metadata;
      },
    };

    const result = inspectCommandReadiness(root, value, { fs, tools });

    assert.equal(result.steps[0].status, 'directory-identity-changed');
  });

  await t.test('identity change after manifest read', async () => {
    const root = await fixture();
    const value = config({
      build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    });
    let checks = 0;
    const fs = {
      ...nodeFs,
      lstatSync(path, options) {
        const metadata = nodeFs.lstatSync(path, options);
        if (path.endsWith('/backend') && ++checks > 3) {
          return new Proxy(metadata, { get(target, property) {
            if (property === 'ino') return target.ino + 1;
            const child = Reflect.get(target, property, target);
            return typeof child === 'function' ? child.bind(target) : child;
          } });
        }
        return metadata;
      },
    };

    const result = inspectCommandReadiness(root, value, { fs, tools });

    assert.equal(result.steps[0].status, 'directory-identity-changed');
  });
});
