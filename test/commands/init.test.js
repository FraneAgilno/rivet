import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { discoverProject } from '../../src/discovery/project.js';
import { discoverGit } from '../../src/discovery/git.js';
import { discoverTools, runArgv, SUPPORTED_NODE_MAJOR } from '../../src/discovery/tools.js';
import { init } from '../../src/commands/init.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'projects', 'nextjs');

function outputCapture() {
  const writes = [];
  return {
    output: createOutput({
      stdout: { write: value => writes.push(['stdout', value]) },
      stderr: { write: value => writes.push(['stderr', value]) },
    }),
    writes,
  };
}

function gitRunner(responses) {
  return async (_command, args) => ({ code: 0, stdout: responses[args.join(' ')] ?? '', stderr: '' });
}

test('discovers bounded Next.js/npm metadata, scripts, Storybook, and Playwright with provenance', async () => {
  const result = await discoverProject(fixture);

  assert.deepEqual(result.proposal.stack, {
    framework: 'nextjs',
    language: 'typescript',
    packageManager: 'npm',
  });
  assert.deepEqual(result.proposal.commands.build, ['npm', 'run', 'build']);
  assert.deepEqual(result.proposal.commands.test, ['npm', 'run', 'test']);
  assert.equal(result.features.storybook, true);
  assert.equal(result.features.playwright, true);
  assert.ok(result.provenance['stack.framework'].includes('package.json'));
  assert.ok(result.provenance['commands.build'].includes('package.json'));
});

test('rejects symlinked, nonregular, and oversized package manifests', async t => {
  await t.test('symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-project-'));
    const source = join(root, 'source.json');
    await writeFile(source, '{}');
    await symlink(source, join(root, 'package.json'));
    await assert.rejects(() => discoverProject(root), /regular bounded file/);
  });
  await t.test('oversized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-project-'));
    await writeFile(join(root, 'package.json'), `{"padding":"${'x'.repeat(300_000)}"}`);
    await assert.rejects(() => discoverProject(root), /regular bounded file/);
  });
});

test('strictly bounds and UTF-8 validates package manifest reads after identity capture', async t => {
  await t.test('invalid UTF-8', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-project-'));
    await writeFile(join(root, 'package.json'), Buffer.from([0xff, 0xfe]));
    await assert.rejects(() => discoverProject(root), /valid bounded JSON/);
  });
  await t.test('same-inode growth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-project-'));
    const manifest = join(root, 'package.json');
    await writeFile(manifest, '{"name":"bounded"}');
    const canonicalManifest = nodeFs.realpathSync(manifest);
    let grew = false;
    let unboundedRead = false;
    const injectedFs = {
      ...nodeFs,
      openSync(path, flags) {
        if (!grew && path === canonicalManifest) {
          grew = true;
          nodeFs.appendFileSync(manifest, 'x'.repeat(300_000));
        }
        return nodeFs.openSync(path, flags);
      },
      readFileSync(path, options) {
        if (typeof path === 'number') unboundedRead = true;
        return nodeFs.readFileSync(path, options);
      },
    };
    await assert.rejects(() => discoverProject(root, { fs: injectedFs }), /valid bounded JSON/);
    assert.equal(unboundedRead, false);
  });
});

test('rejects symlink ancestors for every nested allowlisted discovery path', async t => {
  for (const [parent, leaf] of [
    ['.storybook', 'main.js'],
    ['.github', 'copilot-instructions.md'],
  ]) {
    await t.test(parent, async () => {
      const root = await mkdtemp(join(tmpdir(), 'agilno-project-'));
      const external = await mkdtemp(join(tmpdir(), 'agilno-external-'));
      await writeFile(join(root, 'package.json'), '{"name":"safe-project","scripts":{"build":"x","test":"x"}}');
      await writeFile(join(external, leaf), 'external content must not be discovered');
      await symlink(external, join(root, parent), 'dir');
      await assert.rejects(() => discoverProject(root), /allowlisted path|symbolic link ancestor/);
    });
  }
});

