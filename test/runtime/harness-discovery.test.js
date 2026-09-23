import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverHarnesses } from '../../src/runtime/harness-discovery.js';

test('discovers only a version-compatible installed adapter outside the project', async t => {
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
      return { code: 0, stdout: 'codex-cli 0.148.0-alpha.9\n', stderr: '', truncated: { stdout: false, stderr: false } };
    },
  });
  assert.equal(detected.find(item => item.kind === 'codex').executable, codex);
  assert.deepEqual(detected.find(item => item.kind === 'claude'), { kind: 'claude', available: false, reason: 'not-installed' });
  assert.deepEqual(called.map(item => item[0]), [await realpath(process.execPath)]);
});

test('wrong version is ineligible and an explicit missing interpreter is reported', async t => {
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
  assert.equal(badVersion.find(item => item.kind === 'codex').reason, 'version-incompatible');
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
      return { code: 0, stdout: '2.1.207 (Claude Code)\n', truncated: {} };
    },
  });
  assert.deepEqual(calls, [[interpreter, [script, '--version']]]);
  assert.equal(detected.find(item => item.kind === 'claude').interpreter, interpreter);
  assert.equal(detected.find(item => item.kind === 'claude').executable, script);
});
