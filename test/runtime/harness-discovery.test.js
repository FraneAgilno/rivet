import { CLAUDE_ADAPTER_SYNTAX } from '../../src/clients/claude.js';
import { CODEX_ADAPTER_SYNTAX } from '../../src/clients/codex.js';
const help = kind => (kind === 'claude' ? CLAUDE_ADAPTER_SYNTAX : CODEX_ADAPTER_SYNTAX).requiredOptions.map(x => '  ' + x + ' <value>').join('\n');
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverHarnesses } from '../../src/runtime/harness-discovery.js';

test('discovers an unfamiliar capability-compatible adapter outside the project', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-harness-discovery-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'project');
  const globalBin = join(parent, 'bin');
  await mkdir(projectRoot);
  await mkdir(globalBin);
  const codex = join(globalBin, 'codex');
  const claude = join(projectRoot, 'claude');
  await writeFile(codex, '#!/usr/bin/env node\nprocess.exit(0);\n');
  await writeFile(claude, '#!/bin/sh\nexit 0\n');
  await chmod(codex, 0o700);
  await chmod(claude, 0o700);
  const called = [];
  const detected = await discoverHarnesses({
    env: { PATH: `${globalBin}:${projectRoot}`, RIVET_CODEX_INTERPRETER: await realpath(process.execPath) }, projectRoot,
    runner: async (command, args) => {
      called.push([command, args]);
      return { code: 0, stdout: args.includes('--help') ? help('codex') : 'codex-cli 99.0.0\n', stderr: '', truncated: { stdout: false, stderr: false } };
    },
  });
  assert.equal(detected.find(item => item.kind === 'codex').executable, codex);
  assert.deepEqual(detected.find(item => item.kind === 'claude'), { kind: 'claude', available: false, reason: 'not-installed' });
  assert.deepEqual(called.map(item => item[0]), [await realpath(process.execPath), await realpath(process.execPath)]);
});

test('discovers tested Claude and Codex releases by their advertised capabilities', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-harness-versions-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const claude = join(parent, 'claude');
  const codex = join(parent, 'codex');
  await writeFile(claude, '#!/usr/bin/env node\n');
  await writeFile(codex, '#!/usr/bin/env node\n');
  await chmod(claude, 0o700);
  await chmod(codex, 0o700);
  const versions = new Map([[claude, '2.1.274 (Claude Code)'], [codex, 'codex-cli 0.155.0-alpha.16']]);
  const detected = await discoverHarnesses({
    env: { PATH: parent, RIVET_CLAUDE_INTERPRETER: await realpath(process.execPath), RIVET_CODEX_INTERPRETER: await realpath(process.execPath) },
    projectRoot: '/private/tmp/project',
    runner: async (_command, args) => ({ code: 0, stdout: args.includes('--help') ? help(args[0] === claude ? 'claude' : 'codex') : `${versions.get(args[0])}\n`, truncated: {} }),
  });
  assert.equal(detected.find(item => item.kind === 'claude').version, '2.1.274 (Claude Code)');
  assert.equal(detected.find(item => item.kind === 'codex').version, 'codex-cli 0.155.0-alpha.16');
});

test('missing capabilities are ineligible and a missing interpreter is reported', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-harness-discovery-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const codex = join(parent, 'codex');
  await writeFile(codex, '#!/usr/bin/env node\nprocess.exit(0);\n');
  await chmod(codex, 0o700);
  const base = { RIVET_CODEX_EXECUTABLE: codex, RIVET_CODEX_INTERPRETER: await realpath(process.execPath), PATH: '' };
  const badVersion = await discoverHarnesses({
    env: base, projectRoot: '/private/tmp/project',
    runner: async () => ({ code: 0, stdout: 'new but untested version\n', truncated: {} }),
  });
  assert.equal(badVersion.find(item => item.kind === 'codex').reason, 'missing-options: --ephemeral, --ignore-user-config, --color, --sandbox');
  const noInterpreter = await discoverHarnesses({
    env: { RIVET_CODEX_EXECUTABLE: codex, PATH: '' }, projectRoot: '/private/tmp/project',
    runner: async () => { throw new Error('unsafe script must not be probed'); },
  });
  assert.equal(noInterpreter.find(item => item.kind === 'codex').reason, 'interpreter-required');
  const discoveredFromPath = await discoverHarnesses({
    env: { PATH: parent }, projectRoot: '/private/tmp/project',
    runner: async () => { throw new Error('PATH script must not be probed without a pinned interpreter'); },
  });
  assert.equal(discoveredFromPath.find(item => item.kind === 'codex').reason, 'interpreter-required');
  const missingInterpreter = await discoverHarnesses({
    env: { ...base, RIVET_CODEX_INTERPRETER: join(parent, 'missing-node') }, projectRoot: '/private/tmp/project',
    runner: async () => { throw new Error('probe must not run'); },
  });
  assert.equal(missingInterpreter.find(item => item.kind === 'codex').reason, 'interpreter-unavailable');
});

test('explicit script and interpreter are probed together before eligibility', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-harness-discovery-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const script = join(parent, 'claude-script');
  const interpreter = await realpath('/bin/sh');
  await writeFile(script, `#!${interpreter}\nexit 0\n`);
  await chmod(script, 0o700);
  const calls = [];
  const detected = await discoverHarnesses({
    env: { RIVET_CLAUDE_EXECUTABLE: script, RIVET_CLAUDE_INTERPRETER: interpreter, PATH: '' },
    projectRoot: '/private/tmp/another-project',
    runner: async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: args.includes('--help') ? help('claude') : '2.1.207 (Claude Code)\n', truncated: {} };
    },
  });
  assert.deepEqual(calls, [[interpreter, [script, '--version']], [interpreter, [script, '--help']]]);
  assert.equal(detected.find(item => item.kind === 'claude').interpreter, interpreter);
  assert.equal(detected.find(item => item.kind === 'claude').executable, script);
});

test('failed, truncated, oversized, and malformed probes cannot qualify an installation', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-probe-failures-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const executable = join(parent, 'codex');
  await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o700 });
  const env = { PATH: '', RIVET_CODEX_EXECUTABLE: executable, RIVET_CODEX_INTERPRETER: await realpath(process.execPath) };
  for (const output of [
    { code: 1, stdout: help('codex') },
    { code: 0, stdout: help('codex'), timedOut: true },
    { code: 0, stdout: help('codex'), truncated: { stdout: true } },
    { code: 0, stdout: help('codex'), truncated: { stderr: true } },
    { code: 0, stdout: help('codex') + '\n' + 'x'.repeat(65536) },
  ]) {
    const result = await discoverHarnesses({ env, projectRoot: join(parent, 'project'),
      runner: async (_command, args) => args.includes('--help') ? output : { code: 0, stdout: 'codex-cli 99' } });
    assert.equal(result.find(item => item.kind === 'codex').reason, 'capability-probe-failed');
  }
});