test('discovers default branch, dirty worktree, detached HEAD, freshness, and occupied paths without mutation', async () => {
  const result = await discoverGit('/project', {
    runner: gitRunner({
      'rev-parse --show-toplevel': '/project\n',
      'symbolic-ref --quiet --short HEAD': '',
      'status --porcelain': ' M package.json\n',
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main\n',
      'rev-list --left-right --count main...refs/remotes/origin/main': '2\t0\n',
      'worktree list --porcelain -z': 'worktree /project\0HEAD abc\0branch refs/heads/main\0\0worktree /project/.worktrees/task\0HEAD def\0branch refs/heads/task\0\0',
    }),
    candidatePaths: ['/project/.worktrees/task', '/project/.worktrees/free'],
  });

  assert.equal(result.repository, true);
  assert.equal(result.defaultBranch, 'main');
  assert.equal(result.detached, true);
  assert.equal(result.dirty, true);
  assert.equal(result.baseFreshness, 'ahead');
  assert.deepEqual(result.occupiedCandidatePaths, ['/project/.worktrees/task']);
  assert.deepEqual(result.worktreeCheck, { checked: true });
});

test('fails closed when worktree discovery fails, times out, or is malformed', async t => {
  for (const [name, worktreeResult, error] of [
    ['failure', { code: 1, stdout: '', stderr: 'inert-sensitive-detail' }, 'unavailable'],
    ['timeout', { code: 1, stdout: '', stderr: '', timedOut: true }, 'timeout'],
    ['malformed', { code: 0, stdout: 'branch refs/heads/main\0\0', stderr: '' }, 'malformed'],
  ]) {
    await t.test(name, async () => {
      const result = await discoverGit('/project', {
        runner: async (_command, args) => {
          const key = args.join(' ');
          if (key === 'rev-parse --show-toplevel') return { code: 0, stdout: '/project\n', stderr: '' };
          if (key === 'symbolic-ref --quiet --short HEAD') return { code: 0, stdout: 'main\n', stderr: '' };
          if (key === 'status --porcelain') return { code: 0, stdout: '', stderr: '' };
          if (key === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { code: 0, stdout: 'origin/main\n', stderr: '' };
          if (key.startsWith('rev-list ')) return { code: 0, stdout: '0\t0\n', stderr: '' };
          return worktreeResult;
        },
        candidatePaths: ['/project/.worktrees/task'],
      });
      assert.deepEqual(result.worktreeCheck, { checked: false, error });
      assert.equal(result.occupiedCandidatePaths, null);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-detail/);
    });
  }
});

test('reports tool presence and explicit Node support threshold with argv-only runners', async () => {
  const calls = [];
  const result = await discoverTools({ packageManager: 'npm', playwright: true, storybook: true }, {
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      const versions = { node: `v${SUPPORTED_NODE_MAJOR}.1.0\n`, npm: '10.8.0\n', git: 'git version 2.45.0\n' };
      return { code: 0, stdout: versions[command] ?? '', stderr: '' };
    },
  });

  assert.equal(result.node.compatible, true);
  assert.equal(result.npm.present, true);
  assert.equal(result.git.present, true);
  assert.equal(result.playwright.relevant, true);
  assert.equal(result.storybook.relevant, true);
  assert.ok(calls.every(call => Array.isArray(call.args) && call.options.shell === false));
});

test('reports unsupported Node versions', async () => {
  const result = await discoverTools({}, {
    runner: async command => ({
      code: 0,
      stdout: command === 'node' ? `v${SUPPORTED_NODE_MAJOR - 1}.9.0\n` : '1.0.0\n',
      stderr: '',
    }),
  });
  assert.equal(result.node.present, true);
  assert.equal(result.node.compatible, false);
});

test('supports Node 18 and rejects Node 17 for the v2 runtime contract', async t => {
  for (const [major, supported] of [[18, true], [17, false]]) {
    await t.test(`Node ${major}`, async () => {
      const result = await discoverTools({}, {
        runner: async command => ({
          code: 0,
          stdout: command === 'node' ? `v${major}.0.0\n` : '1.0.0\n',
          stderr: '',
        }),
      });
      assert.equal(result.node.supported, supported);
    });
  }
});

test('maps package-manager executables explicitly by platform without a shell', async t => {
  for (const [platform, manager, expected] of [
    ['win32', 'npm', 'npm.cmd'],
    ['win32', 'pnpm', 'pnpm.cmd'],
    ['win32', 'yarn', 'yarn.cmd'],
    ['win32', 'bun', 'bun.exe'],
    ['linux', 'npm', 'npm'],
  ]) {
    await t.test(`${platform} ${manager}`, async () => {
      const calls = [];
      await discoverTools({ packageManager: manager }, {
        platform,
        runner: async (command, args, options) => {
          calls.push({ command, args, options });
          return { code: 0, stdout: command === 'node' ? 'v18.0.0\n' : '1.0.0\n', stderr: '' };
        },
      });
      assert.equal(calls[1].command, expected);
      assert.ok(calls.every(call => call.options.shell === false));
    });
  }
});

