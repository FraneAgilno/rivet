import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function createBuildFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rivet-build-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
  await cp(join(REPOSITORY_ROOT, 'scripts', 'build.js'), join(fixtureRoot, 'scripts', 'build.js'));
  await cp(join(REPOSITORY_ROOT, 'mandatory'), join(fixtureRoot, 'mandatory'), { recursive: true });
  await cp(join(REPOSITORY_ROOT, 'optional'), join(fixtureRoot, 'optional'), { recursive: true });
  for (const directory of ['protocols', 'schemas', 'templates']) {
    await cp(join(REPOSITORY_ROOT, directory), join(fixtureRoot, directory), { recursive: true });
  }
  return fixtureRoot;
}

function runBuild(fixtureRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(fixtureRoot, 'scripts', 'build.js')], {
      cwd: fixtureRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    timeout.unref();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function markdownSourceCount(dir) {
  return (await readdir(dir)).filter(name => name.endsWith('.md') && name !== 'README.md').length;
}

async function directoryCount(dir) {
  return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).length;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('build fixture declares the copied build script as ESM', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const packagePath = join(fixtureRoot, 'package.json');

  assert.equal(await pathExists(packagePath), true);
  assert.deepEqual(JSON.parse(await readFile(packagePath, 'utf8')), { type: 'module' });
});

test('package test script uses shell-independent test discovery', async () => {
  const packageMetadata = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageMetadata.scripts.test, 'node test/run-tests.cjs');
});

test('test:unit uses Node-native cross-platform globs that execute on the current Node runtime', async () => {
  const packageMetadata = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageMetadata.scripts['test:unit'],
    'node --test "test/core/*.test.js" "test/runtime/*.test.js" "test/adapters/*.test.js"',
  );
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      'run', 'test:unit', '--', '--test-name-pattern=creates an immutable versioned source envelope',
    ], {
      cwd: REPOSITORY_ROOT, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    timeout.unref();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, `test:unit failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /creates an immutable versioned source envelope/);
});

test('build writes every source category with generated frontmatter and removes stale generated skills', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const staleOutput = join(fixtureRoot, 'dist', 'skills', 'stale', 'SKILL.md');
  await mkdir(join(staleOutput, '..'), { recursive: true });
  await writeFile(staleOutput, 'stale\n');

  const result = await runBuild(fixtureRoot);
  assert.equal(result.code, 0, `build failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const mandatoryCount = await markdownSourceCount(join(fixtureRoot, 'mandatory', 'skills'));
  const skillCount = await markdownSourceCount(join(fixtureRoot, 'optional', 'skills'));
  const agentCount = await markdownSourceCount(join(fixtureRoot, 'optional', 'agents'));
  const governanceCount = (await readdir(join(fixtureRoot, 'optional', 'governance'))).filter(name => name.endsWith('.md')).length;

  assert.equal(await directoryCount(join(fixtureRoot, 'dist', 'mandatory')), mandatoryCount);
  assert.equal(await directoryCount(join(fixtureRoot, 'dist', 'skills')), skillCount);
  assert.equal(await directoryCount(join(fixtureRoot, 'dist', 'agents')), agentCount);
  assert.equal((await readdir(join(fixtureRoot, 'dist', 'governance'))).length, governanceCount);
  assert.match(result.stdout, new RegExp(`Done\\. ${mandatoryCount} mandatory \\+ ${skillCount} skills \\+ ${agentCount} agents \\+ ${governanceCount} governance files written to dist/`));
  assert.equal(await pathExists(staleOutput), false);

  const mandatorySource = await readFile(join(fixtureRoot, 'mandatory', 'skills', 'design.md'), 'utf8');
  const mandatoryOutput = await readFile(join(fixtureRoot, 'dist', 'mandatory', 'design', 'SKILL.md'), 'utf8');
  assert.equal(mandatoryOutput, `---\nname: rivet-design\ndescription: "Write a design document for a Jira ticket before any code is written."\n---\n\n${mandatorySource}`);

  const optionalSource = await readFile(join(fixtureRoot, 'optional', 'skills', 'debugging.md'), 'utf8');
  const optionalOutput = await readFile(join(fixtureRoot, 'dist', 'skills', 'debugging', 'SKILL.md'), 'utf8');
  assert.equal(optionalOutput, `---\nname: rivet-debugging\ndescription: "Investigating production errors, unexpected behavior, or failing tests by systematically narrowing down the root cause f"\n---\n\n${optionalSource}`);

  const governanceSource = await readFile(join(fixtureRoot, 'optional', 'governance', 'usage-rules.md'), 'utf8');
  const governanceOutput = await readFile(join(fixtureRoot, 'dist', 'governance', 'usage-rules.md'), 'utf8');
  assert.equal(governanceOutput, governanceSource);
});

test('build rejects source name collisions before replacing existing output', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const preservedOutput = join(fixtureRoot, 'dist', 'skills', 'preserved', 'SKILL.md');
  await mkdir(join(preservedOutput, '..'), { recursive: true });
  await writeFile(preservedOutput, 'preserve on collision\n');
  await writeFile(join(fixtureRoot, 'optional', 'skills', 'design.md'), '# Conflicting design\n');

  const result = await runBuild(fixtureRoot);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /ERROR: Name collisions detected:/);
  assert.match(result.stderr, /design\.md \(optional\/skills\/ and mandatory\/skills\/\)/);
  assert.equal(await readFile(preservedOutput, 'utf8'), 'preserve on collision\n');
});
