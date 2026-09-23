import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { assertGitClient } from '../git/client.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { runCommand } from '../policy/commands.js';

const LOCKFILES = Object.freeze({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
});
const INSTALL_ARGS = Object.freeze({
  npm: ['ci'],
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install', '--frozen-lockfile'],
  bun: ['install', '--frozen-lockfile'],
});
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class WorktreeBootstrapError extends Error {
  constructor(reason) {
    const messages = {
      'invalid-input': 'Dependency setup input is invalid.',
      'unsafe-checkout': 'The isolated checkout changed or is unsafe. Inspect the task before retrying.',
      'missing-manifest': 'The isolated checkout has no safe package.json at its root.',
      'missing-lockfile': 'Commit the project lockfile before preparing isolated dependencies.',
      'ambiguous-lockfile': 'The project has multiple package manager lockfiles. Keep one matching the configured package manager.',
      'manager-mismatch': 'The project lockfile does not match its configured package manager.',
      'checkout-changed': 'Dependency setup changed tracked project files. Inspect the isolated checkout before continuing.',
      'approval-required': 'Locked dependencies need separate approval before the Worker starts. Use an interactive rivet task command.',
      'approval-declined': 'Dependency installation was declined. The Worker did not start.',
      'install-failed': 'Dependency installation failed in the isolated checkout. Inspect the package-manager output and retry.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'WorktreeBootstrapError';
    this.code = `ERR_WORKTREE_BOOTSTRAP_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new WorktreeBootstrapError(reason); }

function inputValue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-input');
  const keys = Reflect.ownKeys(input);
  const expected = ['projectRoot', 'worktreePath', 'expectedCommit', 'expectedBranch', 'manager'];
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) fail('invalid-input');
  const value = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-input');
    value[key] = descriptor.value;
  }
  if ([value.projectRoot, value.worktreePath].some(path => typeof path !== 'string' || !isAbsolute(path)
    || resolve(path) !== path || /[\u0000\r\n]/.test(path))
    || value.projectRoot === value.worktreePath
    || typeof value.expectedBranch !== 'string' || !value.expectedBranch || /[\u0000\r\n]/.test(value.expectedBranch)
    || !SHA.test(value.expectedCommit) || !Object.hasOwn(LOCKFILES, value.manager)) fail('invalid-input');
  return Object.freeze(value);
}

async function safeFile(path) {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n) fail('unsafe-checkout');
    const canonical = await realpath(path);
    const after = await lstat(path, { bigint: true });
    if (canonical !== path || !after.isFile() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) fail('unsafe-checkout');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('unsafe-checkout');
  }
}

async function checkout(value, gitClient) {
  let source;
  let isolated;
  try {
    [source, isolated] = await Promise.all([
      gitClient.inspectRepository(value.projectRoot), gitClient.inspectRepository(value.worktreePath),
    ]);
  } catch { fail('unsafe-checkout'); }
  if (source.root !== value.projectRoot || isolated.root !== value.worktreePath
    || source.repositoryId !== isolated.repositoryId || source.gitCommonDir !== isolated.gitCommonDir
    || source.branch === isolated.branch
    || isolated.branch !== value.expectedBranch || isolated.headSha !== value.expectedCommit
    || isolated.detached || isolated.dirty) fail('unsafe-checkout');
  const registered = (await gitClient.listWorktrees(value.projectRoot).catch(() => fail('unsafe-checkout')))
    .filter(item => item.path === value.worktreePath && item.branch === value.expectedBranch);
  if (registered.length !== 1 || registered[0].head !== value.expectedCommit) fail('unsafe-checkout');
}

export async function inspectWorktreeDependencies(input, options = {}) {
  const value = inputValue(input);
  const gitClient = options.gitClient;
  try { assertGitClient(gitClient); } catch { fail('invalid-input'); }
  await checkout(value, gitClient);
  if (!(await safeFile(join(value.worktreePath, 'package.json')))) fail('missing-manifest');
  const found = [];
  for (const [manager, names] of Object.entries(LOCKFILES)) {
    for (const name of names) if (await safeFile(join(value.worktreePath, name))) found.push({ manager, name });
  }
  if (found.length === 0) fail('missing-lockfile');
  if (found.length > 1) fail('ambiguous-lockfile');
  if (found[0].manager !== value.manager) fail('manager-mismatch');
  return Object.freeze({
    projectRoot: value.projectRoot,
    worktreePath: value.worktreePath,
    expectedCommit: value.expectedCommit,
    expectedBranch: value.expectedBranch,
    manager: value.manager,
    lockfile: found[0].name,
    args: Object.freeze([...INSTALL_ARGS[value.manager]]),
  });
}

export async function bootstrapWorktreeDependencies(input, options = {}) {
  const plan = await inspectWorktreeDependencies(input, options);
  if (typeof options.resolveCommandExecutable !== 'function' || typeof options.confirm !== 'function') fail('invalid-input');
  const executable = await options.resolveCommandExecutable(plan.manager);
  if (typeof executable !== 'string' || !isAbsolute(executable)) fail('invalid-input');
  const approved = await options.confirm(Object.freeze({
    manager: plan.manager, executable, args: plan.args, lockfile: plan.lockfile, worktreePath: plan.worktreePath,
  }));
  if (approved !== true) return Object.freeze({ status: 'declined' });
  const current = await inspectWorktreeDependencies(input, options);
  if (current.lockfile !== plan.lockfile || current.manager !== plan.manager) fail('unsafe-checkout');
  const nowMs = Date.now();
  const registry = createApprovalRegistry({ approvers: [{ id: 'human-owner', principal: 'human' }] });
  const approval = createApprovalReceipt({
    id: `approval-${randomUUID()}`,
    approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'rivet-bootstrap',
    action: 'dependency.install', resource: `command:install:${plan.worktreePath}`,
    policyId: 'dependency.install', decision: 'approved',
    expiresAt: new Date(nowMs + 60_000).toISOString(), singleUse: true,
  });
  const result = await runCommand({
    worktree: plan.worktreePath,
    authority: createAuthorityEnvelope({
      actorId: 'rivet-bootstrap', principal: 'agent', actions: ['dependency.install'],
      ownedPaths: [], providers: [], commands: ['install'],
    }),
    commands: { install: {
      executable, args: plan.args, action: 'dependency.install', elevated: true,
      approvalPolicyId: 'dependency.install', approverId: 'human-owner',
    } },
    environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 16 * 1024,
    maxStreamOutputBytes: 16 * 1024,
  }, { actorId: 'rivet-bootstrap', commandId: 'install', cwd: '.', approval, approvalRegistry: registry, nowMs },
  { signal: options.signal });
  const after = await options.gitClient.inspectRepository(plan.worktreePath).catch(() => fail('checkout-changed'));
  if (after.dirty || after.headSha !== plan.expectedCommit || after.branch !== plan.expectedBranch) fail('checkout-changed');
  return Object.freeze({ status: result.status === 'success' ? 'ready' : 'failed', result });
}
