import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { sha256 } from '../evidence/checksum.js';
import { assertGitClient } from '../git/client.js';
import { runCommand } from '../policy/commands.js';
import { redactSecrets } from '../state/redact.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const AC_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*-AC[1-9][0-9]*$/;
const PACKAGE_RUNNERS = new Set(['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'bun']);
const PACKAGE_SCRIPT = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const qualityRuns = new WeakSet();

export class QualityError extends Error {
  constructor(reason = 'invalid-quality-input') {
    const messages = {
      'invalid-quality-input': 'Quality gate input is invalid.',
      'unsafe-artifact': 'Quality gate artifact path is unsafe.',
      'clock-regressed': 'Quality gate clock regressed.',
      'gate-failed': 'Quality gate execution failed safely.',
    };
    super(messages[reason] ?? messages['invalid-quality-input']);
    this.name = 'QualityError';
    this.code = 'ERR_QUALITY_GATE';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new QualityError(reason); }

function capture(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-quality-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-quality-input'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-quality-input');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-quality-input');
      result[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof QualityError) throw error;
    fail('invalid-quality-input');
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-quality-input');
  return result;
}

function array(value, maximum, convert) {
  try {
    if (!Array.isArray(value)) fail('invalid-quality-input');
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = descriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(value).length !== length + 1) fail('invalid-quality-input');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const child = Object.getOwnPropertyDescriptor(value, String(index));
      if (!child?.enumerable || !Object.hasOwn(child, 'value')) fail('invalid-quality-input');
      result.push(convert(child.value));
    }
    return result;
  } catch (error) {
    if (error instanceof QualityError) throw error;
    fail('invalid-quality-input');
  }
}

function id(value) {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)) fail('invalid-quality-input');
  return value;
}

function relativePath(value, allowDot = false) {
  if (allowDot && value === '.') return value;
  if (typeof value !== 'string' || value.length < 1 || value.length > 500
    || isAbsolute(value) || value.normalize('NFKC') !== value
    || /[\\:\u0000-\u001f\u007f]/.test(value) || value.startsWith('-')
    || value.startsWith('/') || value.endsWith('/') || value.includes('//')) fail('invalid-quality-input');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || WINDOWS_RESERVED.test(part) || part.toUpperCase().toLowerCase() === '.git')) fail('invalid-quality-input');
  return value;
}

function strings(value, maximum, itemMaximum) {
  return array(value, maximum, child => {
    if (typeof child !== 'string' || child.length > itemMaximum || child.includes('\0')) fail('invalid-quality-input');
    return child;
  });
}

function environment(value) {
  if (value === undefined) return Object.freeze(Object.create(null));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-quality-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-quality-input'); }
  if (keys.length > 256 || keys.some(key => typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key))) {
    fail('invalid-quality-input');
  }
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'string' || descriptor.value.length > 32_768
        || descriptor.value.includes('\0')) fail('invalid-quality-input');
      result[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof QualityError) throw error;
    fail('invalid-quality-input');
  }
  return Object.freeze(result);
}

function acceptanceCriterion(value) {
  if (typeof value !== 'string' || value.length > 100 || !AC_ID.test(value)) fail('invalid-quality-input');
  return value;
}

function configuredTest(value) {
  const input = capture(value, new Set(['id', 'acceptanceCriteria']), ['id', 'acceptanceCriteria']);
  const acceptanceCriteria = array(input.acceptanceCriteria, 128, acceptanceCriterion);
  if (acceptanceCriteria.length === 0
    || new Set(acceptanceCriteria.map(item => item.toLowerCase())).size !== acceptanceCriteria.length) {
    fail('invalid-quality-input');
  }
  return Object.freeze({ id: id(input.id), acceptanceCriteria: Object.freeze(acceptanceCriteria) });
}

function packageScript(value, args) {
  if (value === undefined) return null;
  const input = capture(value, new Set(['runner', 'script']), ['runner', 'script']);
  if (typeof input.runner !== 'string' || !PACKAGE_RUNNERS.has(input.runner.toLowerCase())
    || typeof input.script !== 'string' || !PACKAGE_SCRIPT.test(input.script)
    || args.length !== 2 || args[0] !== 'run' || args[1] !== input.script) fail('invalid-quality-input');
  return Object.freeze({ runner: input.runner.toLowerCase(), script: input.script });
}

