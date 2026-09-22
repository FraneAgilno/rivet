import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { runArgv } from '../discovery/tools.js';

const INSTANCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const resolvedStatePaths = new WeakSet();
const statePathIdentities = new WeakMap();
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export class UnsupportedStatePlatformError extends Error {
  constructor(platform) {
    super('Private orchestration state requires enforceable owner-only filesystem permissions');
    this.name = 'UnsupportedStatePlatformError';
    this.code = 'ERR_PRIVATE_STATE_UNSUPPORTED_PLATFORM';
    this.platform = platform;
  }
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function createPrivateDirectory(candidate, gitCommonDir) {
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const resolved = await realpath(candidate);
  if (!isWithin(gitCommonDir, resolved)) {
    throw new Error('Private state path resolves outside the Git common directory');
  }
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Private state path is unsafe');
  }
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || !opened.isDirectory()) {
      throw new Error('Private state path identity changed');
    }
    await handle.chmod(0o700);
    const secured = await handle.stat();
    const after = await lstat(candidate);
    if (
      secured.dev !== opened.dev
      || secured.ino !== opened.ino
      || after.dev !== secured.dev
      || after.ino !== secured.ino
      || (secured.mode & 0o777) !== 0o700
    ) {
      throw new Error('Private state path identity changed');
    }
  } finally {
    await handle?.close();
  }
  return resolved;
}

async function resolveGitCommonDirectory(projectRoot, options, platformError) {
  const platform = process.platform === 'win32' ? 'win32' : (options.platform ?? process.platform);
  if (platform === 'win32') throw new UnsupportedStatePlatformError(platform);
  const cwd = resolve(projectRoot);
  const runner = options.runner ?? runArgv;
  const result = await runner('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    shell: false,
    timeoutMs: 3_000,
    maxOutputBytes: 4 * 1024,
  });
  const output = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (result?.code !== 0 || result?.timedOut || result?.truncated?.stdout || !output || output.includes('\0') || /[\r\n]/.test(output)) {
    throw new Error(platformError);
  }
  const unresolvedCommonDir = isAbsolute(output) ? output : resolve(cwd, output);
  const gitCommonDir = await realpath(unresolvedCommonDir);
  const commonMetadata = await lstat(gitCommonDir);
  if (!commonMetadata.isDirectory()) throw new Error('Git common directory is unsafe');
  return gitCommonDir;
}

function registerPaths(paths) {
  resolvedStatePaths.add(paths);
  return Promise.all([lstat(paths.stateRoot), lstat(paths.instanceDir)]).then(([stateRoot, instanceDir]) => {
    statePathIdentities.set(paths, { stateRoot, instanceDir });
    return paths;
  });
}

export async function resolveStatePaths(projectRoot, instance, options = {}) {
  if (typeof instance !== 'string' || instance.length > 64 || !INSTANCE_ID.test(instance)) {
    throw new TypeError('Invalid state instance identifier');
  }
  const gitCommonDir = await resolveGitCommonDirectory(projectRoot, options, 'Unable to resolve the Git common directory');

  const stateRoot = await createPrivateDirectory(join(gitCommonDir, 'rivet'), gitCommonDir);
  const instanceDir = await createPrivateDirectory(join(stateRoot, instance), gitCommonDir);
  if (!isWithin(stateRoot, instanceDir)) throw new Error('Private state path is unsafe');

  const paths = Object.freeze({
    gitCommonDir,
    stateRoot,
    instanceDir,
    eventsPath: join(instanceDir, 'events.jsonl'),
    snapshotPath: join(instanceDir, 'snapshot.json'),
    lockPath: join(instanceDir, 'state.lock'),
    runtimeLockPath: join(instanceDir, 'runtime.lock'),
  });
  return registerPaths(paths);
}

export async function resolveFeatureRunPaths(projectRoot, runId, options = {}) {
  if (typeof runId !== 'string' || runId.length > 64 || !INSTANCE_ID.test(runId)) {
    throw new TypeError('Invalid feature run identifier');
  }
  const gitCommonDir = await resolveGitCommonDirectory(projectRoot, options, 'Unable to resolve the Git common directory');
  const featureRoot = await createPrivateDirectory(join(gitCommonDir, 'rivet'), gitCommonDir);
  const featureRunsRoot = await createPrivateDirectory(join(featureRoot, 'feature-runs'), gitCommonDir);
  const runDir = await createPrivateDirectory(join(featureRunsRoot, runId), gitCommonDir);
  if (!isWithin(featureRunsRoot, runDir)) throw new Error('Private feature run path is unsafe');
  const paths = Object.freeze({
    gitCommonDir,
    featureRoot,
    featureRunsRoot,
    runId,
    runDir,
    stateRoot: featureRunsRoot,
    instanceDir: runDir,
    snapshotPath: join(runDir, 'run.json'),
    lockPath: join(runDir, 'run.lock'),
  });
  return registerPaths(paths);
}

export function assertResolvedStatePaths(paths) {
  if (!paths || typeof paths !== 'object' || !resolvedStatePaths.has(paths)) {
    throw new TypeError('State storage requires verified private state paths');
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function verifyResolvedStatePaths(paths) {
  assertResolvedStatePaths(paths);
  const expected = statePathIdentities.get(paths);
  const [stateRoot, instanceDir, resolvedRoot, resolvedInstance] = await Promise.all([
    lstat(paths.stateRoot),
    lstat(paths.instanceDir),
    realpath(paths.stateRoot),
    realpath(paths.instanceDir),
  ]);
  if (
    !stateRoot.isDirectory()
    || stateRoot.isSymbolicLink()
    || !instanceDir.isDirectory()
    || instanceDir.isSymbolicLink()
    || (stateRoot.mode & 0o777) !== 0o700
    || (instanceDir.mode & 0o777) !== 0o700
    || !sameIdentity(stateRoot, expected.stateRoot)
    || !sameIdentity(instanceDir, expected.instanceDir)
    || resolvedRoot !== paths.stateRoot
    || resolvedInstance !== paths.instanceDir
    || !isWithin(paths.gitCommonDir, resolvedInstance)
  ) {
    throw new Error('Private state path identity changed');
  }
}
