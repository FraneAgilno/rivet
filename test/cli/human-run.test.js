import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-human-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q']);
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  const nested = join(root, 'src');
  await mkdir(nested);
  return { root, nested };
}

function services(root, { selected = ['codex'], approve = true, status = 'awaiting-final-approval' } = {}) {
  const messages = [];
  const calls = [];
  const proposal = {
    runId: 'user-request-abc123', version: 3, status: 'proposed', proposalDigest: 'a'.repeat(64),
    workRequest: { acceptanceCriteria: ['Add a greeting module'], contextRefs: [] },
    featurePlan: {
      baselineCommit: 'b'.repeat(40),
      nodes: [
        { id: 'worker', role: 'worker', objective: 'Create greeting module', ownedPaths: ['src/greeting.js'], dependencies: [], budget: { timeMinutes: 10 } },
        { id: 'final-delivery', role: 'boss', objective: 'Review delivery', ownedPaths: [], dependencies: ['worker'], approvalGate: 'final-delivery' },
      ],
    },
  };
  return {
    messages, calls,
    overrides: {
      cwd: () => root,
      terminalIsInteractive: () => true,
      output: { log: message => messages.push(message), error: message => messages.push(message), json() {} },
      harnesses: {
        async discover() { return selected.map(kind => ({ kind, executable: `/opt/${kind}`, version: 'compatible' })); },
        async select(kind) { calls.push(['select', kind]); return { kind, executable: `/opt/${kind}`, version: 'compatible' }; },
      },
      confirmFeatureActivation: async () => {
        if (approve === 'eof') throw new Error('input closed');
        return approve;
      },
      confirmDependencyInstall: async () => true,
      feature: {
        async propose(input) { calls.push(['propose', input]); return proposal; },
        async start(input) { calls.push(['start', input]); return { version: 4 }; },
        async watch(input, options) {
          calls.push(['watch', input]);
          if (options?.confirmDependencyInstall) {
            const approved = await options.confirmDependencyInstall({
              executable: '/opt/npm', args: ['ci'], worktreePath: '/tmp/rivet-worker',
            });
            calls.push(['dependency approval', approved]);
          }
          return { status, summary: 'Checks completed.' };
        },
        async status() { throw new Error('unexpected status'); },
      },
    },
  };
}

