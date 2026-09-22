import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadProjectConfig } from '../../src/config/load.js';
import { compileProjectCommands, compileQualitySteps } from '../../src/config/commands.js';
import { ConfigurationError, validateProjectConfiguration } from '../../src/config/validate.js';

const VALID_CONFIG = fileURLToPath(new URL('../fixtures/config/valid/', import.meta.url));

async function config() {
  return structuredClone(await loadProjectConfig(VALID_CONFIG));
}

test('normalizes schema-version-1 commands to one immutable root step without changing execution identity', async () => {
  const value = await config();

  const commands = compileProjectCommands(value.project);

  assert.deepEqual(commands.build, {
    logicalId: 'build',
    steps: [{ id: 'build', cwd: '.', argv: ['npm', 'run', 'build'] }],
  });
  assert.ok(Object.isFrozen(commands));
  assert.ok(Object.isFrozen(commands.build.steps[0].argv));
});

test('accepts ordered schema-version-2 command groups and the type-check alias', async () => {
  const value = await config();
  value.project.schemaVersion = 2;
  value.project.commands = {
    build: { steps: [
      { cwd: 'backend', argv: ['npm', 'run', 'build'] },
      { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
    ] },
    test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    lint: { steps: [{ cwd: '.', argv: ['npm', 'run', 'lint'] }] },
    typecheck: { steps: [{ cwd: 'frontend', argv: ['npm', 'run', 'type-check'] }] },
  };
  value.quality.commandGates.push({ id: 'typecheck', command: 'typecheck', required: false });

  assert.equal(validateProjectConfiguration(value), true);
  assert.deepEqual(compileProjectCommands(value.project).build.steps, [
    { id: 'build-1', cwd: 'backend', argv: ['npm', 'run', 'build'] },
    { id: 'build-2', cwd: 'frontend', argv: ['npm', 'run', 'build'] },
  ]);
});

test('rejects malformed, empty, excessive, duplicate, and unsafe structured command steps', async t => {
  const cases = [
    ['empty', []],
    ['duplicate', [
      { cwd: 'backend', argv: ['npm', 'run', 'build'] },
      { cwd: 'backend', argv: ['npm', 'run', 'build'] },
    ]],
    ['traversal', [{ cwd: '../backend', argv: ['npm', 'run', 'build'] }]],
    ['absolute', [{ cwd: '/backend', argv: ['npm', 'run', 'build'] }]],
    ['option-like', [{ cwd: '-frontend', argv: ['npm', 'run', 'build'] }]],
    ['wrong script', [{ cwd: 'backend', argv: ['npm', 'run', 'compile'] }]],
    ['too many', Array.from({ length: 33 }, (_, index) => ({
      cwd: `package-${index}`, argv: ['npm', 'run', 'build'],
    }))],
  ];
  for (const [name, steps] of cases) {
    await t.test(name, async () => {
      const value = await config();
      value.project.schemaVersion = 2;
      value.project.commands = {
        build: { steps },
        test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
      };
      value.quality.commandGates = [
        { id: 'build', command: 'build', required: true },
        { id: 'test', command: 'test', required: true },
      ];
      assert.throws(() => validateProjectConfiguration(value), ConfigurationError);
    });
  }
});

test('rejects unknown schema versions and keeps version-1 arrays explicit', async () => {
  const future = await config();
  future.project.schemaVersion = 3;
  assert.throws(() => validateProjectConfiguration(future), ConfigurationError);

  const mixed = await config();
  mixed.project.commands.build = { steps: [{ cwd: '.', argv: ['npm', 'run', 'build'] }] };
  assert.throws(() => validateProjectConfiguration(mixed), ConfigurationError);

  const aliased = await config();
  aliased.project.commands.typecheck = ['npm', 'run', 'type-check'];
  assert.throws(() => validateProjectConfiguration(aliased), ConfigurationError);

  const mismatchedManager = await config();
  mismatchedManager.project.commands.build = ['yarn', 'run', 'build'];
  assert.throws(() => validateProjectConfiguration(mismatchedManager), ConfigurationError);
});

test('rejects colliding and excessive expanded quality gate identities', async t => {
  await t.test('expanded ID collision', async () => {
    const value = await config();
    value.project.schemaVersion = 2;
    value.project.commands = {
      build: { steps: [
        { cwd: 'backend', argv: ['npm', 'run', 'build'] },
        { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
      ] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    };
    value.quality.commandGates = [
      { id: 'verify', command: 'build', required: true },
      { id: 'verify-1', command: 'test', required: true },
    ];

    assert.throws(() => compileQualitySteps(value), /invalid/i);
    assert.throws(() => validateProjectConfiguration(value), ConfigurationError);
  });

  await t.test('aggregate step ceiling', async () => {
    const value = await config();
    const steps = logicalId => Array.from({ length: 32 }, (_, index) => ({
      cwd: `package-${index + 1}`,
      argv: ['npm', 'run', logicalId],
    }));
    value.project.schemaVersion = 2;
    value.project.commands = {
      build: { steps: steps('build') },
      test: { steps: steps('test') },
      lint: { steps: [{ cwd: '.', argv: ['npm', 'run', 'lint'] }] },
    };
    value.quality.commandGates = [
      { id: 'build', command: 'build', required: true },
      { id: 'test', command: 'test', required: true },
      { id: 'lint', command: 'lint', required: false },
    ];

    assert.throws(() => compileQualitySteps(value), /invalid/i);
    assert.throws(() => validateProjectConfiguration(value), ConfigurationError);
  });
});
