import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
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
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
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
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
  const result = capture();
  const exitCode = await doctor({ flags: { project: root, json: true } }, {
    output: result.output,
    env: {},
    toolDiscovery: async () => ({ node: { present: true, compatible: true } }),
  });
  assert.equal(exitCode, EXIT_CODES.PROVIDER_UNAVAILABLE);
});

test('maps injected provider probe timeouts and errors without leaking details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
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
  const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
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
      const root = await mkdtemp(join(tmpdir(), 'agilno-doctor-'));
      await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
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