test('caps multibyte stdout and stderr by explicit per-stream and combined byte budgets', async () => {
  const result = await runArgv(process.execPath, [
    '-e',
    "process.stdout.write('🙂'.repeat(8)); process.stderr.write('é'.repeat(8));",
  ], {
    maxOutputBytes: 16,
    maxStreamOutputBytes: 8,
  });

  const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
  assert.ok(stdoutBytes <= 8, `stdout used ${stdoutBytes} bytes`);
  assert.ok(stderrBytes <= 8, `stderr used ${stderrBytes} bytes`);
  assert.ok(stdoutBytes + stderrBytes <= 16);
  assert.doesNotMatch(result.stdout + result.stderr, /�/);
  assert.deepEqual(result.truncated, { stdout: true, stderr: true });
});

test('read-only init proposes four schema-valid files without modifying the fixture', async () => {
  const before = await lstat(join(fixture, 'package.json'));
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: fixture, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal((await lstat(join(fixture, 'package.json'))).mtimeMs, before.mtimeMs);
  await assert.rejects(() => lstat(join(fixture, '.rivet')));
  const result = JSON.parse(capture.writes[0][1]);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.proposal.files).sort(), [
    'orchestration.yaml', 'project.yaml', 'providers.yaml', 'quality.yaml',
  ]);
});

test('strictly bounds and UTF-8 validates templates and existing diff inputs', async t => {
  await t.test('invalid template UTF-8', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'agilno-package-'));
    await cp(join(here, '..', '..', 'templates'), join(packageRoot, 'templates'), { recursive: true });
    await writeFile(join(packageRoot, 'templates', 'project', '.rivet', 'project.yaml'), Buffer.from([0xff]));
    const capture = outputCapture();
    const exitCode = await init({ flags: { project: fixture, json: true } }, {
      output: capture.output, packageRoot,
      gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
    });
    assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  });
  await t.test('same-inode template growth uses bounded descriptor reads', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'agilno-package-'));
    await cp(join(here, '..', '..', 'templates'), join(packageRoot, 'templates'), { recursive: true });
    const target = join(packageRoot, 'templates', 'project', '.rivet', 'project.yaml');
    const canonicalTarget = nodeFs.realpathSync(target);
    let grew = false;
    let unboundedRead = false;
    const injectedFs = {
      ...nodeFs,
      openSync(path, flags) {
        if (!grew && path === canonicalTarget) { grew = true; nodeFs.appendFileSync(target, 'x'.repeat(300_000)); }
        return nodeFs.openSync(path, flags);
      },
      readFileSync(path, options) {
        if (typeof path === 'number') unboundedRead = true;
        return nodeFs.readFileSync(path, options);
      },
    };
    const capture = outputCapture();
    const exitCode = await init({ flags: { project: fixture, json: true } }, {
      output: capture.output, packageRoot, fs: injectedFs,
      gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
    });
    assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
    assert.equal(unboundedRead, false);
  });
  await t.test('invalid existing config UTF-8 is rejected before diffing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
    await cp(fixture, root, { recursive: true });
    await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
    await writeFile(join(root, '.rivet', 'project.yaml'), Buffer.from([0xff]));
    const capture = outputCapture();
    const exitCode = await init({ flags: { project: root, json: true } }, {
      output: capture.output,
      gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
    });
    assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  });
  await t.test('same-inode existing config growth uses bounded descriptor reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
    await cp(fixture, root, { recursive: true });
    await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
    const target = join(root, '.rivet', 'project.yaml');
    let grew = false;
    let unboundedRead = false;
    const injectedFs = {
      ...nodeFs,
      openSync(path, flags) {
        if (!grew && path === target) { grew = true; nodeFs.appendFileSync(target, 'x'.repeat(300_000)); }
        return nodeFs.openSync(path, flags);
      },
      readFileSync(path, options) {
        if (typeof path === 'number') unboundedRead = true;
        return nodeFs.readFileSync(path, options);
      },
    };
    const capture = outputCapture();
    const exitCode = await init({ flags: { project: root, json: true } }, {
      output: capture.output, fs: injectedFs,
      gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
    });
    assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
    assert.equal(unboundedRead, false);
  });
});