test('one terminal command from a nested project folder keeps IDs and revisions internal', async t => {
  const { root, nested } = await fixture(t);
  const s = services(nested);
  const code = await main(['run', 'Add a greeting module'], s.overrides);
  assert.equal(code, EXIT_CODES.SUCCESS);
  assert.equal(s.calls[1][0], 'propose');
  assert.equal(s.calls[1][1].project, root);
  assert.match(s.calls[1][1].source.value, /## Acceptance Criteria\n- Add a greeting module/);
  assert.deepEqual(s.calls[2][1], {
    project: root, runId: 'user-request-abc123', expectedVersion: 3, proposalDigest: 'a'.repeat(64),
  });
  assert.deepEqual(s.calls[4], ['dependency approval', true]);
  assert.match(s.messages.join('\n'), /Install locked dependencies in \/tmp\/rivet-worker/);
  const shown = s.messages.join('\n');
  assert.match(shown, /Project: .*rivet-human-run-/);
  assert.match(shown, /path: src\/greeting\.js/);
  assert.match(shown, /Required checks:/);
  assert.doesNotMatch(shown, /user-request-abc123|a{64}/);
});

test('decline and noninteractive terminal cannot activate', async t => {
  const { root } = await fixture(t);
  const declined = services(root, { approve: false });
  assert.equal(await main(['run', 'Add a greeting module'], declined.overrides), EXIT_CODES.SUCCESS);
  assert.equal(declined.calls.some(item => item[0] === 'start'), false);
  const noninteractive = services(root);
  noninteractive.overrides.terminalIsInteractive = () => false;
  assert.equal(await main(['run', 'Add a greeting module'], noninteractive.overrides), EXIT_CODES.INVALID_INPUT);
  assert.equal(noninteractive.calls.length, 0);
  const eof = services(root, { approve: 'eof' });
  assert.equal(await main(['run', 'Add a greeting module'], eof.overrides), EXIT_CODES.SUCCESS);
  assert.equal(eof.calls.some(item => item[0] === 'start'), false);
});

test('two eligible harnesses require an explicit choice and blocked work exits nonzero', async t => {
  const { root } = await fixture(t);
  const ambiguous = services(root, { selected: ['claude', 'codex'] });
  assert.equal(await main(['run', 'Add a greeting module'], ambiguous.overrides), EXIT_CODES.INVALID_INPUT);
  assert.equal(ambiguous.calls.length, 0);
  const chosen = services(root, { selected: ['claude', 'codex'], status: 'blocked' });
  assert.equal(await main(['run', 'Add a greeting module', '--harness=codex'], chosen.overrides), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(chosen.calls[0], ['select', 'codex']);
  const unavailable = services(root, { selected: [] });
  assert.equal(await main(['run', 'Add a greeting module'], unavailable.overrides), EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(unavailable.calls.length, 0);
});

test('multiline quoted task survives normalization and review without invented criteria', async t => {
  const { root } = await fixture(t);
  const s = services(root, { approve: false });
  const task = 'Add `greet(name)` to src/greeting.js.\nReturn "Hello, Ada!" for Ada.';
  assert.equal(await main(['run', task], s.overrides), EXIT_CODES.SUCCESS);
  const sent = s.calls.find(item => item[0] === 'propose')[1].source.value;
  assert.ok(sent.includes(task));
  assert.match(sent, /- Add `greet\(name\)` to src\/greeting\.js\. Return "Hello, Ada!" for Ada\./);
  assert.ok(s.messages.join('\n').includes(task));
});

test('a plan output failure before approval cannot start execution', async t => {
  const { root } = await fixture(t);
  const s = services(root);
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const errors = [];
  stdout.write = () => true;
  stderr.write = value => { errors.push(value); return true; };
  s.overrides.output = createOutput({ stdout, stderr });
  s.overrides.confirmFeatureActivation = async () => {
    stdout.emit('error', new Error('broken stream'));
    return true;
  };
  assert.equal(await main(['run', 'Add a greeting module'], s.overrides), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(s.calls.some(item => item[0] === 'start'), false);
  assert.match(errors.join(''), /Plan output failed before approval/);
});

test('incompatible installed harness explains capability failures without planning', async t => {
  const { root } = await fixture(t);
  const s = services(root, { selected: [] });
  s.overrides.harnesses.discover = async () => [
    { kind: 'claude', available: false, reason: 'missing-options: --sandbox' },
    { kind: 'codex', available: false, reason: 'missing-options: --sandbox' },
  ];
  assert.equal(await main(['run', 'Add a greeting module'], s.overrides), EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(s.calls.length, 0);
  assert.match(s.messages.join('\n'), /missing-options: --sandbox/);
  assert.match(s.messages.join('\n'), /codex exec --help/);
  assert.match(s.messages.join('\n'), /Rivet skill in your coding harness/);
});

test('script adapters require an explicit interpreter before planning', async t => {
  const { root } = await fixture(t);
  const s = services(root, { selected: [] });
  s.overrides.harnesses.discover = async () => [
    { kind: 'codex', available: false, reason: 'interpreter-required' },
  ];
  assert.equal(await main(['run', 'Add a greeting', '--harness=codex'], s.overrides), EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.match(s.messages.join('\n'), /RIVET_CODEX_INTERPRETER/);
  assert.equal(s.calls.length, 0);
});

test('terminal signal listeners are removed after repeated declined tasks', async t => {
  const { root } = await fixture(t);
  const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  for (let index = 0; index < 2; index += 1) {
    const s = services(root, { approve: false });
    assert.equal(await main(['run', 'Add a greeting'], s.overrides), EXIT_CODES.SUCCESS);
  }
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), before);
});


test('role delegation explicitly selects either harness and preserves the task approval boundary', async t => {
  for (const kind of ['claude', 'codex']) {
    for (const drift of [false, true]) {
      const { root } = await fixture(t);
      const s = services(root, { selected: ['claude', 'codex'] });
      const path = join(root, 'roles.json');
      const config = { schemaVersion: 1, profiles: {}, roles: { implementation: { kind: 'harness', harness: kind } } };
      await writeFile(path, JSON.stringify(config));
      s.overrides.confirmFeatureActivation = async () => {
        if (drift) await writeFile(path, JSON.stringify({ ...config, roles: {} }));
        return true;
      };
      await main(['models', 'delegate', 'Add a greeting module', '--roles=roles.json', '--role=implementation'], s.overrides);
      assert.deepEqual(s.calls[0], ['select', kind]);
      assert.equal(s.calls.find(item => item[0] === 'propose')[1].client, kind);
      assert.equal(s.calls.some(item => item[0] === 'start'), !drift);
      assert.equal(s.calls.some(item => item[0] === 'watch'), !drift);
      assert.match(s.messages.join('\n'), /Role implementation: harness/);
    }
  }
});
