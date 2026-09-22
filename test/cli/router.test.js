import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as syncFilesystem from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import {
  CliError,
  createOutput,
  EXIT_CODES,
  MAX_JSON_OUTPUT_BYTES,
} from '../../src/cli/output.js';
import { ArgumentError, parseArgs } from '../../src/cli/parse-args.js';
import { goalsCommand } from '../../src/commands/goals.js';
import { resolveTargetDir } from '../../src/commands/install.js';
import { orchestrateCommand } from '../../src/commands/orchestrate.js';
import { statusCommand } from '../../src/commands/status.js';
import { graphFixture } from '../../src/graph/fixtures.js';

const CLI_PATH = fileURLToPath(new URL('../../bin/cli.js', import.meta.url));
const DISABLE_NETWORK_PATH = fileURLToPath(new URL('../helpers/disable-network.cjs', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function captureOutput() {
  let stdout = '';
  let stderr = '';
  return {
    output: createOutput({
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    }),
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

function createPrePinSwapFilesystem({ displacedTarget, targetDir, victimDir }) {
  let armed = false;
  let swapped = false;
  let targetValidations = 0;
  return {
    fs: {
      ...syncFilesystem,
      lstatSync(path, ...args) {
        const status = syncFilesystem.lstatSync(path, ...args);
        if (path === targetDir) {
          targetValidations += 1;
          if (targetValidations >= 3) armed = true;
        }
        return status;
      },
      statSync(path, ...args) {
        if (armed && !swapped && (path === targetDir || path === '.')) {
          swapped = true;
          syncFilesystem.renameSync(targetDir, displacedTarget);
          syncFilesystem.symlinkSync(victimDir, targetDir, 'dir');
        }
        return syncFilesystem.statSync(path, ...args);
      },
    },
    wasSwapped: () => swapped,
  };
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stderr, stdout }));
  });
}

async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolvePromise, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('exports the stable CLI exit-code map', () => {
  assert.deepEqual(EXIT_CODES, {
    SUCCESS: 0,
    INVALID_INPUT: 1,
    MISSING_CONFIGURATION: 2,
    BLOCKED_AUTHORITY: 3,
    FAILED_GATE: 4,
    PROVIDER_UNAVAILABLE: 5,
    REPOSITORY_CONFLICT: 6,
    INTERNAL_ERROR: 7,
  });
  assert.equal(Object.isFrozen(EXIT_CODES), true);
});