function gate(value) {
  const input = capture(value, new Set([
    'id', 'executable', 'args', 'cwd', 'packageScript', 'required', 'artifactPaths', 'tests', 'resultPath',
  ]), ['id', 'executable', 'args', 'cwd', 'required', 'artifactPaths', 'tests']);
  const gateId = id(input.id);
  if (typeof input.executable !== 'string' || !isAbsolute(input.executable)
    || input.executable.length > 1_024 || /[\u0000\r\n]/.test(input.executable)
    || typeof input.required !== 'boolean') fail('invalid-quality-input');
  const artifactPaths = strings(input.artifactPaths, 256, 500).map(path => relativePath(path));
  const tests = array(input.tests, 2_000, configuredTest);
  const args = Object.freeze(strings(input.args, 256, 4_096));
  if (new Set(artifactPaths.map(path => path.toLowerCase())).size !== artifactPaths.length) fail('invalid-quality-input');
  if (new Set(tests.map(item => item.id.toLowerCase())).size !== tests.length) fail('invalid-quality-input');
  const resultPath = input.resultPath === undefined ? null : relativePath(input.resultPath);
  if ((tests.length > 0 && resultPath === null) || (resultPath !== null && !artifactPaths.includes(resultPath))) {
    fail('invalid-quality-input');
  }
  return Object.freeze({
    id: gateId,
    executable: input.executable,
    args,
    cwd: relativePath(input.cwd, true),
    packageScript: packageScript(input.packageScript, args),
    required: input.required,
    artifactPaths: Object.freeze(artifactPaths),
    tests: Object.freeze(tests),
    resultPath,
  });
}

function withPinnedProject(project, operation) {
  let original;
  try { original = process.cwd(); } catch { fail('unsafe-artifact'); }
  let changed = false;
  let result;
  let primary = null;
  try {
    process.chdir(project.path);
    changed = true;
    const pinned = statSync('.', { bigint: true });
    if (!pinned.isDirectory() || pinned.dev !== project.dev || pinned.ino !== project.ino) fail('unsafe-artifact');
    result = operation();
  } catch (error) { primary = error; }
  if (changed) {
    try { process.chdir(original); }
    catch (error) { if (primary === null) primary = error; }
  }
  if (primary !== null) {
    if (primary instanceof QualityError) throw primary;
    fail('unsafe-artifact');
  }
  return result;
}

function readPinnedFile(project, relative, maxBytes) {
  return withPinnedProject(project, () => {
    const components = relative.split('/');
    for (const component of components.slice(0, -1)) {
      const before = lstatSync(component, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe-artifact');
      process.chdir(component);
      const pinned = statSync('.', { bigint: true });
      if (!pinned.isDirectory() || pinned.dev !== before.dev || pinned.ino !== before.ino) fail('unsafe-artifact');
    }
    const name = components.at(-1);
    const before = lstatSync(name, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 0n || before.size > BigInt(maxBytes)) fail('unsafe-artifact');
    let descriptor;
    try {
      descriptor = openSync(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
        fail('unsafe-artifact');
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || after.size !== BigInt(bytes.length)) fail('unsafe-artifact');
      const current = lstatSync(name, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
        || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) {
        fail('unsafe-artifact');
      }
      return Object.freeze({
        bytes, size: bytes.length, sha256: sha256(bytes), dev: after.dev.toString(), ino: after.ino.toString(),
        mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString(),
      });
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  });
}

function verifyPackageScript(project, configured) {
  if (configured.packageScript === null) return true;
  const relative = configured.cwd === '.'
    ? 'package.json' : `${configured.cwd}/package.json`;
  let manifest;
  try {
    const contents = readPinnedFile(project, relative, MAX_PACKAGE_MANIFEST_BYTES);
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents.bytes));
  } catch {
    fail('gate-failed');
  }
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)
    || typeof scripts[configured.packageScript.script] !== 'string') return false;
  return true;
}

async function priorResult(project, path) {
  if (path === null) return null;
  try { return readPinnedFile(project, path, 1024 * 1024); }
  catch (error) {
    let missing = false;
    try {
      withPinnedProject(project, () => {
        try { lstatSync(path); } catch (nested) { missing = nested?.code === 'ENOENT'; }
      });
    } catch {}
    if (missing) return null;
    fail('unsafe-artifact');
  }
}

