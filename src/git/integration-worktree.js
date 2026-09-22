import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { assertGitClient } from './client.js';
import { assertResolvedStatePaths, verifyResolvedStatePaths } from '../state/paths.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[\]\u0000-\u0020\u007f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PROTECTED = /^(?:main|master|trunk|develop|development|production|release(?:\/.*)?)$/i;

export class IntegrationWorktreeError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Integration worktree request is invalid.',
      'unsafe-path': 'Integration worktree path is unsafe.',
      'baseline-drift': 'Approved integration baseline no longer matches the source repository.',
      'dirty-source': 'Source checkout must be clean before feature execution.',
      'dirty-integration': 'Integration worktree must be clean before feature execution resumes.',
      'topology-drift': 'Integration worktree topology changed and requires review.',
      'branch-collision': 'Integration branch already exists at another worktree.',
      'path-collision': 'Integration worktree path is already in use.',
      'create-failed': 'Integration worktree could not be created safely.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'IntegrationWorktreeError';
    this.code = `ERR_INTEGRATION_WORKTREE_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new IntegrationWorktreeError(reason); }

function capture(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-input');
    const allowed = new Set(['projectRoot', 'statePaths', 'branch', 'worktreePath', 'baseSha']);
    const keys = Reflect.ownKeys(input);
    if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-input');
    const value = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-input');
      value[key] = descriptor.value;
    }
    if (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot) || resolve(value.projectRoot) !== value.projectRoot
      || typeof value.worktreePath !== 'string' || !isAbsolute(value.worktreePath) || resolve(value.worktreePath) !== value.worktreePath
      || typeof value.branch !== 'string' || value.branch.normalize('NFKC') !== value.branch || !BRANCH.test(value.branch)
      || PROTECTED.test(value.branch) || !SHA.test(value.baseSha)) fail('invalid-input');
    assertResolvedStatePaths(value.statePaths);
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof IntegrationWorktreeError) throw error;
    fail('invalid-input');
  }
}

async function secureDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') fail('unsafe-path'); }
  let before;
  let canonical;
  let after;
  try {
    before = await lstat(path, { bigint: true });
    canonical = await realpath(path);
    after = await lstat(path, { bigint: true });
  } catch { fail('unsafe-path'); }
  if (canonical !== path || !before.isDirectory() || before.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino || (after.mode & 0o777n) !== 0o700n) fail('unsafe-path');
  return path;
}

async function secureParent(value, repositoryId) {
  await verifyResolvedStatePaths(value.statePaths).catch(() => fail('unsafe-path'));
  const workspaceRoot = await secureDirectory(join(dirname(value.projectRoot), '.rivet-worktrees'));
  const repositoryRoot = await secureDirectory(join(workspaceRoot, repositoryId));
  const runRoot = await secureDirectory(join(repositoryRoot, basename(value.statePaths.instanceDir)));
  if (value.worktreePath !== join(runRoot, 'integration')) fail('unsafe-path');
}

function result(value, repository, integration, reused) {
  return Object.freeze({
    branch: value.branch,
    path: value.worktreePath,
    baseSha: value.baseSha,
    headSha: integration.headSha,
    repositoryId: repository.repositoryId,
    reused,
  });
}

export async function prepareIntegrationWorktree(input, options = {}) {
  const value = capture(input);
  let gitClient;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'gitClient')) fail('invalid-input');
    gitClient = options.gitClient;
    assertGitClient(gitClient);
  } catch (error) {
    if (error instanceof IntegrationWorktreeError) throw error;
    fail('invalid-input');
  }
  let repository;
  try { repository = await gitClient.inspectRepository(value.projectRoot); } catch { fail('topology-drift'); }
  if (repository.root !== value.projectRoot || repository.gitCommonDir !== value.statePaths.gitCommonDir
    || repository.detached) fail('topology-drift');
  if (repository.dirty) fail('dirty-source');
  if (repository.headSha !== value.baseSha) fail('baseline-drift');
  await secureParent(value, repository.repositoryId);

  const topology = await gitClient.listWorktrees(repository.root).catch(() => fail('topology-drift'));
  const atPath = topology.filter(item => item.path === value.worktreePath);
  const onBranch = topology.filter(item => item.branch === value.branch);
  if (atPath.length > 1 || onBranch.length > 1) fail('topology-drift');
  if (atPath.length === 1 || onBranch.length === 1) {
    if (atPath.length !== 1 || onBranch.length !== 1 || atPath[0] !== onBranch[0]) fail(atPath.length ? 'path-collision' : 'branch-collision');
    let integration;
    try { integration = await gitClient.inspectRepository(value.worktreePath); } catch { fail('topology-drift'); }
    if (integration.repositoryId !== repository.repositoryId || integration.gitCommonDir !== repository.gitCommonDir
      || integration.root !== value.worktreePath || integration.branch !== value.branch || integration.detached) fail('topology-drift');
    if (integration.dirty) fail('dirty-integration');
    if (!(await gitClient.isAncestor(integration.root, value.baseSha, integration.headSha))) fail('baseline-drift');
    return result(value, repository, integration, true);
  }

  if (await gitClient.branchTip(repository.root, value.branch) !== null) fail('branch-collision');
  try {
    await lstat(value.worktreePath);
    fail('path-collision');
  } catch (error) {
    if (error instanceof IntegrationWorktreeError) throw error;
    if (error?.code !== 'ENOENT') fail('unsafe-path');
  }
  try {
    await gitClient.createWorktree(repository.root, {
      path: value.worktreePath,
      branch: value.branch,
      baseSha: value.baseSha,
    });
    const integration = await gitClient.inspectRepository(value.worktreePath);
    const matches = (await gitClient.listWorktrees(repository.root))
      .filter(item => item.path === value.worktreePath && item.branch === value.branch && item.head === value.baseSha);
    if (matches.length !== 1 || integration.repositoryId !== repository.repositoryId
      || integration.gitCommonDir !== repository.gitCommonDir || integration.headSha !== value.baseSha || integration.dirty) {
      fail('topology-drift');
    }
    return result(value, repository, integration, false);
  } catch (error) {
    if (error instanceof IntegrationWorktreeError) throw error;
    fail('create-failed');
  }
}
