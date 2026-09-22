import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rivet-package-'));
const npm = (args, cwd = scratch) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' },
});
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], root));
  const files = packed.files.map(file => file.path);
  assert(files.includes('bin/cli.js'));
  assert(files.includes('src/models/registry.js'));
  assert(!files.some(path => /(?:^|\/)(?:demo|conference-planner|plans)(?:\/|$)/.test(path)), 'Retired demo/planning assets must not ship');
  assert(!files.some(path => path.startsWith('test/') || path.startsWith('node_modules/')));
  npm(['install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', join(scratch, packed.filename)]);
  const cli = join(scratch, 'node_modules', '@agilno', 'rivet', 'bin', 'cli.js');
  const run = (args, cwd = scratch) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.match(run(['--help']), /rivet/);
  const models = JSON.parse(run(['models', 'list', '--json']));
  assert.equal(models.ok, true);
  assert.match(JSON.stringify(models), /ollama/);

  const project = join(scratch, 'consumer-project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'rivet-package-smoke-consumer',
    private: true,
    scripts: {
      build: 'node -e "process.exit(93)"',
      test: 'node -e "process.exit(94)"',
    },
  }));
  const preview = JSON.parse(run(['setup', `--project=${project}`, '--target=codex', '--json']));
  assert.equal(preview.ok, true);
  assert.equal(preview.status, 'preview');
  assert.equal(existsSync(join(project, '.rivet')), false, 'setup preview must not write configuration');
  assert.equal(existsSync(join(project, '.agents')), false, 'setup preview must not install a harness skill');

  const applied = JSON.parse(run(['setup', `--project=${project}`, '--target=codex', '--write', '--json']));
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'configured');
  const projectConfig = join(project, '.rivet', 'project.yaml');
  const managedSkill = join(project, '.agents', 'skills', 'rivet', 'SKILL.md');
  assert.equal(existsSync(projectConfig), true);
  assert.equal(existsSync(managedSkill), true);

  const editedConfig = readFileSync(projectConfig, 'utf8').replace(
    'name: rivet-package-smoke-consumer',
    'name: user-edited-rivet-project',
  );
  writeFileSync(projectConfig, editedConfig);
  const repeated = JSON.parse(run(['setup', `--project=${project}`, '--target=codex', '--write', '--json']));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.configuration.status, 'preserved');
  assert.equal(readFileSync(projectConfig, 'utf8'), editedConfig);

  const removed = JSON.parse(run([
    'uninstall', '--minimal', `--project=${project}`, '--target=codex', '--json',
  ]));
  assert.equal(removed.ok, true);
  assert.equal(existsSync(managedSkill), false);
  assert.equal(existsSync(projectConfig), true, 'minimal uninstall must preserve project configuration');
  console.log(`Package smoke passed: ${packed.filename}; installed and executed outside source checkout.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
