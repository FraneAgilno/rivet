import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';

import { createProcessRunner } from '../../src/clients/process-runner.js';
import { buildLaunchContract } from '../../src/prompts/launch-contract.js';
import { serializePlanningContract } from '../../src/prompts/planning-contract.js';

async function fixture(t, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-client-')));
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  const executable = join(root, 'provider');
  const interpreter = await realpath('/bin/sh');
  await writeFile(executable, `#!${interpreter}\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, executable, interpreter };
}

function envelope(status = 'success') {
  return JSON.stringify({ version: 1, status, output: { summary: 'done', evidence: ['tests'] }, usage: { tokens: 10, costUsd: 0.01 } });
}

async function payload(f) {
  const metadata = await lstat(f.worktree, { bigint: true });
  return buildLaunchContract({
    nodeId: 'worker-one', parentId: 'manager-one', objective: 'Test the provider.',
    ownedPaths: ['src/provider.js'], authority: { actions: ['code.write'], providers: [] },
    commands: ['test.unit'], evidence: ['test-results'],
    budget: { maxTokens: 1000, maxRuntimeMs: 30000, maxCostUsd: 1 },
    worktree: { path: f.worktree, dev: metadata.dev.toString(), ino: metadata.ino.toString(), reservationId: 'lease-one' },
    contextRefs: ['test-context'], heartbeatInterval: 1000, stopConditions: ['objective-complete'],
  });
}

async function planningPayload(f) {
  const metadata = await lstat(f.worktree, { bigint: true });
  return serializePlanningContract({
    worktree: {
      path: f.worktree,
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      reservationId: 'planning-read-only',
    },
    contract: {
      schemaVersion: 1,
      baselineCommit: 'a'.repeat(40),
      client: 'claude',
      workRequest: { schemaVersion: 1, digest: 'b'.repeat(64), title: 'Plan feature' },
      policy: { projectId: 'fixture' },
    },
  });
}

test('runs the branded planning protocol through the same pinned process boundary', async t => {
  const planned = JSON.stringify({
    schemaVersion: 1,
    id: 'planned-feature',
    baselineCommit: 'a'.repeat(40),
    workRequestDigest: 'b'.repeat(64),
    client: 'claude',
    providerRefs: [],
    nodes: [],
  });
  const f = await fixture(t, `cat >/dev/null\nprintf '%s\\n' '${planned}'`);
  const runner = await createProcessRunner({
    executable: f.executable,
    interpreter: f.interpreter,
    worktree: f.worktree,
    maxInputBytes: 512 * 1024,
    maxOutputBytes: 512 * 1024,
  });
  const request = { args: [], cwd: '.', payload: await planningPayload(f) };
  const workerPayload = await payload(f);
  const result = await runner.runPlanning(request);

  assert.equal(result.id, 'planned-feature');
  assert.equal(Object.isFrozen(result), true);
  await assert.rejects(() => runner.run({ ...request }), error => error.code === 'ERR_AGENT_INVALID_CONTRACT');
  await assert.rejects(
    () => runner.runPlanning({ ...request, payload: workerPayload }),
    error => error.code === 'ERR_AGENT_INVALID_CONTRACT',
  );
});

test('runs an argv-only provider with bounded env/stdin and returns an immutable envelope', async t => {
  const f = await fixture(t, `cat >/dev/null\nif [ -n "\${API_TOKEN+x}" ]; then printf bad; else printf '%s\\n' '${envelope()}'; fi`);
  const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, environment: { LANG: 'C', API_TOKEN: 'must-not-pass' } });
  const result = await runner.run({ args: [], cwd: '.', payload: await payload(f) });
  assert.equal(result.status, 'success');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.output));
});

test('preserves non-secret home and shell identity needed by local authenticated clients', async t => {
  const f = await fixture(t, `cat >/dev/null
[ "$HOME" = "/Users/fixture" ] || exit 46
[ "$USER" = "fixture-user" ] || exit 47
[ "$LOGNAME" = "fixture-user" ] || exit 48
[ "$SHELL" = "/bin/zsh" ] || exit 49
[ -z "$ANTHROPIC_API_KEY" ] || exit 50
printf '%s\\n' '${envelope()}'`);
  const runner = await createProcessRunner({
    executable: f.executable,
    interpreter: f.interpreter,
    worktree: f.worktree,
    environment: {
      HOME: '/Users/fixture', USER: 'fixture-user', LOGNAME: 'fixture-user', SHELL: '/bin/zsh',
      ANTHROPIC_API_KEY: 'must-not-pass',
    },
  });
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload(f) })).status, 'success');
});

test('requires a pinned native interpreter for scripts and rejects env or symlink interpreters', async t => {
  const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  await assert.rejects(() => createProcessRunner({ executable: f.executable, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const envScript = join(f.root, 'env-provider');
  await writeFile(envScript, `#!/usr/bin/env sh\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(envScript, 0o700);
  await assert.rejects(() => createProcessRunner({ executable: envScript, interpreter: f.interpreter, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const interpreterLink = join(f.root, 'linked-interpreter');
  await symlink(f.interpreter, interpreterLink);
  const linkedScript = join(f.root, 'linked-interpreter-provider');
  await writeFile(linkedScript, `#!${interpreterLink}\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(linkedScript, 0o700);
  await assert.rejects(() => createProcessRunner({ executable: linkedScript, interpreter: interpreterLink, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
});

test('accepts only a pinned native node interpreter for an npm-style env node script', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-node-script-')));
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'provider.js');
  const interpreter = await realpath(process.execPath);
  const source = `#!/usr/bin/env node\nif (process.argv[2] === '--version') {\n  process.stdout.write('fake-node-provider 1.0.0\\n');\n} else {\n  const chunks = [];\n  process.stdin.on('data', chunk => chunks.push(chunk));\n  process.stdin.on('end', () => process.stdout.write(${JSON.stringify(`${envelope()}\n`)}));\n}\n`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(() => createProcessRunner({ executable, worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
  const runner = await createProcessRunner({ executable, interpreter, worktree });
  assert.equal(await runner.probeVersion(), 'fake-node-provider 1.0.0');
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload({ worktree }) })).status, 'success');
});