test('read-only init reports Git counts and states without exposing absolute worktree paths', async () => {
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: fixture, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({
      repository: true,
      root: '/sensitive/repository/path',
      defaultBranch: 'main',
      currentBranch: 'feature/test',
      dirty: false,
      detached: false,
      baseFreshness: 'fresh',
      worktrees: ['/sensitive/repository/path', '/sensitive/other/path'],
      occupiedCandidatePaths: ['/sensitive/other/path'],
    }),
    toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.doesNotMatch(capture.writes[0][1], /\/sensitive\//);
  const git = JSON.parse(capture.writes[0][1]).discovery.git;
  assert.equal(git.worktreeCount, 2);
  assert.equal(git.occupiedCandidateCount, 1);
});

function leafPaths(value, prefix, paths = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leafPaths(item, `${prefix}[${index}]`, paths));
  } else if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key, paths));
  } else {
    paths.push(prefix);
  }
  return paths;
}

test('provides structured provenance for every proposed configuration leaf', async () => {
  const capture = outputCapture();
  await init({ command: 'init', flags: { project: fixture, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ repository: true, defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });
  const proposal = JSON.parse(capture.writes[0][1]).proposal;
  const config = Object.fromEntries(Object.entries(proposal.files).map(([filename, source]) => [
    filename.replace('.yaml', ''), YAML.parse(source),
  ]));
  const leaves = leafPaths(config, '');
  assert.ok(leaves.length > 40);
  for (const path of leaves) {
    assert.ok(Object.hasOwn(proposal.provenance, path), `missing provenance for ${path}`);
    assert.equal(typeof proposal.provenance[path].source, 'string', path);
    assert.match(proposal.provenance[path].kind, /^(?:detected|inferred|template|default)$/);
    assert.match(proposal.provenance[path].confidence, /^(?:high|medium|low|exact)$/);
  }
  assert.equal(proposal.provenance['project.repository.defaultBranch'].source, 'local git metadata');
  assert.equal(proposal.provenance['quality.expectations.storybook'].kind, 'inferred');
  assert.equal(proposal.provenance['project.commands.build[2]'].source, 'package.json#scripts');
  assert.equal(proposal.provenance['providers.providers[0].id'].kind, 'template');
});

test('labels package-name and default-branch fallbacks with their actual low-confidence sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fallback-project-'));
  await writeFile(join(root, 'package.json'), '{"scripts":{"build":"x","test":"x"}}');
  const capture = outputCapture();
  await init({ command: 'init', flags: { project: root, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ repository: false, defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });
  const provenance = JSON.parse(capture.writes[0][1]).proposal.provenance;
  assert.deepEqual(provenance['project.name'], {
    source: 'project directory basename', kind: 'inferred', confidence: 'low',
  });
  assert.deepEqual(provenance['project.id'], {
    source: 'project directory basename', kind: 'inferred', confidence: 'low',
  });
  assert.deepEqual(provenance['project.repository.defaultBranch'], {
    source: 'templates/project/.rivet/project.yaml', kind: 'default', confidence: 'low',
  });
});

test('labels Git-discovered default main without branch evidence as a low-confidence template default', async () => {
  const capture = outputCapture();
  await init({ flags: { project: fixture, json: true } }, {
    output: capture.output,
    gitDiscovery: async () => ({ repository: true, defaultBranch: 'main', defaultBranchSource: 'default' }),
    toolDiscovery: async () => ({}),
  });
  assert.deepEqual(JSON.parse(capture.writes[0][1]).proposal.provenance['project.repository.defaultBranch'], {
    source: 'templates/project/.rivet/project.yaml', kind: 'default', confidence: 'low',
  });
});

test('write creates all four files, validates them, and leaks no secret or provenance into YAML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  const secret = 'inert-test-secret-never-write';
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    env: { GITHUB_TOKEN: secret },
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  await loadProjectConfig(root);
  for (const filename of ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml']) {
    const source = await readFile(join(root, '.rivet', filename), 'utf8');
    assert.doesNotMatch(source, new RegExp(secret));
    assert.doesNotMatch(source, /provenance/i);
  }
});