function attestedTest(value) {
  const input = capture(value, new Set(['id', 'status', 'acceptanceCriteria']), ['id', 'status', 'acceptanceCriteria']);
  if (!['passed', 'failed', 'skipped'].includes(input.status)) fail('gate-failed');
  const acceptanceCriteria = array(input.acceptanceCriteria, 128, acceptanceCriterion);
  if (acceptanceCriteria.length === 0
    || new Set(acceptanceCriteria.map(item => item.toLowerCase())).size !== acceptanceCriteria.length) fail('gate-failed');
  return Object.freeze({ id: id(input.id), status: input.status, acceptanceCriteria: Object.freeze(acceptanceCriteria) });
}

async function readAttestation(project, configured, before) {
  if (configured.resultPath === null) return Object.freeze([]);
  let contents;
  try { contents = readPinnedFile(project, configured.resultPath, 1024 * 1024); }
  catch { fail('gate-failed'); }
  if (before && before.dev === contents.dev && before.ino === contents.ino) fail('gate-failed');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents.bytes)); }
  catch { fail('gate-failed'); }
  const record = capture(parsed, new Set(['schemaVersion', 'gateId', 'tests']), ['schemaVersion', 'gateId', 'tests']);
  if (record.schemaVersion !== 1 || record.gateId !== configured.id) fail('gate-failed');
  const tests = array(record.tests, 2_000, attestedTest);
  if (tests.length !== configured.tests.length
    || new Set(tests.map(test => test.id.toLowerCase())).size !== tests.length) fail('gate-failed');
  for (let index = 0; index < tests.length; index += 1) {
    const expected = configured.tests[index];
    const actual = tests[index];
    if (actual.id !== expected.id
      || actual.acceptanceCriteria.length !== expected.acceptanceCriteria.length
      || actual.acceptanceCriteria.some((criterion, criterionIndex) => criterion !== expected.acceptanceCriteria[criterionIndex])) {
      fail('gate-failed');
    }
  }
  return Object.freeze(tests.map(test => Object.freeze({
    ...test, gateId: configured.id, resultPath: configured.resultPath, resultSha256: contents.sha256,
  })));
}

async function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.length > 1_024) fail('invalid-quality-input');
  const before = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino || canonical !== path) fail('invalid-quality-input');
  return Object.freeze({ path, dev: after.dev, ino: after.ino });
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-quality-input');
  return new Date(value).toISOString();
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
  }
  return value;
}

function snapshotInput(input, options) {
  const value = capture(input, new Set([
    'projectRoot', 'commitSha', 'authority', 'gates', 'environment', 'timeoutMs',
    'maxOutputBytes', 'maxStreamOutputBytes',
  ]), ['projectRoot', 'commitSha', 'authority', 'gates']);
  const optionValues = capture(options, new Set(['now', 'gitClient', 'signal']), ['gitClient']);
  if (!SHA.test(value.commitSha)) fail('invalid-quality-input');
  const gates = array(value.gates, 64, gate);
  if (gates.length === 0 || new Set(gates.map(item => item.id.toLowerCase())).size !== gates.length) fail('invalid-quality-input');
  const allTestIds = gates.flatMap(item => item.tests.map(test => test.id.toLowerCase()));
  if (new Set(allTestIds).size !== allTestIds.length) fail('invalid-quality-input');
  if (optionValues.now !== undefined && typeof optionValues.now !== 'function') fail('invalid-quality-input');
  if (optionValues.signal !== undefined && !(optionValues.signal instanceof AbortSignal)) fail('invalid-quality-input');
  try { assertGitClient(optionValues.gitClient); } catch { fail('invalid-quality-input'); }
  return Object.freeze({
    ...value,
    gates: Object.freeze(gates),
    environment: environment(value.environment),
    now: optionValues.now ?? Date.now,
    gitClient: optionValues.gitClient,
    signal: optionValues.signal,
  });
}

export function assertQualityRun(value) {
  if (!qualityRuns.has(value)) fail('invalid-quality-input');
}

