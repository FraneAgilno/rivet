import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { doctor } from '../../src/commands/doctor.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';

const here = dirname(fileURLToPath(import.meta.url));
const validConfig = join(here, '..', 'fixtures', 'config', 'valid');

function capture() {
  const writes = [];
  return {
    output: createOutput({ stdout: { write: v => writes.push(['stdout', v]) }, stderr: { write: v => writes.push(['stderr', v]) } }),
    writes,
  };
}

async function configuredProject({ scripts = { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

test('reports missing configuration with a stable exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  const result = capture();
  assert.equal(await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: {},
    toolDiscovery: async () => ({}),
  }), EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(JSON.parse(result.writes[0][1]).error.code, 'MISSING_CONFIGURATION');
});

test('reports credential names and booleans without credential values', async () => {
  const root = await configuredProject();
  const secret = 'inert-sensitive-credential-value';
  const result = capture();
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: secret, FIGMA_ACCESS_TOKEN: secret, GITHUB_TOKEN: secret },
    toolDiscovery: async () => ({
      node: { present: true, version: '22.1.0', supported: true },
      npm: { present: true, version: '10.1.0', supported: true },
      git: { present: true, version: '2.45.0', supported: true },
    }),
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const serialized = result.writes[0][1];
  assert.doesNotMatch(serialized, new RegExp(secret));
  const payload = JSON.parse(serialized);
  assert.ok(payload.checks.credentials.every(item => item.present === true));
  assert.ok(payload.checks.providers.every(item => item.connectivity === 'not_checked'));
});

test('fails safely for missing credentials', async () => {
  const root = await configuredProject();
  const result = capture();
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: {},
    toolDiscovery: async () => ({ node: { present: true, compatible: true } }),
  });
  assert.equal(exitCode, EXIT_CODES.PROVIDER_UNAVAILABLE);
});

test('maps injected provider probe timeouts and errors without leaking details', async () => {
  const root = await configuredProject();
  for (const probe of [
    async () => ({ status: 'timeout' }),
    async () => { throw new Error('inert-sensitive-upstream-details'); },
  ]) {
    const result = capture();
    const exitCode = await doctor({ flags: { project: root, json: true } }, {
      output: result.output,
      env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
      toolDiscovery: async () => ({}),
      providerProbe: probe,
    });
    assert.equal(exitCode, EXIT_CODES.PROVIDER_UNAVAILABLE);
    assert.doesNotMatch(result.writes[0][1], /upstream-details/);
  }
});

test('bounds an injected provider probe that never settles', async () => {
  const root = await configuredProject();
  const result = capture();
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => ({}),
    providerProbeTimeoutMs: 5,
    providerProbe: async () => new Promise(() => {}),
  });
  assert.equal(exitCode, EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.ok(JSON.parse(result.writes[0][1]).checks.providers.every(item => item.connectivity === 'timeout'));
});

test('fails closed for empty, partial, and indeterminate required tool discovery', async t => {
  const cases = [
    ['empty', {}],
    ['partial', {
      node: { present: true, version: '22.1.0', supported: true },
      npm: { present: true, version: '10.1.0', supported: true },
      git: { present: true, version: '2.45.0' },
    }],
    ['indeterminate', {
      node: { present: true, version: '22.1.0', supported: null },
      npm: { present: true, version: '10.1.0', supported: true },
      git: { present: true, version: '2.45.0', supported: true },
    }],
  ];
  for (const [name, tools] of cases) {
    await t.test(name, async () => {
      const root = await configuredProject();
      const result = capture();
      const exitCode = await doctor({ flags: { project: root, json: true } }, {
        output: result.output,
        env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
        toolDiscovery: async () => tools,
      });
      assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
      const payload = JSON.parse(result.writes[0][1]);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, 'fail');
    });
  }
});

test('fails readiness when configured build and test scripts are not effective', async () => {
  const root = await configuredProject({ scripts: {} });
  const result = capture();
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => ({
      node: { present: true, version: '22.1.0', supported: true },
      npm: { present: true, version: '10.1.0', supported: true },
      git: { present: true, version: '2.45.0', supported: true },
    }),
  });
  assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
  const payload = JSON.parse(result.writes[0][1]);
  assert.equal(payload.checks.commands.ready, false);
  assert.deepEqual(payload.checks.commands.steps.filter(step => step.required).map(step => step.status), [
    'missing-script', 'missing-script', 'missing-script',
  ]);
});

test('uses the runtime executable resolver instead of treating PATH discovery as execution readiness', async () => {
  const root = await configuredProject();
  const result = capture();
  const runners = [];
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => ({
      node: { present: true, version: '22.1.0', supported: true },
      npm: { present: true, version: '10.1.0', supported: true },
      git: { present: true, version: '2.45.0', supported: true },
    }),
    resolveCommandExecutable: async runner => {
      runners.push(runner);
      throw new Error('runtime resolver unavailable');
    },
  });

  assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
  assert.deepEqual(runners, ['npm']);
  const payload = JSON.parse(result.writes[0][1]);
  assert.equal(payload.checks.tools.npm.runtimeResolved, false);
  assert.ok(payload.checks.commands.steps.every(step => step.status === 'tool-unavailable'));
});
