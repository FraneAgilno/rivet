import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { setupCommand } from '../../src/commands/setup.js';
import { init } from '../../src/commands/init.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { CliError, EXIT_CODES } from '../../src/cli/output.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const validConfig = join(here, '..', 'fixtures', 'config', 'valid', '.rivet');

function captureOutput() {
  const writes = [];
  return {
    output: {
      json(value, stream = 'stdout') { writes.push({ value, stream }); },
      log(value) { writes.push({ value, stream: 'stdout' }); },
      error(value) { writes.push({ value, stream: 'stderr' }); },
    },
    writes,
  };
}

async function createProject(t, { scripts = { build: 'echo build', test: 'echo test' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'setup-fixture',
    private: true,
    scripts,
  }));
  return root;
}

function makeDependencies(root, capture, options = {}) {
  const calls = { inspect: [], install: [], init: [] };
  const tools = options.tools ?? {
    node: { present: true, version: '22.0.0' },
    npm: { present: true, version: '10.0.0' },
    git: { present: true, version: '2.45.0' },
  };
  const fakeInstall = options.install ?? (async (parsed, dependencies) => {
    calls.install.push(parsed);
    if (!parsed.flags.global) {
      assert.equal(parsed.flags.project, root);
      const skill = join(root, '.agents', 'skills', 'rivet');
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'minimal Rivet setup skill\n');
    }
    dependencies.output.json({
      ok: true,
      command: 'install',
      result: { status: 'installed', entries: ['rivet'] },
    });
    return EXIT_CODES.SUCCESS;
  });
  const fakeInspect = options.inspectInstall ?? (async parsed => {
    calls.inspect.push(parsed);
    return { ok: true, status: 'ready', entries: ['rivet'] };
  });
  const realInit = options.init ?? init;
  const setup = {
    inspectInstall: async (...args) => {
      if (options.inspectInstall) calls.inspect.push(args[0]);
      return fakeInspect(...args);
    },
    install: fakeInstall,
    init: async (...args) => {
      calls.init.push(args[0]);
      return realInit(...args);
    },
  };
  return {
    calls,
    dependencies: {
      fs: nodeFs,
      cwd: () => root,
      packageRoot,
      output: capture.output,
      gitDiscovery: async () => ({ repository: false, defaultBranch: 'main' }),
      toolDiscovery: async () => tools,
      setup,
    },
  };
}

function parsedSetup(root, flags = {}) {
  return {
    command: 'setup',
    subcommand: null,
    operands: [],
    flags: { project: root, target: 'codex', json: true, ...flags },
  };
}

async function runSetup(t, root, flags = {}, options = {}) {
  const capture = captureOutput();
  const { calls, dependencies } = makeDependencies(root, capture, options);
  const code = await setupCommand(parsedSetup(root, flags), dependencies);
  const publication = capture.writes.at(-1);
  return { code, result: publication?.value, calls, capture, dependencies };
}

test('setup preview is read-only and passes the exact project root to init and install inspection', async t => {
  const root = await createProject(t);
  const nested = join(root, 'packages', 'nested');
  await mkdir(nested, { recursive: true });
  const capture = captureOutput();
  const { calls, dependencies } = makeDependencies(root, capture);

  const code = await setupCommand({
    command: 'setup', subcommand: null, operands: [],
    flags: { project: root, target: 'codex', json: true },
  }, { ...dependencies, cwd: () => nested });

  assert.equal(code, EXIT_CODES.SUCCESS);
  const result = capture.writes.at(-1).value;
  assert.equal(result.status, 'preview');
  assert.equal(result.configuration.status, 'proposed');
  assert.equal(calls.inspect[0].flags.project, root);
  assert.equal(calls.inspect[0].flags.minimal, true);
  assert.equal(calls.inspect[0].flags.global, undefined);
  assert.equal(calls.init.length, 1);
  assert.equal(calls.init[0].flags.project, root);
  await assert.rejects(() => lstat(join(root, '.rivet')));
  await assert.rejects(() => lstat(join(root, '.agents')));
  await assert.rejects(() => lstat(join(nested, '.rivet')));
});

test('human setup preview explains that no files were written', async t => {
  const root = await createProject(t);
  const capture = captureOutput();
  const { dependencies } = makeDependencies(root, capture);

  const code = await setupCommand({
    command: 'setup', subcommand: null, operands: [],
    flags: { project: root, target: 'codex' },
  }, dependencies);

  assert.equal(code, EXIT_CODES.SUCCESS);
  assert.ok(capture.writes.some(({ value, stream }) => stream === 'stdout' && /Setup preview: no files were written\./.test(value)));
  await assert.rejects(() => lstat(join(root, '.rivet')));
});

