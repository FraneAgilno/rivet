import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  assert(!files.some(path => path.startsWith('test/') || path.startsWith('node_modules/')));
  npm(['install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', join(scratch, packed.filename)]);
  const cli = join(scratch, 'node_modules', '@agilno', 'rivet', 'bin', 'cli.js');
  const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: scratch, encoding: 'utf8' });
  assert.match(run(['--help']), /rivet/);
  const models = JSON.parse(run(['models', 'list', '--json']));
  assert.equal(models.ok, true);
  assert.match(JSON.stringify(models), /ollama/);
  console.log(`Package smoke passed: ${packed.filename}; installed and executed outside source checkout.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