test('preserves existing config unless write and overwrite are both explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await writeFile(join(root, '.rivet'), 'occupied');
  const capture = outputCapture();

  const exitCode = await init({ command: 'init', flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(await readFile(join(root, '.rivet'), 'utf8'), 'occupied');
});

test('explicit write and overwrite replaces a complete existing configuration atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const capture = outputCapture();

  const exitCode = await init({ command: 'init', flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const config = await loadProjectConfig(root);
  assert.equal(config.project.id, 'nextjs-example');
  assert.equal(JSON.parse(capture.writes[0][1]).status, 'written');
  assert.deepEqual(nodeFs.readdirSync(join(root, '.rivet')).sort(), [
    'orchestration.yaml', 'project.yaml', 'providers.yaml', 'quality.yaml',
  ]);
});

test('interactive cancellation preserves every existing configuration byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const before = await readFile(join(root, '.rivet', 'project.yaml'), 'utf8');
  const capture = outputCapture();

  const exitCode = await init({ command: 'init', flags: { project: root, write: true } }, {
    output: capture.output,
    env: {},
    confirmOverwrite: async () => false,
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), before);
});

test('rolls back all owned files when an injected atomic rename fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  const injectedFs = {
    ...nodeFs,
    renameSync(source, destination) {
      if (String(source).includes('.rivet-stage-')) throw new Error('injected failure');
      return nodeFs.renameSync(source, destination);
    },
  };
  const capture = outputCapture();

  const exitCode = await init({ command: 'init', flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    env: {},
    fs: injectedFs,
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  await assert.rejects(() => lstat(join(root, '.rivet')));
});

test('exclusive init lock rejects concurrent writers without breaking or leaking lock metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(join(root, '.rivet-init.lock'));
  await writeFile(join(root, '.rivet-init.lock', 'owner.json'), '{"createdAt":"old","pid":1}');
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(await readFile(join(root, '.rivet-init.lock', 'owner.json'), 'utf8'), '{"createdAt":"old","pid":1}');
  await assert.rejects(() => lstat(join(root, '.rivet')));
  const payload = JSON.parse(capture.writes[0][1]);
  assert.match(payload.recovery.remediation, /lock/i);
  assert.doesNotMatch(capture.writes[0][1], new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('identity revalidation preserves a noncooperative late writer and returns conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  const late = 'late writer content\n';
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    beforePublish() {
      nodeFs.mkdirSync(join(root, '.rivet'));
      nodeFs.writeFileSync(join(root, '.rivet', 'project.yaml'), late, { flag: 'wx' });
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), late);
  assert.deepEqual(nodeFs.readdirSync(join(root, '.rivet')), ['project.yaml']);
});

test('revalidates a late writer at the first mutation boundary after bulk validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  const late = 'boundary late writer\n';
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    beforeFirstMutation() {
      nodeFs.mkdirSync(join(root, '.rivet'));
      nodeFs.writeFileSync(join(root, '.rivet', 'project.yaml'), late, { flag: 'wx' });
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'), late);
  assert.deepEqual(nodeFs.readdirSync(join(root, '.rivet')), ['project.yaml']);
});

test('preserves an in-place same-inode write at the first mutation boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const target = join(root, '.rivet', 'project.yaml');
  const identity = await lstat(target);
  const late = 'same inode late content\n';
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    beforeFirstMutation() { nodeFs.writeFileSync(target, late); },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal((await lstat(target)).ino, identity.ino);
  assert.equal(await readFile(target, 'utf8'), late);
  assert.equal(nodeFs.readdirSync(root).filter(name => name.startsWith('.rivet-backup-')).length, 0);
});

test('rejects an in-place same-inode staged rewrite before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    beforeFirstMutation() {
      const [name] = nodeFs.readdirSync(root).filter(entry => entry.startsWith('.rivet-stage-'));
      assert.ok(name);
      const staged = join(root, name, 'project.yaml');
      const source = nodeFs.readFileSync(staged, 'utf8');
      nodeFs.writeFileSync(staged, source.replace('name: nextjs-example', 'name: altered-stage'));
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  await assert.rejects(() => lstat(join(root, '.rivet')));
  assert.ok(JSON.parse(capture.writes[0][1]).recovery.residueCount > 0);
});