test('setup --write creates a valid project configuration and one minimal harness entry', async t => {
  const root = await createProject(t);
  const result = await runSetup(t, root, { write: true });

  assert.equal(result.code, EXIT_CODES.SUCCESS);
  assert.equal(result.result.status, 'configured');
  assert.equal(result.result.configuration.status, 'written');
  assert.equal(result.result.installation.result.status, 'installed');
  assert.deepEqual(result.calls.install[0].flags, {
    minimal: true,
    target: 'codex',
    project: root,
    json: true,
  });
  await loadProjectConfig(root);
  assert.equal(await readFile(join(root, '.agents', 'skills', 'rivet', 'SKILL.md'), 'utf8'), 'minimal Rivet setup skill\n');
});

test('setup defaults to both harness targets', async t => {
  const root = await createProject(t);
  const capture = captureOutput();
  const { calls, dependencies } = makeDependencies(root, capture);

  const code = await setupCommand({
    command: 'setup', subcommand: null, operands: [],
    flags: { project: root, json: true },
  }, dependencies);

  assert.equal(code, EXIT_CODES.SUCCESS);
  assert.equal(calls.inspect[0].flags.target, 'both');
  assert.equal(calls.init[0].flags.project, root);
  assert.equal(capture.writes.at(-1).value.target, 'both');
});

test('rerunning setup preserves an edited valid configuration and skips init replacement', async t => {
  const root = await createProject(t);
  const first = await runSetup(t, root, { write: true });
  assert.equal(first.code, EXIT_CODES.SUCCESS);

  const projectPath = join(root, '.rivet', 'project.yaml');
  const edited = (await readFile(projectPath, 'utf8')).replace('name: setup-fixture', 'name: user-owned-config');
  await writeFile(projectPath, edited);

  const second = await runSetup(t, root, { write: true });
  assert.equal(second.code, EXIT_CODES.SUCCESS);
  assert.equal(second.result.status, 'configured');
  assert.equal(second.result.configuration.status, 'preserved');
  assert.equal(await readFile(projectPath, 'utf8'), edited);
  assert.equal(second.calls.init.length, 0);
  await loadProjectConfig(root);
});

test('setup refuses partial, invalid, and symlinked project configuration before writing it', async t => {
  await t.test('partial configuration', async t2 => {
    const root = await createProject(t2);
    await mkdir(join(root, '.rivet'));
    await writeFile(join(root, '.rivet', 'project.yaml'), 'schemaVersion: 1\n');
    const capture = captureOutput();
    const { calls, dependencies } = makeDependencies(root, capture);

    await assert.rejects(
      () => setupCommand(parsedSetup(root, { write: true }), dependencies),
      error => error.code === 'REPOSITORY_CONFLICT' && /incomplete/i.test(error.message),
    );
    assert.equal(calls.init.length, 0);
    assert.equal(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), 'schemaVersion: 1\n');
  });

  await t.test('invalid complete configuration', async t2 => {
    const root = await createProject(t2);
    await cp(validConfig, join(root, '.rivet'), { recursive: true });
    await writeFile(join(root, '.rivet', 'project.yaml'), 'schemaVersion: 1\nid: invalid\n');
    const capture = captureOutput();
    const { calls, dependencies } = makeDependencies(root, capture);

    await assert.rejects(
      () => setupCommand(parsedSetup(root, { write: true }), dependencies),
      error => error.code === 'REPOSITORY_CONFLICT' && /invalid/i.test(error.message),
    );
    assert.equal(calls.init.length, 0);
    assert.equal(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), 'schemaVersion: 1\nid: invalid\n');
  });

  await t.test('symlinked configuration', async t2 => {
    const root = await createProject(t2);
    const external = await mkdtemp(join(tmpdir(), 'rivet-setup-victim-'));
    t2.after(() => rm(external, { recursive: true, force: true }));
    await symlink(external, join(root, '.rivet'), 'dir');
    const capture = captureOutput();
    const { calls, dependencies } = makeDependencies(root, capture);

    await assert.rejects(
      () => setupCommand(parsedSetup(root, { write: true }), dependencies),
      error => error.code === 'REPOSITORY_CONFLICT' && /regular directory/i.test(error.message),
    );
    assert.equal(calls.init.length, 0);
    assert.deepEqual(await readdir(external), []);
  });
});