test('the packed archive contains and executes the complete modular CLI offline', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'rivet-packed-cli-'));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const packDestination = join(fixtureDir, 'pack');
  await mkdir(packDestination);
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = await runProcess(npmExecutable, [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDestination,
  ], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: join(fixtureDir, 'npm-cache'),
      npm_config_fund: 'false',
      npm_config_offline: 'true',
    },
  });

  assert.equal(packed.code, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  const archivedPaths = new Set(manifest.files.map(file => file.path));
  for (const requiredPath of [
    'bin/cli.js',
    'src/cli/main.js',
    'src/cli/output.js',
    'src/cli/parse-args.js',
    'src/commands/install.js',
    'src/commands/init.js',
    'src/commands/doctor.js',
    'src/commands/preflight.js',
    'src/commands/uninstall.js',
    'src/discovery/project.js',
    'src/discovery/git.js',
    'src/discovery/tools.js',
    'templates/project/.rivet/project.yaml',
    'templates/project/.rivet/providers.yaml',
    'templates/project/.rivet/orchestration.yaml',
    'templates/project/.rivet/quality.yaml',
    'dist/mandatory/design/SKILL.md',
    'dist/governance/usage-rules.md',
  ]) {
    assert.equal(archivedPaths.has(requiredPath), true, `missing packed runtime file: ${requiredPath}`);
  }
  assert.equal(
    [...archivedPaths].some(path => /^(?:test|docs|documentation|security|\.github)\//.test(path)),
    false,
  );

  const isolatedProject = join(fixtureDir, 'consumer');
  const installedPackage = join(
    isolatedProject,
    'node_modules',
    '@agilno',
    'rivet',
  );
  await mkdir(installedPackage, { recursive: true });
  const archivePath = join(packDestination, manifest.filename);
  const extracted = await runProcess('tar', [
    '-xzf',
    archivePath,
    '--strip-components=1',
    '-C',
    installedPackage,
  ]);
  assert.equal(extracted.code, 0, extracted.stderr);

  const dependencyScope = join(isolatedProject, 'node_modules', '@inquirer');
  await mkdir(dependencyScope, { recursive: true });
  await symlink(
    join(PACKAGE_ROOT, 'node_modules', '@inquirer', 'checkbox'),
    join(dependencyScope, 'checkbox'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const dependency of ['ajv', 'yaml']) {
    await symlink(
      join(PACKAGE_ROOT, 'node_modules', dependency),
      join(isolatedProject, 'node_modules', dependency),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await writeFile(join(isolatedProject, 'package.json'), '{"private":true}\n');
  const executed = await runProcess(process.execPath, [
    '--require',
    DISABLE_NETWORK_PATH,
    join(installedPackage, 'bin', 'cli.js'),
    'doctor',
    '--json',
  ], {
    cwd: isolatedProject,
    env: { ...process.env, npm_config_offline: 'true' },
  });

  assert.equal(executed.signal, null);
  assert.equal(executed.code, EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(executed.stdout, '');
  assert.equal(executed.stderr.split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(executed.stderr).error.code, 'MISSING_CONFIGURATION');
});

test('selects the exact numeric exit code for every stable error category', () => {
  for (const [name, exitCode] of Object.entries(EXIT_CODES)) {
    if (name === 'SUCCESS') continue;
    assert.equal(new CliError('safe', name).exitCode, exitCode);
  }
});

test('empty arguments preserve the legacy default route', () => {
  assert.deepEqual(parseArgs([]), {
    command: null,
    subcommand: null,
    operands: [],
    flags: {},
  });
});

test('parses the install command with a legacy boolean flag', () => {
  const parsed = parseArgs(['install', '--all', '--global', '--target=both']);

  assert.equal(parsed.command, 'install');
  assert.deepEqual(parsed.flags, {
    all: true,
    global: true,
    target: 'both',
  });
});

test('parses the uninstall command and its legacy target shortcut', () => {
  const parsed = parseArgs(['uninstall', '--codex']);

  assert.equal(parsed.command, 'uninstall');
  assert.equal(parsed.flags.codex, true);
});

test('parses a future command with JSON output enabled', () => {
  const parsed = parseArgs(['doctor', '--json']);

  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.flags.json, true);
});

test('parses strict v2 init, doctor, and preflight options in separated and equals forms', () => {
  assert.deepEqual(parseArgs(['init', '--project', '/project', '--json']).flags, {
    project: '/project',
    json: true,
  });
  assert.deepEqual(parseArgs(['doctor', '--project=/project', '--json']).flags, {
    project: '/project',
    json: true,
  });
  assert.deepEqual(parseArgs(['preflight', '--project', '/project']).flags, {
    project: '/project',
  });
});

test('rejects unknown, duplicate, missing, and conflicting v2 command options', () => {
  assert.throws(() => parseArgs(['doctor', '--write']), /Unknown option '--write'/);
  assert.throws(() => parseArgs(['preflight', '--project']), /Flag '--project' requires a value/);
  assert.throws(() => parseArgs(['init', '--project=a', '--project', 'b']), /Duplicate flag '--project'/);
  assert.throws(() => parseArgs(['init', '--overwrite']), /requires '--write'/);
  assert.throws(() => parseArgs(['doctor', 'project']), /does not accept positional arguments/);
});

test('routes explicit v2 init flags and supported diagnostic commands through injected handlers', async () => {
  const result = captureOutput();
  const calls = [];
  const handler = async (parsed, dependencies) => {
    calls.push(parsed.command);
    dependencies.output.json({ ok: true });
    return EXIT_CODES.SUCCESS;
  };

  assert.equal(await main(['init', '--project=/project', '--json'], {
    output: result.output,
    commands: { init: handler },
  }), EXIT_CODES.SUCCESS);
  assert.equal(await main(['doctor', '--json'], {
    output: result.output,
    commands: { doctor: handler },
  }), EXIT_CODES.SUCCESS);
  assert.equal(await main(['preflight', '--json'], {
    output: result.output,
    commands: { preflight: handler },
  }), EXIT_CODES.SUCCESS);
  assert.deepEqual(calls, ['init', 'doctor', 'preflight']);
});

async function v2ConfiguredProject() {
  const root = await mkdtemp(join(tmpdir(), 'rivet-v2-init-'));
  await cp(join(PACKAGE_ROOT, 'test', 'fixtures', 'projects', 'nextjs'), root, { recursive: true });
  await cp(
    join(PACKAGE_ROOT, 'test', 'fixtures', 'config', 'valid', '.rivet'),
    join(root, '.rivet'),
    { recursive: true },
  );
  return root;
}

test('human v2 init shows diffs and invokes injected confirmation once before overwrite', async t => {
  const root = await v2ConfiguredProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = captureOutput();
  let confirmations = 0;
  const exitCode = await main(['init', '--project', root, '--write'], {
    output: capture.output,
    confirmOverwrite: async diffs => {
      confirmations += 1;
      assert.match(capture.readStdout(), /Proposed overwrite:/);
      assert.equal(diffs['project.yaml'].action, 'replace');
      return true;
    },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(confirmations, 1);
  assert.match(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), /id: nextjs-example/);
});

test('human v2 init cancellation invokes confirmation once and preserves all files', async t => {
  const root = await v2ConfiguredProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filenames = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];
  const before = await Promise.all(filenames.map(filename => readFile(join(root, '.rivet', filename), 'utf8')));
  const capture = captureOutput();
  let confirmations = 0;
  const exitCode = await main(['init', '--project', root, '--write'], {
    output: capture.output,
    confirmOverwrite: async () => {
      confirmations += 1;
      assert.match(capture.readStdout(), /project\.yaml: replace/);
      return false;
    },
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(confirmations, 1);
  assert.deepEqual(
    await Promise.all(filenames.map(filename => readFile(join(root, '.rivet', filename), 'utf8'))),
    before,
  );
});

test('JSON v2 init never invokes confirmation and requires explicit overwrite', async t => {
  const root = await v2ConfiguredProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = captureOutput();
  let confirmations = 0;
  const exitCode = await main(['init', '--project', root, '--write', '--json'], {
    output: capture.output,
    confirmOverwrite: async () => { confirmations += 1; return true; },
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(confirmations, 0);
  assert.equal(capture.readStdout(), '');
  assert.equal(JSON.parse(capture.readStderr()).error.code, 'REPOSITORY_CONFLICT');
});

test('preserves operands for an unimplemented non-nested future command', () => {
  const parsed = parseArgs(['status', 'demo-project']);

  assert.equal(parsed.subcommand, null);
  assert.deepEqual(parsed.operands, ['demo-project']);
});

test('parses only the bounded localhost status command surface', () => {
  assert.deepEqual(parseArgs(['status', 'demo', '--fixture=test/fixtures/runs/parallel-success.json', '--port=0']), {
    command: 'status', subcommand: null, operands: ['demo'],
    flags: { fixture: 'test/fixtures/runs/parallel-success.json', port: '0' },
  });
  for (const argv of [
    ['status'],
    ['status', 'demo', 'extra'],
    ['status', 'demo', '--host=0.0.0.0'],
    ['status', 'demo', '--fixture'],
    ['status', 'demo', '--port'],
    ['status', 'demo', '--open'],
  ]) assert.throws(() => parseArgs(argv), ArgumentError, argv.join(' '));
});

test('default status route loads the tracked fixture blob without mutable filesystem reads or opening a browser', async () => {
  const controller = new AbortController();
  controller.abort();
  const capture = captureOutput();
  const forbiddenFs = new Proxy({}, { get() { throw new Error('mutable filesystem private canary'); } });

  const exitCode = await main(['status', 'demo', '--fixture=test/fixtures/runs/parallel-success.json'], {
    cwd: () => PACKAGE_ROOT,
    fs: forbiddenFs,
    output: capture.output,
    status: { signal: controller.signal, now: () => Date.parse('2029-01-01T00:00:00.000Z') },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.match(capture.readStdout(), /^Status: http:\/\/127\.0\.0\.1:\d+\n$/);
  assert.equal(capture.readStderr(), '');
});

test('tracked fixture loading is invariant to an intermediate worktree symlink swap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-status-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runGit = (...args) => new Promise((resolvePromise, reject) => execFile('git', args, {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }, (error, stdout) => error ? reject(error) : resolvePromise(stdout)));
  await runGit('init', '--quiet');
  await mkdir(join(root, 'tracked'));
  await writeFile(join(root, 'tracked', 'fixture.json'), JSON.stringify({
    schemaVersion: 1, scripts: [{ version: 1, kind: 'success', output: { evidence: ['safe-evidence'] }, usage: { tokens: 1, costUsd: 0 } }],
  }));
  await runGit('add', 'tracked/fixture.json');
  await runGit('commit', '--quiet', '-m', 'fixture');
  await rename(join(root, 'tracked'), join(root, 'tracked-original'));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'fixture.json'), JSON.stringify({
    schemaVersion: 1, scripts: [{ version: 1, kind: 'success', output: { evidence: ['evil-evidence'] }, usage: { tokens: 1, costUsd: 0 } }],
  }));
  await symlink(join(root, 'outside'), join(root, 'tracked'));
  let captured;
  let closed = 0;
  const capture = captureOutput();
  const controller = new AbortController(); controller.abort();
  const exitCode = await main(['status', 'demo', '--fixture=tracked/fixture.json'], {
    cwd: () => root,
    output: capture.output,
    status: {
      signal: controller.signal,
      createServer: options => ({
        async start() { captured = await options.readState(); return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { closed += 1; },
      }),
    },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(captured.evidence.map(item => item.id), ['safe-evidence']);
  assert.equal(closed, 1);
});

test('status command validates the started server address before output and safely closes invalid surfaces', async () => {
  for (const address of [
    { host: '0.0.0.0', port: 4242, url: 'http://127.0.0.1:4242' },
    { host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:0' },
    { host: '127.0.0.1', port: 4242, url: 'https://127.0.0.1:4242' },
    { host: '127.0.0.1', port: 4243, url: 'http://127.0.0.1:4243' },
  ]) {
    let closed = 0;
    const capture = captureOutput();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => statusCommand({ command: 'status', subcommand: null, operands: ['demo'], flags: { port: '4242' } }, {
      output: capture.output,
      status: {
        resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
        createServer: () => ({ start: async () => address, close: async () => { closed += 1; } }),
        signal: controller.signal,
      },
    }), error => error instanceof CliError && error.safeMessage === 'Status server is unavailable.');
    assert.equal(closed, 1);
    assert.equal(capture.readStdout(), '');
    assert.equal(capture.readStderr(), '');
  }
});

test('JSON status publishes its URL while main owns the live server through stop', async t => {
  let finishWait;
  const waiting = new Promise(resolvePromise => { finishWait = resolvePromise; });
  let live = false;
  let closed = 0;
  const capture = captureOutput();
  t.after(() => finishWait());
  const command = main(['status', 'demo', '--port=4242', '--json'], {
    output: capture.output,
    status: {
      resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
      createServer: () => ({
        async start() { live = true; return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { live = false; closed += 1; },
      }),
      wait: () => waiting,
    },
  });
  let settled = false;
  command.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.deepEqual(JSON.parse(capture.readStdout()), {
    ok: true, command: 'status', instanceId: 'demo', url: 'http://127.0.0.1:4242',
  });
  assert.equal(settled, false);
  assert.equal(live, true);
  assert.equal(closed, 0);

  finishWait();
  assert.equal(await command, EXIT_CODES.SUCCESS);
  assert.equal(live, false);
  assert.equal(closed, 1);
});

test('JSON status background cleanup observes a rejected stop waiter without an unhandled rejection', async () => {
  let closed = 0;
  const capture = captureOutput();
  const exitCode = await main(['status', 'demo', '--port=4242', '--json'], {
    output: capture.output,
    status: {
      resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
      createServer: () => ({
        async start() { return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { closed += 1; },
      }),
      wait: () => Promise.reject(new Error('Cookie: sessionid=background-private-canary')),
    },
  });
  for (let index = 0; index < 20 && closed === 0; index += 1) await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(JSON.parse(capture.readStdout()), {
    ok: true, command: 'status', instanceId: 'demo', url: 'http://127.0.0.1:4242',
  });
  assert.equal(capture.readStderr(), '');
  assert.equal(closed, 1);
});

test('JSON status synchronous publication failure cancels the default signal waiter', async t => {
  const before = new Map([
    ['SIGINT', new Set(process.rawListeners('SIGINT'))],
    ['SIGTERM', new Set(process.rawListeners('SIGTERM'))],
  ]);
  t.after(() => {
    for (const [signal, listeners] of before) {
      for (const listener of process.rawListeners(signal)) {
        if (!listeners.has(listener)) process.off(signal, listener);
      }
    }
  });
  let closed = 0;
  const output = createOutput({
    stdout: { write() { const error = new Error('synchronous publication private canary'); error.code = 'EPIPE'; throw error; } },
    stderr: { write() {} },
  });

  const exitCode = await main(['status', 'demo', '--port=4242', '--json'], {
    output,
    status: {
      resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
      createServer: () => ({
        async start() { return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { closed += 1; },
      }),
    },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(closed, 1);
  assert.equal(process.listenerCount('SIGINT'), before.get('SIGINT').size);
  assert.equal(process.listenerCount('SIGTERM'), before.get('SIGTERM').size);
});

test('JSON status asynchronous publication failure cancels the default waiter and output observer', async t => {
  const before = new Map([
    ['SIGINT', new Set(process.rawListeners('SIGINT'))],
    ['SIGTERM', new Set(process.rawListeners('SIGTERM'))],
  ]);
  t.after(() => {
    for (const [signal, listeners] of before) {
      for (const listener of process.rawListeners(signal)) {
        if (!listeners.has(listener)) process.off(signal, listener);
      }
    }
  });
  class FailingStream extends EventEmitter {
    write() {
      setImmediate(() => {
        const error = new Error('asynchronous publication private canary');
        error.code = 'EPIPE';
        this.emit('error', error);
      });
      return true;
    }
  }
  const stdout = new FailingStream();
  stdout.on('error', () => {});
  let closed = 0;
  const output = createOutput({ stdout, stderr: { write() {} } });

  const exitCode = await main(['status', 'demo', '--port=4242', '--json'], {
    output,
    status: {
      resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
      createServer: () => ({
        async start() { return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { closed += 1; throw new Error('late close rejection private canary'); },
      }),
    },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(closed, 1);
  assert.equal(stdout.listenerCount('error'), 1);
  assert.equal(process.listenerCount('SIGINT'), before.get('SIGINT').size);
  assert.equal(process.listenerCount('SIGTERM'), before.get('SIGTERM').size);
});

test('repeated JSON publication failures do not accumulate default process signal listeners', async t => {
  const before = new Map([
    ['SIGINT', new Set(process.rawListeners('SIGINT'))],
    ['SIGTERM', new Set(process.rawListeners('SIGTERM'))],
  ]);
  t.after(() => {
    for (const [signal, listeners] of before) {
      for (const listener of process.rawListeners(signal)) {
        if (!listeners.has(listener)) process.off(signal, listener);
      }
    }
  });
  let closed = 0;
  for (let invocation = 0; invocation < 12; invocation += 1) {
    const output = createOutput({
      stdout: { write() { const error = new Error('repeated EPIPE canary'); error.code = 'EPIPE'; throw error; } },
      stderr: { write() {} },
    });
    assert.equal(await main(['status', 'demo', '--port=4242', '--json'], {
      output,
      status: {
        resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
        createServer: () => ({
          async start() { return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
          async close() { closed += 1; },
        }),
      },
    }), EXIT_CODES.SUCCESS);
  }
  assert.equal(closed, 12);
  assert.equal(process.listenerCount('SIGINT'), before.get('SIGINT').size);
  assert.equal(process.listenerCount('SIGTERM'), before.get('SIGTERM').size);
});

test('JSON status default signal waiter removes listeners after a normal external stop', async t => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const controller = new AbortController();
  let closed = 0;
  const capture = captureOutput();
  const command = main(['status', 'demo', '--port=4242', '--json'], {
    output: capture.output,
    status: {
      signal: controller.signal,
      resolveInstance: async () => ({ id: 'demo', acquire: async () => ({ release: async () => {} }), read: async () => ({}) }),
      createServer: () => ({
        async start() { return { host: '127.0.0.1', port: 4242, url: 'http://127.0.0.1:4242' }; },
        async close() { closed += 1; },
      }),
    },
  });
  t.after(() => controller.abort());
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
  controller.abort();
  assert.equal(await command, EXIT_CODES.SUCCESS);
  assert.equal(closed, 1);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
});

test('default verify and evidence routes reach their configured Task11 handlers', async () => {
  for (const command of ['verify', 'evidence']) {
    const capture = captureOutput();
    const exitCode = await main([command, '--json'], { output: capture.output });
    assert.equal(exitCode, EXIT_CODES.MISSING_CONFIGURATION, command);
    assert.equal(capture.readStdout(), '', command);
    const payload = JSON.parse(capture.readStderr());
    assert.equal(payload.error.code, 'MISSING_CONFIGURATION', command);
    assert.doesNotMatch(payload.error.message, /not implemented/i, command);
  }
});

test('parses a future nested command and preserves its operand', () => {
  const parsed = parseArgs(['goals', 'status', 'demo']);

  assert.equal(parsed.command, 'goals');
  assert.equal(parsed.subcommand, 'status');
  assert.deepEqual(parsed.operands, ['demo']);
});

test('default goals handler resolves an explicit private instance and emits status', async () => {
  const capture = captureOutput();
  let resolvedId;
  let locked = false;
  const state = { version: 4, activated: true, terminal: null, graph: graphFixture('parallel-fan-in'), events: [] };
  const privateInstance = {
    id: 'demo-instance',
    async acquire() { locked = true; return { release: async () => { locked = false; } }; },
    async read() { assert.equal(locked, true); return structuredClone(state); },
  };

  const exitCode = await main(['goals', 'status', 'demo-instance', '--json'], {
    output: capture.output,
    orchestration: {
      resolveInstance: async id => { resolvedId = id; return privateInstance; },
    },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(resolvedId, 'demo-instance');
  const payload = JSON.parse(capture.readStdout());
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'goals');
  assert.equal(payload.subcommand, 'status');
  assert.equal(payload.result.version, 4);
  assert.equal(capture.readStderr(), '');
});

test('default orchestrate handler delegates run to an injected runtime and explicit instance', async () => {
  const capture = captureOutput();
  const calls = [];
  const privateInstance = { id: 'demo-instance' };
  const exitCode = await main(['orchestrate', 'run', 'demo-instance', '--expected-version=4', '--json'], {
    output: capture.output,
    orchestration: {
      resolveInstance: async id => { calls.push(['resolve', id]); return privateInstance; },
      runtime: { tick: async (instance, options) => { calls.push(['tick', instance, options]); return { version: 5, terminal: null, launched: [] }; } },
    },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(calls, [
    ['resolve', 'demo-instance'],
    ['tick', privateInstance, { expectedVersion: 4 }],
  ]);
  assert.deepEqual(JSON.parse(capture.readStdout()), {
    ok: true,
    command: 'orchestrate',
    subcommand: 'run',
    result: { version: 5, terminal: null, launched: [] },
  });
  assert.equal(capture.readStderr(), '');
});

test('goals CLI rejects unknown actions and flags before private resolution or request construction', async () => {
  let resolutions = 0; let requests = 0;
  const dependencies = {
    orchestration: {
      resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
      requestFor: async () => { requests += 1; return {}; },
    },
  };
  for (const parsed of [
    { command: 'goals', subcommand: 'unknown', operands: ['demo-instance'], flags: {} },
    { command: 'goals', subcommand: 'status', operands: ['demo-instance'], flags: { unexpected: true } },
  ]) await assert.rejects(() => goalsCommand(parsed, dependencies), CliError);
  assert.equal(resolutions, 0);
  assert.equal(requests, 0);
});

test('goals CLI requires and parses mutation versions before private resolution', async () => {
  let resolutions = 0; let requests = 0;
  const dependencies = {
    orchestration: {
      resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
      requestFor: async () => { requests += 1; return {}; },
      runtime: { cancelNode: async () => {} },
    },
  };
  for (const flags of [{ node: 'api' }, { node: 'api', 'expected-version': 'invalid' }, { node: 'api', 'expected-version': '1', 'now-ms': 'invalid' }]) {
    await assert.rejects(() => goalsCommand({ command: 'goals', subcommand: 'cancel-node', operands: ['demo-instance'], flags }, dependencies), CliError);
  }
  assert.equal(resolutions, 0);
  assert.equal(requests, 0);
});

test('goals and orchestrate validate injected runtime surfaces before private resolution', async () => {
  for (const invoke of [
    dependencies => goalsCommand({
      command: 'goals', subcommand: 'cancel-node', operands: ['demo-instance'], flags: { node: 'api', 'expected-version': '1' },
    }, dependencies),
    dependencies => orchestrateCommand({
      command: 'orchestrate', subcommand: 'run', operands: ['demo-instance'], flags: { 'expected-version': '1' },
    }, dependencies),
  ]) {
    let resolutions = 0;
    await assert.rejects(() => invoke({ orchestration: {
      resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; }, runtime: {}, requestFor: async () => ({}),
    } }), CliError);
    assert.equal(resolutions, 0);
  }
});

test('goals CLI rejects request input whose version differs from the normalized CLI version', async () => {
  let mutations = 0; let requests = 0; let resolutions = 0;
  await assert.rejects(() => goalsCommand({
    command: 'goals', subcommand: 'cancel-node', operands: ['demo-instance'], flags: { node: 'api', 'expected-version': '1' },
  }, {
    orchestration: {
      resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
      requestFor: async request => { requests += 1; assert.equal(request.flags['expected-version'], 1); return { expectedVersion: 2 }; },
      runtime: { cancelNode: async () => { mutations += 1; } },
    },
  }), CliError);
  assert.equal(requests, 1);
  assert.equal(resolutions, 0);
  assert.equal(mutations, 0);
});

test('goals CLI performs a valid mutation in request resolve mutate order', async () => {
  const capture = captureOutput(); const order = []; let locked = false;
  const state = { version: 1, activated: true, terminal: null, graph: graphFixture('parallel-fan-in'), events: [] };
  const instance = {
    id: 'demo-instance',
    async acquire() { locked = true; return { release: async () => { locked = false; } }; },
    async read() { assert.equal(locked, true); return structuredClone(state); },
  };
  const exitCode = await goalsCommand({
    command: 'goals', subcommand: 'cancel-node', operands: ['demo-instance'], flags: { node: 'api', 'expected-version': '1', json: true },
  }, {
    output: capture.output,
    orchestration: {
      requestFor: async request => { order.push('request'); return { expectedVersion: request.flags['expected-version'], nodeId: request.flags.node, authority: Object.freeze({ actorId: 'engineering-manager' }) }; },
      resolveInstance: async () => { order.push('resolve'); return instance; },
      runtime: { cancelNode: async () => { order.push('mutate'); } },
    },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(order, ['request', 'resolve', 'mutate']);
});

test('goals CLI snapshots mutation input once before resolution and dispatches an immutable plain boundary object', async () => {
  const capture = captureOutput(); let locked = false; const reads = new Map();
  const state = { version: 1, activated: true, terminal: null, graph: graphFixture('parallel-fan-in'), events: [] };
  const instance = {
    id: 'demo-instance',
    async acquire() { locked = true; return { release: async () => { locked = false; } }; },
    async read() { assert.equal(locked, true); return structuredClone(state); },
  };
  const backing = { expectedVersion: 1, nodeId: 'api', nowMs: 5, authority: Object.freeze({ actorId: 'engineering-manager' }) };
  const response = {};
  for (const key of Object.keys(backing)) Object.defineProperty(response, key, {
    enumerable: true,
    get() { reads.set(key, (reads.get(key) ?? 0) + 1); return backing[key]; },
  });
  const exitCode = await goalsCommand({
    command: 'goals', subcommand: 'cancel-node', operands: ['demo-instance'], flags: { node: 'api', 'expected-version': '1', 'now-ms': '5', json: true },
  }, {
    output: capture.output,
    orchestration: {
      requestFor: async () => response,
      resolveInstance: async () => { backing.nodeId = 'design'; backing.nowMs = 99; return instance; },
      runtime: { cancelNode: async (_instance, input) => {
        assert.equal(Object.getPrototypeOf(input), null);
        assert.equal(Object.isFrozen(input), true);
        assert.equal(input.expectedVersion, 1); assert.equal(input.nodeId, 'api'); assert.equal(input.nowMs, 5);
      } },
    },
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(Object.fromEntries(reads), { expectedVersion: 1, nodeId: 1, nowMs: 1, authority: 1 });
});

test('goals CLI binds every normalized CLI mutation field before resolving', async () => {
  const cases = [
    ['cancel-node', { node: 'api', 'expected-version': '1', 'now-ms': '5' }, { expectedVersion: 1, nodeId: 'api', nowMs: 6, authority: {} }],
    ['retry-node', { node: 'api', reason: 'retry', 'expected-version': '1' }, { expectedVersion: 1, nodeId: 'api', reason: 'other', authority: {} }],
    ['create-corrective-node', { source: 'api', node: 'api-fix', owner: 'fix-worker', reason: 'fix', 'expected-version': '1' }, { expectedVersion: 1, sourceNodeId: 'other', nodeId: 'api-fix', ownerId: 'fix-worker', reason: 'fix', authority: {}, evidenceRefs: ['api-commit', 'api-test'] }],
  ];
  for (const [subcommand, flags, response] of cases) {
    let resolutions = 0;
    await assert.rejects(() => goalsCommand({ command: 'goals', subcommand, operands: ['demo-instance'], flags }, {
      orchestration: {
        requestFor: async () => response,
        resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
        runtime: { cancelNode: async () => {}, retryNode: async () => {} },
      },
    }), CliError);
    assert.equal(resolutions, 0);
  }
});

test('goals CLI validates subcommand-specific identifiers and reasons before private resolution', async () => {
  let resolutions = 0; let requests = 0;
  const dependencies = { orchestration: {
    resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
    requestFor: async () => { requests += 1; return {}; },
    runtime: { retryNode: async () => {}, cancelNode: async () => {}, cancelGoal: async () => {}, recoverStalledNode: async () => {} },
  } };
  for (const [subcommand, flags] of [
    ['retry-node', { node: 'api', 'expected-version': '1' }],
    ['cancel-node', { node: 'Not-Safe', 'expected-version': '1' }],
    ['cancel-goal', { node: 'api', 'expected-version': '1' }],
    ['create-corrective-node', { source: 'api', node: 'api-fix', 'expected-version': '1', reason: 'fix' }],
    ['recover-stalled-node', { node: 'api', 'expected-version': '1', reason: 'bad\nreason' }],
    ['recover-lock', { reason: 'unexpected', 'expected-version': '1' }],
  ]) await assert.rejects(() => goalsCommand({ command: 'goals', subcommand, operands: ['demo-instance'], flags }, dependencies), CliError);
  assert.equal(resolutions, 0);
  assert.equal(requests, 0);
});

test('orchestrate CLI validates every numeric option before private resolution', async () => {
  let resolutions = 0;
  const dependencies = {
    orchestration: {
      resolveInstance: async () => { resolutions += 1; return { id: 'demo-instance' }; },
      runtime: { tick: async () => ({ version: 1, terminal: null, launched: [] }) },
    },
  };
  await assert.rejects(() => orchestrateCommand({
    command: 'orchestrate', subcommand: 'run', operands: ['demo-instance'], flags: { 'expected-version': 'not-a-number' },
  }, dependencies), CliError);
  assert.equal(resolutions, 0);
});

test('rejects an unknown command', () => {
  assert.throws(
    () => parseArgs(['unknown-command']),
    /Unknown command 'unknown-command'/,
  );
});

test('rejects the retired demo command before dispatch or filesystem mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-retired-demo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'unexpected-write');
  const capture = captureOutput();
  let dispatched = false;

  const exitCode = await main(['demo', 'create', root, '--name=retired-demo'], {
    output: capture.output,
    commands: {
      demo: async () => {
        dispatched = true;
        await writeFile(marker, 'unexpected mutation');
        return EXIT_CODES.SUCCESS;
      },
    },
  });

  assert.equal(exitCode, EXIT_CODES.INVALID_INPUT);
  assert.equal(dispatched, false);
  assert.equal(syncFilesystem.existsSync(marker), false);
  assert.match(capture.readStdout(), /^Usage:/);
  assert.doesNotMatch(capture.readStdout(), /rivet demo\b/);
  assert.equal(capture.readStderr(), '');
});

test('rejects positional arguments for a legacy command', () => {
  assert.throws(
    () => parseArgs(['install', 'unexpected']),
    /Command 'install' does not accept positional arguments/,
  );
});

test('rejects a missing nested command', () => {
  assert.throws(
    () => parseArgs(['goals', '--json']),
    /Command 'goals' requires a subcommand/,
  );
});

test('rejects malformed and duplicate flags', () => {
  assert.throws(() => parseArgs(['doctor', '--=value']), /Malformed flag '--=value'/);
  assert.throws(() => parseArgs(['doctor', '--json', '--json']), /Duplicate flag '--json'/);
  assert.throws(() => parseArgs(['doctor', '--json=false']), /Flag '--json' does not take a value/);
  assert.throws(() => parseArgs(['doctor', '--project=']), /Malformed flag '--project='/);
});

test('rejects malformed legacy option forms', () => {
  assert.throws(() => parseArgs(['install', '--all=true']), /Flag '--all' does not take a value/);
  assert.throws(() => parseArgs(['install', '--target']), /Flag '--target' requires a value/);
  assert.throws(() => parseArgs(['uninstall', '--unknown']), /Unknown option '--unknown'/);
});

test('rejects contradictory target selectors while allowing identical selectors', () => {
  for (const argv of [
    ['install', '--claude', '--target=codex'],
    ['install', '--claude', '--target=CODEX'],
    ['install', '--codex', '--target=claude'],
    ['uninstall', '--claude', '--target=both'],
    ['uninstall', '--codex', '--target=both'],
  ]) {
    assert.throws(() => parseArgs(argv), /Conflicting target selectors/);
  }

  assert.deepEqual(
    parseArgs(['install', '--claude', '--codex', '--target=both']).flags,
    { claude: true, codex: true, target: 'both' },
  );
  assert.deepEqual(
    parseArgs(['uninstall', '--codex', '--target=codex']).flags,
    { codex: true, target: 'codex' },
  );
  assert.deepEqual(
    parseArgs(['install', '--claude', '--target=CLAUDE']).flags,
    { claude: true, target: 'CLAUDE' },
  );
  assert.throws(
    () => parseArgs(['install', '--claude', '--target=unsupported']),
    /Invalid --target value/,
  );
});

test('rejects the unsupported end-of-options separator explicitly', () => {
  assert.throws(
    () => parseArgs(['goals', 'status', '--', '--literal-operand']),
    /End-of-options separator '--' is not supported/,
  );
});

test('relative injected CODEX_HOME resolves against injected cwd', () => {
  const parsed = parseArgs(['install', '--global', '--codex', '--all']);
  const injectedCwd = join(tmpdir(), 'injected-cwd');

  assert.equal(
    resolveTargetDir('codex', parsed, {
      cwd: () => injectedCwd,
      env: { CODEX_HOME: 'relative-codex-home' },
      fs: syncFilesystem,
      home: () => join(tmpdir(), 'home'),
    }),
    join(injectedCwd, 'relative-codex-home', 'skills'),
  );
});

test('routes legacy commands through injected handlers and dependencies', async () => {
  const capture = captureOutput();
  const dependencies = {
    cwd: () => '/project',
    env: { CODEX_HOME: '/codex' },
    fetch: async () => ({ ok: false }),
    fs: { marker: 'filesystem' },
    home: () => '/home',
    output: capture.output,
    prompt: async () => [],
  };
  const calls = [];
  dependencies.commands = {
    install: async (parsed, received) => {
      calls.push(['install', parsed, received]);
      return EXIT_CODES.SUCCESS;
    },
    uninstall: async (parsed, received) => {
      calls.push(['uninstall', parsed, received]);
      return EXIT_CODES.SUCCESS;
    },
  };

  assert.equal(await main(['install', '--all'], dependencies), EXIT_CODES.SUCCESS);
  assert.equal(await main(['uninstall', '--codex'], dependencies), EXIT_CODES.SUCCESS);
  assert.deepEqual(calls.map(([name]) => name), ['install', 'uninstall']);
  assert.equal(calls[0][1].flags.all, true);
  assert.equal(calls[1][1].flags.codex, true);
  assert.equal(calls[0][2].fs, dependencies.fs);
  assert.equal(calls[0][2].prompt, dependencies.prompt);
  assert.equal(calls[0][2].env, dependencies.env);
  assert.equal(calls[0][2].cwd, dependencies.cwd);
  assert.equal(calls[0][2].home, dependencies.home);
  assert.equal(calls[0][2].output, dependencies.output);
});

test('empty arguments keep the legacy usage and invalid-input exit', async () => {
  const capture = captureOutput();

  const exitCode = await main([], { output: capture.output });

  assert.equal(exitCode, EXIT_CODES.INVALID_INPUT);
  assert.match(capture.readStdout(), /^Usage:/);
  assert.equal(capture.readStderr(), '');
});

test('closed stdout terminates cleanly without an EPIPE stack or source path', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-epipe-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const child = spawn(process.execPath, [
    '--require',
    DISABLE_NETWORK_PATH,
    CLI_PATH,
    'install',
    '--all',
    '--target=codex',
  ], {
    cwd: projectDir,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.destroy();

  const result = await waitForChild(child);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(stderr, /EPIPE|node:internal|src\/cli|bin\/cli\.js|\n\s+at /);
});

test('closed stdout terminates JSON status without leaving an undiscoverable localhost server', async t => {
  const child = spawn(process.execPath, [
    CLI_PATH,
    'status',
    'demo',
    '--fixture=test/fixtures/runs/parallel-success.json',
    '--json',
  ], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = waitForChild(child);
  child.stdout.destroy();
  const result = await Promise.race([
    completion.then(value => ({ ...value, timedOut: false })),
    new Promise(resolvePromise => setTimeout(() => resolvePromise({ timedOut: true }), 2_500)),
  ]);
  if (result.timedOut) {
    child.kill('SIGTERM');
    await completion;
  }

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(stderr, /EPIPE|private canary|node:internal|src\/cli|bin\/cli\.js|\n\s+at /i);
});

test('routes the legacy init command without overwriting governance files', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-router-init-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();

  const firstExit = await main(['init'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });
  const governancePath = join(projectDir, '.claude', 'usage-rules.md');
  const firstContent = await readFile(governancePath, 'utf8');
  await writeFile(governancePath, 'project-owned\n');
  const secondExit = await main(['init'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(firstExit, EXIT_CODES.SUCCESS);
  assert.equal(secondExit, EXIT_CODES.SUCCESS);
  assert.notEqual(firstContent, 'project-owned\n');
  assert.equal(await readFile(governancePath, 'utf8'), 'project-owned\n');
  assert.match(capture.readStdout(), /Copied to \.claude\//);
  assert.match(capture.readStdout(), /Skipped \(already exist\)/);
  assert.equal(capture.readStderr(), '');
});

test('legacy init classifies missing governance distribution as missing configuration', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-init-missing-governance-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();

  const exitCode = await main(['init'], {
    cwd: () => projectDir,
    output: capture.output,
    packageRoot: projectDir,
  });

  assert.equal(exitCode, EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(capture.readStdout(), '');
  assert.equal(
    capture.readStderr(),
    'ERROR: dist/governance/ not found. The package may be corrupted.\n',
  );
});

test('legacy init sanitizes governance write conflicts', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-init-write-conflict-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  const sensitiveDetail = 'controlled-init-filesystem-detail';

  const exitCode = await main(['init'], {
    cwd: () => projectDir,
    fs: {
      ...syncFilesystem,
      mkdirSync: () => { throw new Error(sensitiveDetail); },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(capture.readStderr(), 'ERROR: Could not create the Claude governance directory.\n');
  assert.doesNotMatch(capture.readStderr(), new RegExp(sensitiveDetail));
});

test('legacy init pins governance copies when its target is swapped', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-init-race-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-init-race-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const targetDir = join(projectDir, '.claude');
  const displacedTarget = join(projectDir, '.claude-before-swap');
  syncFilesystem.mkdirSync(targetDir);
  const governanceSource = fileURLToPath(new URL('../../dist/governance', import.meta.url));
  const governanceFiles = syncFilesystem.readdirSync(governanceSource);
  for (const file of governanceFiles) {
    syncFilesystem.writeFileSync(join(victimDir, file), 'victim-owned\n');
  }
  const capture = captureOutput();
  let swapped = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    openSync(path, flags, mode) {
      if (!swapped) {
        swapped = true;
        syncFilesystem.renameSync(targetDir, displacedTarget);
        syncFilesystem.symlinkSync(victimDir, targetDir, 'dir');
      }
      return syncFilesystem.openSync(path, flags, mode);
    },
  };

  const exitCode = await main(['init'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swapped, true);
  for (const file of governanceFiles) {
    assert.equal(syncFilesystem.readFileSync(join(victimDir, file), 'utf8'), 'victim-owned\n');
  }
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('legacy init rejects a target swapped immediately before pinning', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-init-prepin-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-init-prepin-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const canonicalProject = syncFilesystem.realpathSync(projectDir);
  const targetDir = join(canonicalProject, '.claude');
  syncFilesystem.mkdirSync(targetDir);
  const swap = createPrePinSwapFilesystem({
    displacedTarget: join(canonicalProject, '.claude-before-prepin-swap'),
    targetDir,
    victimDir,
  });
  const capture = captureOutput();

  const exitCode = await main(['init'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: swap.fs,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swap.wasSwapped(), true);
  assert.deepEqual(syncFilesystem.readdirSync(victimDir), []);
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('legacy init preserves unrelated nested symbolic links', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-init-unrelated-link-project-'));
  const linkedDir = await mkdtemp(join(tmpdir(), 'rivet-init-unrelated-link-target-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(linkedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await writeFile(join(linkedDir, 'marker.txt'), 'user-owned\n');
  const userDirectory = join(projectDir, '.claude', 'user-owned');
  syncFilesystem.mkdirSync(userDirectory, { recursive: true });
  const linkPath = join(userDirectory, 'nested-link');
  syncFilesystem.symlinkSync(linkedDir, linkPath, 'dir');
  const capture = captureOutput();

  const exitCode = await main(['init'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(syncFilesystem.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(syncFilesystem.readFileSync(join(linkedDir, 'marker.txt'), 'utf8'), 'user-owned\n');
});

test('JSON errors emit exactly one object to stderr and no stdout', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], { output: capture.output });

  assert.equal(exitCode, EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
  const payload = JSON.parse(capture.readStderr());
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.error, {
    code: 'MISSING_CONFIGURATION',
    exitCode: EXIT_CODES.MISSING_CONFIGURATION,
    message: 'Project configuration is missing or invalid.',
  });
});

test('a supported JSON handler emits exactly one object to stdout', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], {
    commands: {
      doctor: async (_parsed, dependencies) => {
        dependencies.output.json({ ok: true, command: 'doctor' });
        return EXIT_CODES.SUCCESS;
      },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(capture.readStdout().split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(capture.readStdout()), { ok: true, command: 'doctor' });
  assert.equal(capture.readStderr(), '');
});

test('JSON mode rejects decorative or multiple writes without leaking partial output', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], {
    commands: {
      doctor: async (_parsed, dependencies) => {
        try { dependencies.output.log('decorative'); } catch {}
        try { dependencies.output.json({ first: true }); } catch {}
        try { dependencies.output.json({ second: true }); } catch {}
        return EXIT_CODES.SUCCESS;
      },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(capture.readStderr()), {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      exitCode: EXIT_CODES.INTERNAL_ERROR,
      message: 'Unexpected rivet failure.',
    },
  });
});

test('JSON mode rejects values that do not serialize to an object', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const invalidPayloads = [
    undefined,
    null,
    'text',
    7,
    7n,
    [],
    cyclic,
    { toJSON: () => 'text' },
  ];

  for (const payload of invalidPayloads) {
    const capture = captureOutput();
    const exitCode = await main(['doctor', '--json'], {
      commands: {
        doctor: async (_parsed, dependencies) => {
          dependencies.output.json(payload);
          return EXIT_CODES.SUCCESS;
        },
      },
      output: capture.output,
    });

    assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
    assert.equal(capture.readStdout(), '');
    assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
    assert.equal(JSON.parse(capture.readStderr()).error.code, 'INTERNAL_ERROR');
  }
});

test('oversized machine JSON becomes one bounded internal-error object', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], {
    commands: {
      doctor: async (_parsed, dependencies) => {
        dependencies.output.json({ value: 'x'.repeat(MAX_JSON_OUTPUT_BYTES + 1) });
        return EXIT_CODES.SUCCESS;
      },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(capture.readStderr()).error.code, 'INTERNAL_ERROR');
  assert.equal(Buffer.byteLength(capture.readStderr(), 'utf8') < 1024, true);
});

test('oversized JSON error messages become one bounded internal-error object', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], {
    commands: {
      doctor: async () => {
        throw new CliError('x'.repeat(4096), 'INVALID_INPUT');
      },
    },
    maxJsonOutputBytes: 128,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(capture.readStderr()).error.code, 'INTERNAL_ERROR');
  assert.equal(Buffer.byteLength(capture.readStderr(), 'utf8') <= 128, true);
});

test('JSON mode rejects re-entrant writes during payload serialization', async () => {
  const capture = captureOutput();

  const exitCode = await main(['doctor', '--json'], {
    commands: {
      doctor: async (_parsed, dependencies) => {
        dependencies.output.json({
          toJSON() {
            dependencies.output.json({ nested: true });
            return { outer: true };
          },
        });
        return EXIT_CODES.SUCCESS;
      },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr().split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(capture.readStderr()).error.code, 'INTERNAL_ERROR');
});

test('missing distribution data selects the missing-configuration exit code', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-missing-dist-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
    packageRoot: projectDir,
  });

  assert.equal(exitCode, EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(capture.readStdout(), '');
  assert.equal(
    capture.readStderr(),
    "ERROR: dist/skills/ not found. Run 'npm run build' or reinstall the package.\n",
  );
});

test('repository write failures use a stable code without exposing raw details', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-write-conflict-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  const sensitiveDetail = 'controlled-filesystem-detail';
  const managedDirectory = join(projectDir, '.codex', 'skills', 'rivet-address-pr-feedback');
  syncFilesystem.mkdirSync(managedDirectory, { recursive: true });
  const unrelatedFile = join(managedDirectory, 'user-notes.txt');
  syncFilesystem.writeFileSync(unrelatedFile, 'user-owned\n');

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: {
      ...syncFilesystem,
      writeSync: () => { throw new Error(sensitiveDetail); },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.match(capture.readStderr(), /^ERROR: Failed to install mandatory skill '.+' to codex\.\n$/);
  assert.doesNotMatch(capture.readStderr(), new RegExp(sensitiveDetail));
  assert.equal(syncFilesystem.readFileSync(unrelatedFile, 'utf8'), 'user-owned\n');
  assert.equal(syncFilesystem.existsSync(join(managedDirectory, 'SKILL.md')), true);
});

test('failed package file overwrite restores the existing managed file', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-file-restoration-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const managedLeaf = join(
    syncFilesystem.realpathSync(projectDir),
    '.codex',
    'skills',
    'rivet-address-pr-feedback',
    'SKILL.md',
  );
  syncFilesystem.writeFileSync(managedLeaf, 'user-customized\n', { mode: 0o600 });
  syncFilesystem.chmodSync(managedLeaf, 0o600);
  let failed = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    writeSync(descriptor, buffer, offset, length, position) {
      const written = syncFilesystem.writeSync(descriptor, buffer, offset, length, position);
      if (!failed && process.cwd().endsWith(join('rivet-address-pr-feedback'))) {
        failed = true;
        const error = new Error('controlled-copy-failure');
        error.code = 'EIO';
        throw error;
      }
      return written;
    },
  };

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: captureOutput().output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(failed, true);
  assert.equal(syncFilesystem.readFileSync(managedLeaf, 'utf8'), 'user-customized\n');
  assert.equal(syncFilesystem.statSync(managedLeaf).mode & 0o777, 0o600);
});

test('managed file mode application stays bound to its opened file', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-mode-boundary-project-'));
  const isolatedDir = await mkdtemp(join(tmpdir(), 'rivet-mode-boundary-fixture-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(isolatedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const isolatedFile = join(isolatedDir, 'marker.txt');
  await writeFile(isolatedFile, 'user-owned\n', { mode: 0o600 });
  const managedLeaf = join(
    syncFilesystem.realpathSync(projectDir),
    '.codex',
    'skills',
    'rivet-address-pr-feedback',
    'SKILL.md',
  );
  let changed = false;
  const changeEntry = (path) => {
    if (changed) return;
    changed = true;
    syncFilesystem.rmSync(path, { force: true });
    syncFilesystem.symlinkSync(isolatedFile, path, 'file');
  };
  const guardedFilesystem = {
    ...syncFilesystem,
    openSync(path, flags, mode) {
      const descriptor = syncFilesystem.openSync(path, flags, mode);
      if (
        !changed
        && path === 'SKILL.md'
        && process.cwd().endsWith(join('rivet-address-pr-feedback'))
      ) {
        changeEntry(managedLeaf);
      }
      return descriptor;
    },
  };
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(changed, true);
  assert.equal(syncFilesystem.readFileSync(isolatedFile, 'utf8'), 'user-owned\n');
  assert.equal(syncFilesystem.statSync(isolatedFile).mode & 0o777, 0o600);
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(isolatedDir), false);
});

test('install pins the validated target when its parent is swapped during copy', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-copy-race-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-copy-race-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  const targetDir = join(projectDir, '.codex', 'skills');
  const displacedTarget = join(projectDir, '.codex', 'skills-before-swap');
  let swapped = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    openSync(path, flags, mode) {
      if (!swapped) {
        swapped = true;
        syncFilesystem.renameSync(targetDir, displacedTarget);
        syncFilesystem.symlinkSync(victimDir, targetDir, 'dir');
      }
      return syncFilesystem.openSync(path, flags, mode);
    },
  };

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swapped, true);
  assert.deepEqual(syncFilesystem.readdirSync(victimDir), []);
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('install rejects a target swapped immediately before pinning', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-prepin-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-install-prepin-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const canonicalProject = syncFilesystem.realpathSync(projectDir);
  const targetDir = join(canonicalProject, '.codex', 'skills');
  syncFilesystem.mkdirSync(targetDir, { recursive: true });
  const swap = createPrePinSwapFilesystem({
    displacedTarget: join(canonicalProject, '.codex', 'skills-before-prepin-swap'),
    targetDir,
    victimDir,
  });
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: swap.fs,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swap.wasSwapped(), true);
  assert.deepEqual(syncFilesystem.readdirSync(victimDir), []);
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('install preserves unrelated nested symbolic links', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-unrelated-link-project-'));
  const linkedDir = await mkdtemp(join(tmpdir(), 'rivet-install-unrelated-link-target-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(linkedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await writeFile(join(linkedDir, 'marker.txt'), 'user-owned\n');
  const userDirectory = join(projectDir, '.codex', 'skills', 'rivet-user-owned');
  syncFilesystem.mkdirSync(userDirectory, { recursive: true });
  const linkPath = join(userDirectory, 'nested-link');
  syncFilesystem.symlinkSync(linkedDir, linkPath, 'dir');
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(syncFilesystem.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(syncFilesystem.readFileSync(join(linkedDir, 'marker.txt'), 'utf8'), 'user-owned\n');
});

test('install preserves extra regular content in a selected managed directory', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-managed-extra-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const managedDirectory = join(projectDir, '.codex', 'skills', 'rivet-address-pr-feedback');
  syncFilesystem.mkdirSync(managedDirectory, { recursive: true });
  const extraFile = join(managedDirectory, 'user-notes.txt');
  await writeFile(extraFile, 'user-owned\n');
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(syncFilesystem.readFileSync(extraFile, 'utf8'), 'user-owned\n');
  assert.equal(syncFilesystem.existsSync(join(managedDirectory, 'SKILL.md')), true);
});

test('install preserves an unrelated nested link inside a selected managed directory', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-managed-extra-link-'));
  const isolatedDir = await mkdtemp(join(tmpdir(), 'rivet-install-managed-extra-target-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(isolatedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const managedDirectory = join(projectDir, '.codex', 'skills', 'rivet-address-pr-feedback');
  const extraDirectory = join(managedDirectory, 'user-notes');
  syncFilesystem.mkdirSync(extraDirectory, { recursive: true });
  await writeFile(join(isolatedDir, 'marker.txt'), 'user-owned\n');
  const linkPath = join(extraDirectory, 'reference');
  syncFilesystem.symlinkSync(isolatedDir, linkPath, 'dir');
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(syncFilesystem.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(syncFilesystem.readFileSync(join(isolatedDir, 'marker.txt'), 'utf8'), 'user-owned\n');
  assert.equal(syncFilesystem.existsSync(join(managedDirectory, 'SKILL.md')), true);
});

test('install rejects a nested symbolic link in the selected destination subtree', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-managed-link-project-'));
  const linkedDir = await mkdtemp(join(tmpdir(), 'rivet-install-managed-link-target-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(linkedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const externalFile = join(linkedDir, 'marker.txt');
  await writeFile(externalFile, 'user-owned\n');
  const targetRoot = join(projectDir, '.codex', 'skills');
  const managedDirectory = join(targetRoot, 'rivet-address-pr-feedback');
  syncFilesystem.mkdirSync(managedDirectory, { recursive: true });
  const linkPath = join(managedDirectory, 'SKILL.md');
  syncFilesystem.symlinkSync(externalFile, linkPath, 'file');
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(syncFilesystem.readdirSync(targetRoot), ['rivet-address-pr-feedback']);
  assert.deepEqual(syncFilesystem.readdirSync(managedDirectory), ['SKILL.md']);
  assert.equal(syncFilesystem.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(syncFilesystem.readFileSync(externalFile, 'utf8'), 'user-owned\n');
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(linkedDir), false);
});

test('install never writes through a managed leaf changed at the copy boundary', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-leaf-boundary-project-'));
  const linkedDir = await mkdtemp(join(tmpdir(), 'rivet-install-leaf-boundary-target-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(linkedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const externalFile = join(linkedDir, 'marker.txt');
  await writeFile(externalFile, 'user-owned\n');
  const managedLeaf = join(
    syncFilesystem.realpathSync(projectDir),
    '.codex',
    'skills',
    'rivet-address-pr-feedback',
    'SKILL.md',
  );
  let changed = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    openSync(path, flags, mode) {
      const descriptor = syncFilesystem.openSync(path, flags, mode);
      if (
        !changed
        && path === 'SKILL.md'
        && process.cwd().endsWith(join('rivet-address-pr-feedback'))
      ) {
        changed = true;
        syncFilesystem.rmSync(managedLeaf, { force: true });
        syncFilesystem.symlinkSync(externalFile, managedLeaf, 'file');
      }
      return descriptor;
    },
  };
  const capture = captureOutput();

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal([EXIT_CODES.SUCCESS, EXIT_CODES.REPOSITORY_CONFLICT].includes(exitCode), true);
  assert.equal(changed, true);
  assert.equal(syncFilesystem.readFileSync(externalFile, 'utf8'), 'user-owned\n');
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(linkedDir), false);
});

test('install pins directory creation when a validated parent is swapped', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-mkdir-race-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-mkdir-race-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const targetParent = join(projectDir, '.codex');
  const displacedParent = join(projectDir, '.codex-before-swap');
  syncFilesystem.mkdirSync(targetParent);
  const capture = captureOutput();
  let swapped = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    mkdirSync(path, options) {
      if (!swapped) {
        swapped = true;
        syncFilesystem.renameSync(targetParent, displacedParent);
        syncFilesystem.symlinkSync(victimDir, targetParent, 'dir');
      }
      return syncFilesystem.mkdirSync(path, options);
    },
  };

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swapped, true);
  assert.deepEqual(syncFilesystem.readdirSync(victimDir), []);
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('uninstall pins the validated target when its parent is swapped during removal', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-remove-race-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-remove-race-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const victimSkill = join(victimDir, 'rivet-address-pr-feedback', 'SKILL.md');
  syncFilesystem.mkdirSync(join(victimSkill, '..'), { recursive: true });
  syncFilesystem.writeFileSync(victimSkill, 'victim-owned\n');
  const capture = captureOutput();
  const targetDir = join(projectDir, '.codex', 'skills');
  const displacedTarget = join(projectDir, '.codex', 'skills-before-swap');
  let swapped = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    rmSync(path, options) {
      if (!swapped) {
        swapped = true;
        syncFilesystem.renameSync(targetDir, displacedTarget);
        syncFilesystem.symlinkSync(victimDir, targetDir, 'dir');
      }
      return syncFilesystem.rmSync(path, options);
    },
  };

  const exitCode = await main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swapped, true);
  assert.equal(syncFilesystem.readFileSync(victimSkill, 'utf8'), 'victim-owned\n');
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('uninstall rejects a target swapped immediately before pinning', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-prepin-project-'));
  const victimDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-prepin-victim-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(victimDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const victimSkill = join(victimDir, 'rivet-address-pr-feedback', 'SKILL.md');
  syncFilesystem.mkdirSync(join(victimSkill, '..'), { recursive: true });
  syncFilesystem.writeFileSync(victimSkill, 'victim-owned\n');
  const canonicalProject = syncFilesystem.realpathSync(projectDir);
  const targetDir = join(canonicalProject, '.codex', 'skills');
  const swap = createPrePinSwapFilesystem({
    displacedTarget: join(canonicalProject, '.codex', 'skills-before-prepin-swap'),
    targetDir,
    victimDir,
  });
  const capture = captureOutput();

  const exitCode = await main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: swap.fs,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(swap.wasSwapped(), true);
  assert.equal(syncFilesystem.readFileSync(victimSkill, 'utf8'), 'victim-owned\n');
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(victimDir), false);
});

test('uninstall does not remove a changed selected entry or unrelated content', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-entry-change-'));
  const isolatedDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-entry-fixture-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm(isolatedDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const targetDirectory = join(projectDir, '.codex', 'skills');
  const selectedName = 'rivet-address-pr-feedback';
  const displacedName = `${selectedName}-before-change`;
  const extraFile = join(targetDirectory, selectedName, 'user-notes.txt');
  syncFilesystem.writeFileSync(extraFile, 'user-owned\n');
  syncFilesystem.writeFileSync(join(isolatedDir, 'marker.txt'), 'isolated\n');
  let changed = false;
  const guardedFilesystem = {
    ...syncFilesystem,
    renameSync(source, destination) {
      if (
        !changed
        && source === selectedName
        && String(destination).startsWith('.rivet-uninstall-')
      ) {
        changed = true;
        syncFilesystem.renameSync(source, displacedName);
        syncFilesystem.symlinkSync(isolatedDir, source, 'dir');
      }
      return syncFilesystem.renameSync(source, destination);
    },
  };
  const capture = captureOutput();

  const exitCode = await main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(changed, true);
  assert.equal(syncFilesystem.readFileSync(join(isolatedDir, 'marker.txt'), 'utf8'), 'isolated\n');
  assert.equal(
    syncFilesystem.readFileSync(join(targetDirectory, displacedName, 'user-notes.txt'), 'utf8'),
    'user-owned\n',
  );
  assert.equal(
    syncFilesystem.readdirSync(targetDirectory).some(name => name.startsWith('.rivet-uninstall-')),
    false,
  );
  assert.equal(`${capture.readStdout()}${capture.readStderr()}`.includes(isolatedDir), false);
});

test('uninstall restores a selected entry when quarantine removal fails', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-remove-failure-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const targetDirectory = join(projectDir, '.codex', 'skills');
  const selectedName = 'rivet-address-pr-feedback';
  const extraFile = join(targetDirectory, selectedName, 'user-notes.txt');
  syncFilesystem.writeFileSync(extraFile, 'user-owned\n');
  let quarantineName;
  const guardedFilesystem = {
    ...syncFilesystem,
    renameSync(source, destination) {
      const result = syncFilesystem.renameSync(source, destination);
      if (
        source === selectedName
        && String(destination).startsWith('.rivet-uninstall-')
      ) {
        quarantineName = String(destination);
      }
      return result;
    },
    rmSync(path, options) {
      if (quarantineName && path === quarantineName) {
        throw new Error('controlled-quarantine-removal-failure');
      }
      return syncFilesystem.rmSync(path, options);
    },
  };

  const exitCode = await main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: guardedFilesystem,
    output: captureOutput().output,
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(typeof quarantineName, 'string');
  assert.equal(syncFilesystem.readFileSync(extraFile, 'utf8'), 'user-owned\n');
  assert.equal(
    syncFilesystem.readdirSync(targetDirectory).some(name => name.startsWith('.rivet-uninstall-')),
    false,
  );
});

test('successful uninstall leaves no private quarantine entries', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-clean-quarantine-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const targetDirectory = join(projectDir, '.codex', 'skills');

  const exitCode = await main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(
    syncFilesystem.readdirSync(targetDirectory).some(name => name.startsWith('.rivet-uninstall-')),
    false,
  );
});

test('governance distribution read failures are sanitized missing configuration', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-governance-read-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  const sensitiveDetail = 'controlled-governance-read-detail';

  const exitCode = await main(['install', '--all', '--target=claude'], {
    cwd: () => projectDir,
    fetch: async () => ({ ok: false }),
    fs: {
      ...syncFilesystem,
      readdirSync: (path, options) => {
        if (path.endsWith(join('dist', 'governance'))) throw new Error(sensitiveDetail);
        return syncFilesystem.readdirSync(path, options);
      },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(capture.readStderr(), 'ERROR: Could not read governance distribution data.\n');
  assert.doesNotMatch(capture.readStderr(), new RegExp(sensitiveDetail));
});

test('cancelled install does not start an update check', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-cancel-update-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  let fetchCalls = 0;

  const exitCode = await main(['install', '--target=codex'], {
    cwd: () => projectDir,
    fetch: async () => { fetchCalls += 1; return { ok: false }; },
    output: capture.output,
    prompt: async () => { throw new Error('cancelled'); },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(fetchCalls, 0);
  assert.match(capture.readStdout(), /Cancelled\./);
});

test('uninstall no-op does not start an update check', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-noop-update-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  let fetchCalls = 0;

  const exitCode = await main(['uninstall', '--all', '--target=claude'], {
    cwd: () => projectDir,
    fetch: async () => { fetchCalls += 1; return { ok: false }; },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(fetchCalls, 0);
  assert.match(capture.readStderr(), /Nothing to uninstall/);
});

test('successful install waits for its update check before returning', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-wait-update-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise(resolvePromise => { markFetchStarted = resolvePromise; });
  const fetchResult = new Promise(resolvePromise => { releaseFetch = resolvePromise; });
  let settled = false;

  const operation = main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fs: { ...syncFilesystem, readFileSync(path, ...args) {
      const contents = syncFilesystem.readFileSync(path, ...args);
      return String(path) === join(PACKAGE_ROOT, 'package.json') ? JSON.stringify({ name: '@agilno/rivet', version: '0.1.0', private: false }) : contents;
    } },
    fetch: () => {
      markFetchStarted();
      return fetchResult;
    },
    output: capture.output,
  });
  operation.then(() => { settled = true; });
  await fetchStarted;
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.equal(settled, false);
  releaseFetch({ ok: false });
  assert.equal(await operation, EXIT_CODES.SUCCESS);
  assert.equal(settled, true);
});

test('successful install aborts a hanging update check within its bound', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-install-update-timeout-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  let aborted = false;

  const operation = main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fs: { ...syncFilesystem, readFileSync(path, ...args) {
      const contents = syncFilesystem.readFileSync(path, ...args);
      return String(path) === join(PACKAGE_ROOT, 'package.json') ? JSON.stringify({ name: '@agilno/rivet', version: '0.1.0', private: false }) : contents;
    } },
    fetch: (_url, { signal }) => new Promise((_resolvePromise, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
    output: capture.output,
    updateCheckTimeoutMs: 20,
  });
  const exitCode = await withTimeout(operation, 2_000, 'install update check did not time out');

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(aborted, true);
  assert.equal(syncFilesystem.existsSync(join(projectDir, '.codex', 'skills', 'rivet-design')), true);
});

test('successful uninstall aborts a hanging update check within its bound', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-uninstall-update-timeout-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fs: { ...syncFilesystem, readFileSync(path, ...args) {
      const contents = syncFilesystem.readFileSync(path, ...args);
      return String(path) === join(PACKAGE_ROOT, 'package.json') ? JSON.stringify({ name: '@agilno/rivet', version: '0.1.0', private: false }) : contents;
    } },
    fetch: async () => ({ ok: false }),
    output: captureOutput().output,
  });
  const capture = captureOutput();
  let aborted = false;

  const operation = main(['uninstall', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fs: { ...syncFilesystem, readFileSync(path, ...args) {
      const contents = syncFilesystem.readFileSync(path, ...args);
      return String(path) === join(PACKAGE_ROOT, 'package.json') ? JSON.stringify({ name: '@agilno/rivet', version: '0.1.0', private: false }) : contents;
    } },
    fetch: (_url, { signal }) => new Promise((_resolvePromise, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
    output: capture.output,
    updateCheckTimeoutMs: 20,
  });
  const exitCode = await withTimeout(operation, 2_000, 'uninstall update check did not time out');

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(aborted, true);
  assert.equal(syncFilesystem.existsSync(join(projectDir, '.codex', 'skills', 'rivet-design')), false);
});

test('oversized update metadata is not read and does not affect successful mutation', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-update-oversized-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');
  const capture = captureOutput();
  let bodyRead = false;

  const exitCode = await main(['install', '--all', '--target=codex'], {
    cwd: () => projectDir,
    fs: { ...syncFilesystem, readFileSync(path, ...args) {
      const contents = syncFilesystem.readFileSync(path, ...args);
      return String(path) === join(PACKAGE_ROOT, 'package.json') ? JSON.stringify({ name: '@agilno/rivet', version: '0.1.0', private: false }) : contents;
    } },
    fetch: async () => ({
      ok: true,
      headers: { get: name => name.toLowerCase() === 'content-length' ? '1000000' : null },
      json: async () => {
        bodyRead = true;
        return { 'dist-tags': { latest: 'oversized' } };
      },
    }),
    maxUpdateResponseBytes: 128,
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(bodyRead, false);
  assert.doesNotMatch(capture.readStdout(), /Update available/);
  assert.equal(syncFilesystem.existsSync(join(projectDir, '.codex', 'skills', 'rivet-design')), true);
});

test('unknown commands use the structured invalid-input JSON path', async () => {
  const capture = captureOutput();

  const exitCode = await main(['unknown-command', '--json'], { output: capture.output });

  assert.equal(exitCode, EXIT_CODES.INVALID_INPUT);
  assert.equal(capture.readStdout(), '');
  assert.equal(JSON.parse(capture.readStderr()).error.code, 'INVALID_INPUT');
});

test('unexpected command errors expose only a safe message and stable code', async () => {
  const capture = captureOutput();
  const sensitiveDetail = 'sensitive-runtime-detail';

  const exitCode = await main(['install', '--all'], {
    commands: {
      install: async () => { throw new Error(sensitiveDetail); },
    },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr(), 'ERROR: Unexpected rivet failure.\n');
  assert.doesNotMatch(capture.readStderr(), new RegExp(sensitiveDetail));
  assert.doesNotMatch(capture.readStderr(), /at .*\(.+\)/);
});

test('invalid handler results become a safe internal error', async () => {
  const capture = captureOutput();

  const exitCode = await main(['install', '--all'], {
    commands: { install: async () => undefined },
    output: capture.output,
  });

  assert.equal(exitCode, EXIT_CODES.INTERNAL_ERROR);
  assert.equal(capture.readStdout(), '');
  assert.equal(capture.readStderr(), 'ERROR: Unexpected rivet failure.\n');
});
