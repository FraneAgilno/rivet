import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { preflight } from '../../src/commands/preflight.js';
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

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'agilno-preflight-'));
  await cp(join(validConfig, '.rivet'), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  return root;
}

const readyGit = {
  repository: true,
  dirty: false,
  detached: false,
  defaultBranch: 'main',
  baseFreshness: 'fresh',
  occupiedCandidatePaths: [],
  worktreeCheck: { checked: true },
};

const readyTools = {
  node: { present: true, version: '22.1.0', supported: true, compatible: true },
  npm: { present: true, version: '10.1.0', supported: true, compatible: true },
  git: { present: true, version: '2.45.0', supported: true, compatible: true },
};

test('passes when doctor, git, runtime, private state, and quality commands are ready', async () => {
  const root = await project();
  const result = capture();
  const exitCode = await preflight({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => readyTools,
    gitDiscovery: async () => readyGit,
    goalStateReader: async () => ({ status: 'ready' }),
    runtimeCapacity: { available: 4, required: 3 },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(result.writes[0][1]).status, 'pass');
});

test('fails required quality-command readiness when the configured script is absent', async () => {
  const root = await project();
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  const result = capture();
  const exitCode = await preflight({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => readyTools,
    gitDiscovery: async () => readyGit,
    goalStateReader: async () => ({ status: 'ready' }),
    runtimeCapacity: { available: 4, required: 3 },
  });
  assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
  const quality = JSON.parse(result.writes[0][1]).checks.find(item => item.id === 'quality-commands');
  assert.equal(quality.status, 'fail');
  assert.ok(quality.commands.some(step => step.logicalId === 'test' && step.status === 'missing-script'));
});

test('reports runtime resolver failures in the quality-command readiness check', async () => {
  const root = await project();
  const result = capture();
  const exitCode = await preflight({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => readyTools,
    resolveCommandExecutable: async () => { throw new Error('runtime resolver unavailable'); },
    gitDiscovery: async () => readyGit,
    goalStateReader: async () => ({ status: 'ready' }),
    runtimeCapacity: { available: 4, required: 3 },
  });

  assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
  const quality = JSON.parse(result.writes[0][1]).checks.find(item => item.id === 'quality-commands');
  assert.equal(quality.status, 'fail');
  assert.ok(quality.commands.every(step => step.status === 'tool-unavailable'));
});

test('reports ineligible resolved executables in preflight quality readiness', async t => {
  for (const kind of ['directory', 'non-executable-file']) {
    await t.test(kind, async () => {
      const root = await project();
      const candidate = kind === 'directory' ? root : join(root, 'package.json');
      const result = capture();
      const exitCode = await preflight({ flags: { project: root, json: true } }, {
        output: result.output,
        env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
        toolDiscovery: async () => readyTools,
        resolveCommandExecutable: async () => candidate,
        gitDiscovery: async () => readyGit,
        goalStateReader: async () => ({ status: 'ready' }),
        runtimeCapacity: { available: 4, required: 3 },
      });

      assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
      const quality = JSON.parse(result.writes[0][1]).checks.find(item => item.id === 'quality-commands');
      assert.equal(quality.status, 'fail');
      assert.ok(quality.commands.every(step => step.status === 'tool-unavailable'));
    });
  }
});

test('fails closed for dirty, detached, stale, occupied, insufficient runtime, and missing commands', async t => {
  const cases = [
    ['dirty worktree', { git: { ...readyGit, dirty: true } }],
    ['detached HEAD', { git: { ...readyGit, detached: true } }],
    ['stale base', { git: { ...readyGit, baseFreshness: 'behind' } }],
    ['occupied path', { git: { ...readyGit, occupiedCandidatePaths: ['/redacted/candidate'] } }],
    ['worktree discovery failure', { git: { ...readyGit, worktreeCheck: { checked: false, error: 'timeout' } } }],
    ['insufficient runtime', { runtimeCapacity: { available: 1, required: 3 } }],
    ['missing command', { tools: { ...readyTools, npm: { present: false, supported: false, compatible: false } } }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const root = await project();
      const result = capture();
      const exitCode = await preflight({ flags: { project: root, json: true } }, {
        output: result.output,
        env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
        toolDiscovery: async () => override.tools ?? readyTools,
        gitDiscovery: async () => override.git ?? readyGit,
        goalStateReader: async () => ({ status: 'ready' }),
        runtimeCapacity: override.runtimeCapacity ?? { available: 4, required: 3 },
      });
      assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
      assert.equal(JSON.parse(result.writes[0][1]).status, 'fail');
    });
  }
});

test('reports not-initialized private goal state honestly without writing', async () => {
  const root = await project();
  const result = capture();
  const exitCode = await preflight({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => readyTools,
    gitDiscovery: async () => readyGit,
    goalStateReader: async () => ({ status: 'not_initialized' }),
    runtimeCapacity: { available: 4, required: 3 },
  });
  assert.equal(exitCode, EXIT_CODES.FAILED_GATE);
  assert.ok(JSON.parse(result.writes[0][1]).remediations.length > 0);
});

test('distinguishes an internal discovery failure from missing configuration without leaking details', async () => {
  const root = await project();
  const result = capture();
  const exitCode = await preflight({ flags: { project: root, json: true } }, {
    output: result.output,
    env: { ATLASSIAN_API_TOKEN: 'present', FIGMA_ACCESS_TOKEN: 'present', GITHUB_TOKEN: 'present' },
    toolDiscovery: async () => { throw new Error('inert-sensitive-internal-details'); },
    gitDiscovery: async () => readyGit,
  });
  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.doesNotMatch(result.writes[0][1], /internal-details/);
  assert.equal(JSON.parse(result.writes[0][1]).error.code, 'INTERNAL_ERROR');
});