test('captures cancellation before construction awaits and cleans its listener deterministically', async t => {
  const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  signal.addEventListener = (...args) => { added += 1; originalAdd(...args); controller.abort(); };
  signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  await assert.rejects(
    () => createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, signal }),
    error => error.code === 'ERR_AGENT_ABORTED',
  );
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('rejects canonical sensitive-label assignments in provider result envelopes', async t => {
  for (const secret of [
    '{"token":"secret-value"}', 'token\u200b=supersecret', '“password”\u2060:\u2060“private-value”',
    'API KEY: private-value', 'auth.token=private-value', '\\"token\\":\\"private-value\\"', 'access - token = private-value',
  ]) {
    const secretEnvelope = JSON.stringify({
      version: 1, status: 'success', output: { summary: secret, evidence: ['tests'] }, usage: { tokens: 1, costUsd: 0 },
    });
    const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${secretEnvelope}'`);
    const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree });
    const launchPayload = await payload(f);
    await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => (
      error.code === 'ERR_AGENT_OUTPUT_INVALID' && !error.message.includes('supersecret')
    ));
  }
  const ordinary = await fixture(t, `cat >/dev/null\nprintf '%s' '${JSON.stringify({
    version: 1, status: 'success', output: { summary: 'Use a token bucket and document API key rotation.', evidence: ['tests'] }, usage: { tokens: 1, costUsd: 0 },
  })}'`);
  const runner = await createProcessRunner({ executable: ordinary.executable, interpreter: ordinary.interpreter, worktree: ordinary.worktree });
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload(ordinary) })).status, 'success');
});

