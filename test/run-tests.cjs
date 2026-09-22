const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join, relative } = require('node:path');

const repositoryRoot = join(__dirname, '..');

function discoverTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTests(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}

const testFiles = discoverTests(__dirname)
  .map(path => relative(repositoryRoot, path))
  .sort();
// Bound process-heavy test files so their deadline/lock assertions remain meaningful
// on shared developer machines and small CI runners. In-file race tests still run.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...testFiles], {
  cwd: repositoryRoot,
  shell: false,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