test('does not move originals through a replaced sibling transaction at the publish boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  const external = await mkdtemp(join(tmpdir(), 'agilno-external-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const filenames = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];
  const before = await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8')));
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    beforeFirstMutation() {
      const [name] = nodeFs.readdirSync(root).filter(entry => entry.startsWith('.rivet-stage-'));
      assert.ok(name);
      const transaction = join(root, name);
      nodeFs.renameSync(transaction, `${transaction}.owned`);
      nodeFs.symlinkSync(external, transaction, 'dir');
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8'))), before);
  assert.deepEqual(nodeFs.readdirSync(external), []);
});

test('restores originals when the staged directory is replaced immediately before publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  const external = await mkdtemp(join(tmpdir(), 'agilno-external-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const filenames = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];
  const before = await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8')));
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    beforePublishRename() {
      const [name] = nodeFs.readdirSync(root).filter(entry => entry.startsWith('.rivet-stage-'));
      assert.ok(name);
      const stage = join(root, name);
      nodeFs.renameSync(stage, `${stage}.owned`);
      nodeFs.symlinkSync(external, stage, 'dir');
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8'))), before);
  assert.deepEqual(nodeFs.readdirSync(external), []);
  assert.ok(JSON.parse(capture.writes[0][1]).recovery.residueCount > 0);
});

test('restores an in-place modified backup detected before publishing the staged directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const originalIdentity = await lstat(join(root, '.rivet', 'project.yaml'));
  const late = 'late backup before publish\n';
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    beforePublishRename() {
      const [name] = nodeFs.readdirSync(root).filter(entry => entry.startsWith('.rivet-backup-'));
      assert.ok(name);
      nodeFs.writeFileSync(join(root, name, 'project.yaml'), late);
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  const restored = join(root, '.rivet', 'project.yaml');
  assert.equal((await lstat(restored)).ino, originalIdentity.ino);
  assert.equal(await readFile(restored, 'utf8'), late);
});

test('pins the sibling transaction identity when its pathname is replaced during staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  const external = await mkdtemp(join(tmpdir(), 'agilno-external-'));
  await cp(fixture, root, { recursive: true });
  let swapped = false;
  const injectedFs = {
    ...nodeFs,
    writeFileSync(path, data, options) {
      if (!swapped && typeof path === 'string' && path === 'project.yaml' && process.cwd().includes('.rivet-stage-')) {
        swapped = true;
        const transaction = isAbsolute(path) ? dirname(path) : process.cwd();
        assert.match(transaction, /\.rivet-stage-/);
        nodeFs.renameSync(transaction, `${transaction}.owned`);
        nodeFs.symlinkSync(external, transaction, 'dir');
      }
      return nodeFs.writeFileSync(path, data, options);
    },
  };
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, json: true } }, {
    output: capture.output, fs: injectedFs,
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(nodeFs.readdirSync(external), []);
  await assert.rejects(() => lstat(join(root, '.rivet')));
  assert.ok(JSON.parse(capture.writes[0][1]).recovery.residueCount > 0);
});

test('transaction setup and backup move failures preserve the complete original configuration', async t => {
  for (const failure of ['recovery creation', 'backup move']) {
    await t.test(failure, async () => {
      const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
      await cp(fixture, root, { recursive: true });
      await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
      const filenames = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];
      const before = await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8')));
      const injectedFs = {
        ...nodeFs,
        mkdirSync(path, options) {
          if (failure === 'recovery creation' && String(path).includes('.rivet-stage-')) throw new Error('injected setup');
          return nodeFs.mkdirSync(path, options);
        },
        renameSync(source, destination) {
          if (failure === 'backup move' && String(source).endsWith('.rivet')) throw new Error('injected move');
          return nodeFs.renameSync(source, destination);
        },
      };
      const capture = outputCapture();
      const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
        output: capture.output, fs: injectedFs,
        gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
      });
      assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
      assert.deepEqual(await Promise.all(filenames.map(name => readFile(join(root, '.rivet', name), 'utf8'))), before);
      assert.deepEqual(nodeFs.readdirSync(join(root, '.rivet')).sort(), filenames.sort());
    });
  }
});