test('detects executable and worktree identity replacement before launch', async t => {
  const executableCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const runner = await createProcessRunner({ executable: executableCase.executable, interpreter: executableCase.interpreter, worktree: executableCase.worktree });
  const launchPayload = await payload(executableCase);
  await rename(executableCase.executable, `${executableCase.executable}-old`);
  await writeFile(executableCase.executable, `#!/bin/sh\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(executableCase.executable, 0o700);
  await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const mutationCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const mutationRunner = await createProcessRunner({ executable: mutationCase.executable, interpreter: mutationCase.interpreter, worktree: mutationCase.worktree });
  const mutationPayload = await payload(mutationCase);
  await writeFile(mutationCase.executable, '#!/bin/sh\nprintf changed\n', { mode: 0o700 });
  await assert.rejects(() => mutationRunner.run({ args: [], cwd: '.', payload: mutationPayload }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const worktreeCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const worktreeRunner = await createProcessRunner({ executable: worktreeCase.executable, interpreter: worktreeCase.interpreter, worktree: worktreeCase.worktree });
  const worktreePayload = await payload(worktreeCase);
  await rename(worktreeCase.worktree, `${worktreeCase.worktree}-old`);
  await mkdir(worktreeCase.worktree);
  await assert.rejects(() => worktreeRunner.run({ args: [], cwd: '.', payload: worktreePayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');
});

test('classifies malformed, multiple, oversized and non-UTF8 provider output safely', async t => {
  const cases = [
    ['printf not-json', 'ERR_AGENT_OUTPUT_INVALID'],
    [`printf '%s\\n%s' '${envelope()}' '${envelope()}'`, 'ERR_AGENT_OUTPUT_INVALID'],
    ["head -c 4096 /dev/zero | tr '\\000' x", 'ERR_AGENT_OUTPUT_OVERFLOW'],
    ["printf '\\377'", 'ERR_AGENT_OUTPUT_INVALID'],
  ];
  for (const [body, code] of cases) {
    const f = await fixture(t, body);
    const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, maxOutputBytes: 1024 });
    const launchPayload = await payload(f);
    await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => error.code === code);
  }
});

test('bounds runtime, handles abort and spawn/identity failures without leaking raw details', async t => {
  const slow = await fixture(t, 'sleep 5');
  const timed = await createProcessRunner({ executable: slow.executable, interpreter: slow.interpreter, worktree: slow.worktree, timeoutMs: 30, termGraceMs: 20, killGraceMs: 100 });
  const slowPayload = await payload(slow);
  await assert.rejects(() => timed.run({ args: [], cwd: '.', payload: slowPayload }), error => error.code === 'ERR_AGENT_TIMEOUT' && !error.message.includes(slow.root));

  const controller = new AbortController();
  const aborted = timed.run({ args: [], cwd: '.', payload: slowPayload, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => aborted, error => error.code === 'ERR_AGENT_ABORTED');

  const linkPath = join(slow.root, 'linked-provider');
  await symlink(slow.executable, linkPath);
  await assert.rejects(() => createProcessRunner({ executable: linkPath, interpreter: slow.interpreter, worktree: slow.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
  const cwdLink = join(slow.worktree, 'linked');
  await symlink(tmpdir(), cwdLink);
  await assert.rejects(() => timed.run({ args: [], cwd: 'linked', payload: slowPayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');
  const hardlinkPath = join(slow.root, 'hardlinked-provider');
  await link(slow.executable, hardlinkPath);
  await assert.rejects(() => createProcessRunner({ executable: hardlinkPath, interpreter: slow.interpreter, worktree: slow.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
  await rm(hardlinkPath);
  const exitCase = await fixture(t, 'exit 23');
  const exitRunner = await createProcessRunner({ executable: exitCase.executable, interpreter: exitCase.interpreter, worktree: exitCase.worktree });
  const exitPayload = await payload(exitCase);
  await assert.rejects(() => exitRunner.run({ args: [], cwd: '.', payload: exitPayload }), error => (
    error.code === 'ERR_AGENT_PROVIDER_UNAVAILABLE' && !error.message.includes(exitCase.root)
  ));
});

test('snapshots hostile request getters once and rejects option/traversal inputs', async t => {
  const f = await fixture(t, `printf '%s' '${envelope()}'`);
  const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree });
  let reads = 0;
  const launchPayload = await payload(f);
  const request = { args: [], cwd: '.', payload: launchPayload };
  Object.defineProperty(request, 'payload', { enumerable: true, get() { reads += 1; return launchPayload; } });
  await runner.run(request);
  assert.equal(reads, 1);
  await assert.rejects(() => runner.run({ args: ['--evil'], cwd: '.', payload: launchPayload }), /argument/i);
  await assert.rejects(() => runner.run({ args: [], cwd: '../outside', payload: launchPayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');

  let executableReads = 0;
  const config = { interpreter: f.interpreter, worktree: f.worktree };
  Object.defineProperty(config, 'executable', { enumerable: true, get() { executableReads += 1; return f.executable; } });
  await createProcessRunner(config);
  assert.equal(executableReads, 1);
});
