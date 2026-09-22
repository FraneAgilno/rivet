import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  ApplicationConfigurationError,
  createRivetApplication,
} from '../../src/runtime/application.js';

const execFile = promisify(execFileCallback);
const HERE = dirname(fileURLToPath(import.meta.url));
const VALID_CONFIG = join(HERE, '..', 'fixtures', 'config', 'valid', '.rivet');

async function planningRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-live-planning-')));
  await cp(VALID_CONFIG, join(root, '.rivet'), { recursive: true });
  await mkdir(join(root, 'requests'));
  await writeFile(join(root, 'requests', 'feature.md'), '# Feature\n\n## Acceptance Criteria\n\n- Works safely.\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

test('constructs one inert narrow application surface without retained-action capabilities', () => {
  let effects = 0;
  const application = createRivetApplication({
    cwd: () => '/project',
    env: {},
    fs: Object.freeze({}),
    fetch: async () => { effects += 1; },
    spawn: () => { effects += 1; },
    now: () => '2029-01-01T00:00:00.000Z',
  });

  assert.equal(effects, 0);
  assert.deepEqual(Object.keys(application).sort(), ['cwd', 'env', 'feature', 'fetch', 'fs']);
  assert.deepEqual(Object.keys(application.feature).sort(), [
    'buildLaunchContract', 'cancel', 'collectEvidence', 'createAgentClient', 'createOrchestrator',
    'openRun', 'prepareWorktree', 'propose', 'resume', 'runQualityGates',
    'start', 'status', 'watch',
  ]);
  for (const retained of ['push', 'merge', 'mergeDefault', 'deploy', 'providerWrite', 'trackerWrite']) {
    assert.equal(Object.hasOwn(application.feature, retained), false);
  }
  assert.equal(Object.isFrozen(application), true);
  assert.equal(Object.isFrozen(application.feature), true);
});

test('constructs only pinned Claude or Codex clients and fails closed when executable configuration is absent', () => {
  const application = createRivetApplication({
    cwd: () => '/project',
    env: {
      RIVET_CLAUDE_EXECUTABLE: '/opt/agilno/bin/claude',
      RIVET_CODEX_EXECUTABLE: '/opt/agilno/bin/codex',
    },
    fs: Object.freeze({}), fetch: async () => {}, spawn: () => {}, now: () => '2029-01-01T00:00:00.000Z',
  });

  assert.equal(application.feature.createAgentClient('claude').provider, 'claude');
  assert.equal(application.feature.createAgentClient('codex').provider, 'codex');
  assert.throws(() => application.feature.createAgentClient('other'), ApplicationConfigurationError);
  assert.throws(
    () => createRivetApplication({ cwd: () => '/project', env: {}, fs: {}, fetch: async () => {}, spawn: () => {}, now: () => '2029-01-01T00:00:00.000Z' })
      .feature.createAgentClient('claude'),
    ApplicationConfigurationError,
  );
});

test('opens a private run beneath Git identity without constructing worker or external effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-application-'));
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile('git', ['init', '--quiet', root], error => error ? reject(error) : resolve()));
  let effects = 0;
  const application = createRivetApplication({
    cwd: () => root, env: {}, fs: {}, fetch: async () => { effects += 1; },
    spawn: () => { effects += 1; }, now: () => '2029-01-01T00:00:00.000Z',
  });

  const opened = await application.feature.openRun(root, 'run-application');
  assert.equal(opened.paths.runId, 'run-application');
  assert.equal(await opened.store.read(), null);
  assert.equal(effects, 0);
  assert.equal(Object.isFrozen(opened), true);
});

test('exposes one injected high-level feature workflow through the same application service', async () => {
  const calls = [];
  const featureWorkflow = Object.freeze(Object.fromEntries(
    ['propose', 'start', 'watch', 'status', 'resume', 'cancel'].map(method => [method, async input => {
      calls.push({ method, input });
      return { method };
    }]),
  ));
  const application = createRivetApplication({
    cwd: () => '/project', env: {}, fs: {}, fetch: async () => {}, spawn: () => {},
    now: () => '2029-01-01T00:00:00.000Z', featureWorkflow,
  });

  assert.deepEqual(await application.feature.propose({ source: 'fixture' }), { method: 'propose' });
  assert.deepEqual(calls, [{ method: 'propose', input: { source: 'fixture' } }]);
  for (const method of ['propose', 'start', 'watch', 'status', 'resume', 'cancel']) {
    assert.equal(application.feature[method], featureWorkflow[method]);
  }
});

test('default workflow reaches only the selected live planning adapter without creating proposal state', async () => {
  for (const kind of ['claude', 'codex']) {
    const root = await planningRepository();
    const environment = kind === 'claude'
      ? { RIVET_CLAUDE_EXECUTABLE: '/definitely/missing/claude' }
      : { RIVET_CODEX_EXECUTABLE: '/definitely/missing/codex' };
    const application = createRivetApplication({
      cwd: () => root,
      env: environment,
      fs: {},
      fetch: async () => {},
      spawn: () => {},
      now: () => '2029-01-01T00:00:00.000Z',
    });
    await assert.rejects(
      () => application.feature.propose({
        project: root,
        source: { kind: 'file', value: join(root, 'requests', 'feature.md') },
        client: kind,
      }),
      error => error.code === 'ERR_AGENT_PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(() => import('node:fs/promises').then(({ lstat }) => lstat(join(root, '.git', 'rivet'))));
  }
});