test('global setup never mutates the project and passes global minimal install scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-setup-global-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = captureOutput();
  const calls = [];
  const { dependencies } = makeDependencies(root, capture, {
    inspectInstall: async parsed => ({ ok: true, status: 'ready', global: parsed.flags.global }),
    install: async (parsed, dependencies) => {
      calls.push(parsed);
      dependencies.output.json({ ok: true, command: 'install', result: { status: 'installed', global: parsed.flags.global } });
      return EXIT_CODES.SUCCESS;
    },
  });

  const code = await setupCommand({
    command: 'setup', subcommand: null, operands: [],
    flags: { global: true, target: 'both', write: true, json: true },
  }, dependencies);

  assert.equal(code, EXIT_CODES.SUCCESS);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].flags, { minimal: true, target: 'both', global: true, json: true });
  await assert.rejects(() => lstat(join(root, '.rivet')));
  await assert.rejects(() => lstat(join(root, '.agents')));
  await assert.rejects(() => lstat(join(root, '.claude')));
});

test('install collision preflight prevents configuration writes', async t => {
  const root = await createProject(t);
  const capture = captureOutput();
  const collision = new CliError('Managed harness target is occupied.', 'REPOSITORY_CONFLICT');
  const { calls, dependencies } = makeDependencies(root, capture, {
    inspectInstall: async () => { throw collision; },
  });

  await assert.rejects(() => setupCommand(parsedSetup(root, { write: true }), dependencies), error => {
    assert.equal(error, collision);
    return true;
  });
  assert.equal(calls.init.length, 0);
  assert.equal(calls.install.length, 0);
  await assert.rejects(() => lstat(join(root, '.rivet')));
});

test('late install failure reports partial setup while retaining valid configuration', async t => {
  const root = await createProject(t);
  const capture = captureOutput();
  const { calls, dependencies } = makeDependencies(root, capture, {
    install: async parsed => {
      calls.install.push(parsed);
      const skill = join(root, '.agents', 'skills', 'rivet');
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'partially installed\n');
      throw new Error('injected installer failure');
    },
  });

  const code = await setupCommand(parsedSetup(root, { write: true }), dependencies);
  const result = capture.writes.at(-1).value;
  assert.equal(code, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(result.status, 'partial');
  assert.equal(result.configurationWritten, true);
  await loadProjectConfig(root);
  assert.equal(await readFile(join(root, '.agents', 'skills', 'rivet', 'SKILL.md'), 'utf8'), 'partially installed\n');
});

test('missing build and test scripts remain visible but do not block first-time setup', async t => {
  const root = await createProject(t, { scripts: {} });
  const result = await runSetup(t, root, { write: true });

  assert.equal(result.code, EXIT_CODES.SUCCESS);
  assert.equal(result.result.status, 'configured');
  assert.deepEqual(result.result.blockers, []);
  assert.equal(result.result.warnings.length, 2);
  assert.match(result.result.warnings.join('\n'), /'build'/);
  assert.match(result.result.warnings.join('\n'), /'test'/);
  assert.doesNotMatch(result.result.warnings.join('\n'), /build\[|test\[/);
  assert.match(result.result.nextSteps.join('\n'), /build|test/);
  assert.equal(result.calls.install.length, 1);
  await loadProjectConfig(root);
  assert.equal(await readFile(join(root, '.agents', 'skills', 'rivet', 'SKILL.md'), 'utf8'), 'minimal Rivet setup skill\n');
});

test('parser accepts minimal project-scoped install/uninstall and rejects invalid combinations', () => {
  assert.deepEqual(parseArgs(['install', '--minimal', '--project', '/repo', '--target=codex']).flags, {
    minimal: true,
    project: '/repo',
    target: 'codex',
  });
  assert.deepEqual(parseArgs(['uninstall', '--minimal', '--project=/repo', '--target=both']).flags, {
    minimal: true,
    project: '/repo',
    target: 'both',
  });
  assert.throws(() => parseArgs(['install', '--project=/repo']), /--project requires --minimal/);
  assert.throws(() => parseArgs(['uninstall', '--minimal', '--all']), /--minimal and --all cannot be combined/);
  assert.throws(() => parseArgs(['install', '--minimal', '--global', '--project=/repo']), /--global and --project cannot be combined/);
  assert.throws(() => parseArgs(['setup', '--global', '--project=/repo']), /--global and --project cannot be combined/);
});