export async function runQualityGates(input, options = {}) {
  let value;
  try { value = snapshotInput(input, options); } catch (error) {
    if (error instanceof QualityError) throw error;
    fail('invalid-quality-input');
  }
  const project = await canonicalDirectory(value.projectRoot).catch(error => {
    if (error instanceof QualityError) throw error;
    fail('invalid-quality-input');
  });
  let repository;
  const projectRoot = project.path;
  try { repository = await value.gitClient.inspectRepository(projectRoot); }
  catch { fail('invalid-quality-input'); }
  if (repository.root !== projectRoot || repository.headSha !== value.commitSha
    || repository.dirty || repository.dirtyPaths.length !== 0) fail('invalid-quality-input');
  const results = [];
  const attestedTests = [];
  for (const configured of value.gates) {
    if (value.signal?.aborted) fail('gate-failed');
    let startedMs;
    let endedMs;
    let commandResult;
    const beforeResult = await priorResult(project, configured.resultPath);
    try {
      const scriptAvailable = verifyPackageScript(project, configured);
      if (!scriptAvailable && configured.required) fail('gate-failed');
      startedMs = value.now();
      timestamp(startedMs);
      commandResult = scriptAvailable ? await runCommand({
        worktree: projectRoot,
        authority: value.authority,
        commands: {
          [configured.id]: {
            executable: configured.executable,
            args: configured.args,
            action: 'command.' + configured.id,
          },
        },
        environment: value.environment,
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        ...(value.maxOutputBytes === undefined ? {} : { maxOutputBytes: value.maxOutputBytes }),
        ...(value.maxStreamOutputBytes === undefined ? {} : { maxStreamOutputBytes: value.maxStreamOutputBytes }),
      }, {
        actorId: value.authority.actorId,
        commandId: configured.id,
        cwd: configured.cwd,
        args: [],
      }, { signal: value.signal }) : Object.freeze({
        status: 'unavailable', code: 127, stdout: '', stderr: '',
        redacted: false, suppressed: false, truncated: false,
      });
      endedMs = value.now();
      if (value.signal?.aborted) fail('gate-failed');
      timestamp(endedMs);
      if (endedMs < startedMs) fail('clock-regressed');
    } catch (error) {
      if (error instanceof QualityError) throw error;
      fail('gate-failed');
    }

    const artifacts = [];
    let artifactFailure = false;
    for (const path of configured.artifactPaths) {
      try {
        const contents = readPinnedFile(project, path, 32 * 1024 * 1024);
        artifacts.push(Object.freeze({ path, sha256: contents.sha256, bytes: contents.size }));
      } catch {
        artifactFailure = true;
        artifacts.push(Object.freeze({ path, status: 'missing-or-unsafe' }));
      }
    }
    let gateTests = Object.freeze([]);
    if (commandResult.status === 'success' && !artifactFailure) {
      gateTests = await readAttestation(project, configured, beforeResult);
      const resultArtifact = artifacts.find(artifact => artifact.path === configured.resultPath);
      if (configured.resultPath !== null
        && (!resultArtifact || gateTests.some(test => test.resultSha256 !== resultArtifact.sha256))) fail('gate-failed');
    } else {
      gateTests = Object.freeze(configured.tests.map(test => Object.freeze({
        ...test, status: 'failed', gateId: configured.id,
        ...(configured.resultPath === null ? {} : { resultPath: configured.resultPath }),
      })));
    }
    attestedTests.push(...gateTests);
    const passed = commandResult.status === 'success' && !artifactFailure
      && gateTests.every(test => test.status === 'passed');
    let commandProvenance;
    try {
      commandProvenance = redactSecrets({ executable: configured.executable, args: configured.args }, {
        environment: value.environment,
      });
    } catch { fail('invalid-quality-input'); }
    results.push(immutable({
      id: configured.id,
      required: configured.required,
      status: passed ? 'passed' : 'failed',
      commitSha: value.commitSha,
      startedAt: timestamp(startedMs),
      endedAt: timestamp(endedMs),
      cwd: configured.cwd,
      command: commandProvenance,
      exitCode: commandResult.code,
      executionStatus: commandResult.status,
      output: {
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        redacted: commandResult.redacted,
        suppressed: commandResult.suppressed,
        truncated: commandResult.truncated,
      },
      artifacts,
    }));
  }
  let after;
  try { after = await value.gitClient.inspectRepository(projectRoot); }
  catch { fail('gate-failed'); }
  if (after.root !== repository.root || after.repositoryId !== repository.repositoryId
    || after.rootIdentity.dev !== repository.rootIdentity.dev || after.rootIdentity.ino !== repository.rootIdentity.ino
    || after.headSha !== repository.headSha || after.dirty || after.dirtyPaths.length !== 0) fail('gate-failed');
  const failedRequired = results.some(result => result.required && result.status !== 'passed');
  const output = immutable({
    status: failedRequired ? 'fail' : 'pass',
    projectRoot,
    commitSha: repository.headSha,
    gates: results,
    tests: attestedTests,
  });
  qualityRuns.add(output);
  return output;
}