test('loader failure rolls back and rollback-operation failure is surfaced as recoverable residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  let blockedRollback = false;
  const injectedFs = {
    ...nodeFs,
    renameSync(source, destination) {
      if (!blockedRollback && String(source).includes('.rivet-backup-') && String(destination).endsWith('.rivet')) {
        blockedRollback = true;
        throw new Error('injected rollback operation');
      }
      return nodeFs.renameSync(source, destination);
    },
  };
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output, fs: injectedFs,
    configLoader: async () => { throw new Error('injected loader failure'); },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  const payload = JSON.parse(capture.writes[0][1]);
  assert.ok(payload.recovery.residueCount > 0);
  assert.match(payload.recovery.remediation, /recover/i);
  assert.doesNotMatch(capture.writes[0][1], /injected/);
});

test('mid-publish failure restores all four originals without transaction residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const filenames = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];
  const before = await Promise.all(filenames.map(filename => readFile(join(root, '.rivet', filename), 'utf8')));
  const injectedFs = {
    ...nodeFs,
    renameSync(source, destination) {
      if (String(source).includes('.rivet-stage-')) throw new Error('injected mid-publish failure');
      return nodeFs.renameSync(source, destination);
    },
  };
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    env: {},
    fs: injectedFs,
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(
    await Promise.all(filenames.map(filename => readFile(join(root, '.rivet', filename), 'utf8'))),
    before,
  );
  assert.deepEqual(nodeFs.readdirSync(join(root, '.rivet')).sort(), filenames.sort());
});

test('post-commit backup cleanup failure keeps all four new files and reports private residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const injectedFs = {
    ...nodeFs,
    unlinkSync(path) {
      if (String(path).includes('.rivet-backup-')) throw new Error('injected cleanup failure');
      return nodeFs.unlinkSync(path);
    },
  };
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    env: {},
    fs: injectedFs,
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const config = await loadProjectConfig(root);
  assert.equal(config.project.id, 'nextjs-example');
  const entries = nodeFs.readdirSync(join(root, '.rivet'));
  assert.deepEqual(entries.sort(), ['orchestration.yaml', 'project.yaml', 'providers.yaml', 'quality.yaml']);
  assert.equal(entries.filter(name => name.includes('.tmp')).length, 0);
  const [recoveryDirectory] = nodeFs.readdirSync(root).filter(name => name.startsWith('.rivet-backup-'));
  assert.equal(nodeFs.readdirSync(join(root, recoveryDirectory)).length, 4);
  const payload = JSON.parse(capture.writes[0][1]);
  assert.equal(payload.cleanup.residueCount, 4);
  assert.equal(payload.cleanup.recoveryStored, true);
  assert.match(payload.cleanup.remediation, /retry cleanup/i);
  assert.doesNotMatch(capture.writes[0][1], new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('post-commit cleanup preserves an in-place modified backup as recovery residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  await cp(fixture, root, { recursive: true });
  await cp(join(here, '..', 'fixtures', 'config', 'valid', '.rivet'), join(root, '.rivet'), { recursive: true });
  const late = 'late backup bytes\n';
  let backupProject;
  const capture = outputCapture();
  const exitCode = await init({ flags: { project: root, write: true, overwrite: true, json: true } }, {
    output: capture.output,
    beforeBackupCleanup() {
      const [name] = nodeFs.readdirSync(root).filter(entry => entry.startsWith('.rivet-backup-'));
      assert.ok(name);
      backupProject = join(root, name, 'project.yaml');
      nodeFs.writeFileSync(backupProject, late);
    },
    gitDiscovery: async () => ({ defaultBranch: 'main' }), toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(await readFile(backupProject, 'utf8'), late);
  const payload = JSON.parse(capture.writes[0][1]);
  assert.ok(payload.cleanup.residueCount > 0);
  assert.match(payload.cleanup.remediation, /cleanup/i);
});

test('refuses a symlinked .rivet target without modifying its destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agilno-init-'));
  const destination = await mkdtemp(join(tmpdir(), 'agilno-victim-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(join(destination, 'safe'));
  await symlink(destination, join(root, '.rivet'), 'dir');
  const capture = outputCapture();
  const exitCode = await init({ command: 'init', flags: { project: root, write: true, json: true } }, {
    output: capture.output,
    env: {},
    gitDiscovery: async () => ({ defaultBranch: 'main' }),
    toolDiscovery: async () => ({}),
  });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.deepEqual(nodeFs.readdirSync(destination), ['safe']);
});
