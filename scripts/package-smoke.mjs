import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rivet-package-'));
// Keep npm, Git and Rivet away from the user's home, configuration and credentials.
const smokeHome = join(scratch, 'home');
mkdirSync(smokeHome);
const env = {
  PATH: process.env.PATH, HOME: smokeHome, USERPROFILE: smokeHome,
  TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_userconfig: join(scratch, 'npmrc'),
  npm_config_globalconfig: join(scratch, 'global-npmrc'),
  npm_config_install_links: 'false', npm_config_update_notifier: 'false', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
};
const execute = (command, args, cwd = scratch, extraEnv = {}) => execFileSync(command, args, {
  cwd, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
});
const npm = (args, cwd = scratch) => execute('npm', args, cwd);
const git = (args, cwd = scratch) => execute('git', args, cwd);

function firstUse(label, source) {
  const prefix = join(scratch, `${label}-prefix`);
  // Explicit install-links also protects environments whose npm config defaults to false.
  npm(['install', '--global', '--prefix', prefix, '--install-links', '--ignore-scripts',
    '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', source]);
  const installed = join(prefix, 'lib', 'node_modules', '@agilno', 'rivet');
  assert(existsSync(installed), `${label}: installed package must not be a dangling link`);
  assert.equal(lstatSync(installed).isSymbolicLink(), false, `${label}: package must be materialized`);
  assert.notEqual(realpathSync(installed), realpathSync(root));
  const bin = join(prefix, 'bin', 'rivet');
  assert.equal(realpathSync(bin), realpathSync(join(installed, 'bin', 'cli.js')));
  const cliEnv = { PATH: `${join(prefix, 'bin')}${delimiter}${env.PATH}` };
  // Exercise the public command, its executable bit and its shebang, never node <source-cli>.
  const run = (args, cwd = scratch) => execute('rivet', args, cwd, cliEnv);
  assert.match(run(['--help']), /rivet/);
  const models = JSON.parse(run(['models', 'list', '--json']));
  assert.equal(models.ok, true);
  assert.match(JSON.stringify(models), /ollama/);

  const project = join(scratch, `${label}-consumer`);
  const remote = join(scratch, `${label}-remote.git`);
  mkdirSync(project);
  git(['init', '--bare', '--initial-branch=main', remote]);
  git(['init', '--initial-branch=main'], project);
  git(['config', 'user.name', 'Package Smoke'], project);
  git(['config', 'user.email', 'package-smoke@example.invalid'], project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'rivet-package-smoke-consumer', private: true,
    scripts: { build: 'node build.mjs', test: 'node --test test.mjs' },
  }));
  writeFileSync(join(project, 'source.mjs'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(project, 'build.mjs'), "import { add } from './source.mjs';\nif (add(2, 3) !== 5) throw new Error('Build validation failed');\n");
  writeFileSync(join(project, 'test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './source.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n");
  const preview = JSON.parse(run(['setup', '--target=both', '--json'], project));
  assert.equal(preview.ok, true);
  assert.equal(preview.status, 'preview');
  for (const path of ['.rivet', '.agents', '.claude']) assert.equal(existsSync(join(project, path)), false);
  const applied = JSON.parse(run(['setup', '--target=both', '--write', '--json'], project));
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'configured');
  const projectConfig = join(project, '.rivet', 'project.yaml');
  const skills = ['.agents', '.claude'].map(target => join(project, target, 'skills', 'rivet', 'SKILL.md'));
  for (const path of [projectConfig, ...skills]) assert(existsSync(path));
  const original = readFileSync(projectConfig, 'utf8');
  const repeated = JSON.parse(run(['setup', '--target=both', '--write', '--json'], project));
  assert.equal(repeated.configuration.status, 'preserved');
  assert.equal(readFileSync(projectConfig, 'utf8'), original);
  git(['add', '.'], project);
  git(['commit', '-m', 'Initialize disposable first-use project'], project);
  git(['remote', 'add', 'origin', remote], project);
  git(['push', '-u', 'origin', 'main'], project);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], project);
  assert.equal(JSON.parse(run(['doctor', '--json'], project)).ok, true);
  const preflight = JSON.parse(run(['preflight', '--mode=host', '--json'], project));
  assert.equal(preflight.ok, true);
  assert(preflight.checks.every(check => check.status === 'pass'));
  npm(['run', 'build'], project);
  npm(['test'], project);

  const nested = join(project, 'nested');
  mkdirSync(nested);
  const support = JSON.parse(run(['support', '--json'], nested));
  assert.equal(support.ok, true);
  assert.equal(support.result.configuration.status, 'valid');
  const status = spawnSync('rivet', ['task', 'status'], {
    cwd: nested, env: { ...env, ...cliEnv }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(status.error, undefined);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /No active task exists/);

  const editedConfig = original.replace('name: rivet-package-smoke-consumer', 'name: user-edited-rivet-project');
  assert.notEqual(editedConfig, original);
  writeFileSync(projectConfig, editedConfig);
  assert.equal(JSON.parse(run(['setup', '--target=both', '--write', '--json'], project)).configuration.status, 'preserved');
  assert.equal(readFileSync(projectConfig, 'utf8'), editedConfig);
  assert.equal(JSON.parse(run(['uninstall', '--minimal', '--target=both', '--json'], project)).ok, true);
  for (const skill of skills) assert.equal(existsSync(skill), false);
  assert(existsSync(projectConfig), 'minimal uninstall preserves configuration');
  console.log(`Package smoke passed: ${label}; global executable, setup, Git host preflight and local checks.`);
}

try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], root));
  const files = packed.files.map(file => file.path);
  assert(files.includes('bin/cli.js'));
  assert(files.includes('src/models/registry.js'));
  assert(!files.some(path => /(?:^|\/)(?:demo|conference-planner|plans)(?:\/|$)/.test(path)));
  assert(!files.some(path => path.startsWith('test/') || path.startsWith('node_modules/')));
  firstUse('tarball', join(scratch, packed.filename));
  // Local Git transport exercises npm's clone/install lifecycle without GitHub auth/network.
  // It intentionally uses committed HEAD, as a fresh GitHub install would.
  const revision = git(['rev-parse', 'HEAD'], root).trim();
  firstUse('git', `git+${pathToFileURL(root).href}#${revision}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
