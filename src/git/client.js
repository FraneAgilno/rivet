import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[\]\u0000-\u0020\u007f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const clients = new WeakSet();

export class GitClientError extends Error {
  constructor(reason = 'git-operation-failed') {
    const messages = {
      'invalid-client': 'Git client configuration is invalid.',
      'unsafe-executable': 'Git executable is unsafe.',
      'invalid-input': 'Git operation input is invalid.',
      'git-operation-failed': 'Git operation failed safely.',
      'git-timeout': 'Git operation timed out.',
      'git-output-invalid': 'Git returned invalid or excessive output.',
      'executable-config': 'Repository Git configuration may execute local code.',
      'repository-path-unsafe': 'Repository contains a noncanonical or ambiguous path.',
      'repository-unsafe': 'Git repository identity is unsafe.',
      'repository-changed': 'Git repository identity changed.',
      'non-fast-forward': 'Integration is not a fast-forward.',
    };
    super(messages[reason] ?? messages['git-operation-failed']);
    this.name = 'GitClientError';
    this.code = `ERR_GIT_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new GitClientError(reason); }

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validPath(value) {
  return typeof value === 'string' && value.length > 1 && value.length <= 1_024
    && isAbsolute(value) && !/[\u0000\r\n]/.test(value);
}

function absoluteInput(value) {
  if (!validPath(value) || resolve(value) !== value) fail('invalid-input');
  return value;
}

function validBranch(value) {
  return typeof value === 'string' && value.length <= 200 && BRANCH.test(value)
    && value.normalize('NFKC') === value;
}

function validSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function captureRecord(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-input'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-input');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail('invalid-input');
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof GitClientError) throw error;
    fail('invalid-input');
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-input');
  return Object.freeze(result);
}

function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail('git-output-invalid');
  }
}

function execute(executable, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || !validPath(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 1024 * 1024) {
    fail('invalid-input');
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let excessive = false;
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=',
      '-c', 'protocol.file.allow=never',
      ...args,
    ], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
        LC_ALL: 'C',
      },
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const collect = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, maxOutputBytes - bytes);
      if (available > 0) chunks.push(buffer.subarray(0, available));
      bytes += Math.min(buffer.byteLength, available);
      if (buffer.byteLength > available) excessive = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => finish(new GitClientError('git-operation-failed')));
    child.once('close', code => {
      if (timedOut) return finish(new GitClientError('git-timeout'));
      if (excessive) return finish(new GitClientError('git-output-invalid'));
      finish(null, Object.freeze({ code: code ?? 1, output: decode(Buffer.concat(chunks)) }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
  });
}

async function verifiedDirectory(path, reason = 'repository-unsafe') {
  if (!validPath(path) || resolve(path) !== path) fail(reason);
  let before;
  try { before = await lstat(path, { bigint: true }); } catch { fail(reason); }
  if (!before.isDirectory() || before.isSymbolicLink()) fail(reason);
  let canonical;
  try { canonical = await realpath(path); } catch { fail(reason); }
  const after = await lstat(path, { bigint: true });
  if (canonical !== path || !after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) fail(reason);
  return Object.freeze({
    path,
    dev: after.dev.toString(),
    ino: after.ino.toString(),
  });
}

async function verifyExecutable(path) {
  if (!validPath(path) || resolve(path) !== path) fail('unsafe-executable');
  let before;
  try { before = await lstat(path, { bigint: true }); } catch { fail('unsafe-executable'); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o111n) === 0n) {
    fail('unsafe-executable');
  }
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (canonical !== path || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameIdentity(before, after)) {
    fail('unsafe-executable');
  }
  return Object.freeze({ path, dev: after.dev.toString(), ino: after.ino.toString() });
}

function oneLine(output) {
  const value = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (!value || /[\u0000\r\n]/.test(value)) fail('git-output-invalid');
  return value;
}

function repositoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024
    || isAbsolute(value) || value.normalize('NFKC') !== value
    || /[\u0000-\u001f\u007f\\:]/.test(value) || value.startsWith('/') || value.endsWith('/')
    || value.includes('//')) fail('repository-path-unsafe');
  const parts = value.split('/');
  if (parts.some(part => (
    !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    || part.toUpperCase().toLowerCase().normalize('NFKC') === '.git'
  ))) fail('repository-path-unsafe');
  return value;
}

function diffPaths(output) {
  if (output === '') return Object.freeze([]);
  if (!output.endsWith('\0')) fail('git-output-invalid');
  const fields = output.slice(0, -1).split('\0');
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (!/^[ACDMRTUXB](?:[0-9]{1,3})?$/.test(status)) fail('git-output-invalid');
    const endpointCount = status[0] === 'R' || status[0] === 'C' ? 2 : 1;
    for (let endpoint = 0; endpoint < endpointCount; endpoint += 1) {
      const path = fields[index];
      index += 1;
      paths.push(repositoryPath(path));
    }
  }
  if (paths.length > 8_192) fail('git-output-invalid');
  return Object.freeze([...new Set(paths)].sort());
}

function parseStatusPaths(output) {
  if (output === '') return Object.freeze([]);
  if (!output.endsWith('\0')) fail('git-output-invalid');
  const records = output.slice(0, -1).split('\0');
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') fail('git-output-invalid');
    const path = record.slice(3);
    // Git represents an ignored directory as a synthetic path with a trailing
    // slash (for example, `!! node_modules/`). It is a directory marker, not
    // an evidence path; ignored files inside it are still reported separately.
    if (!(record[0] === '!' && record[1] === '!' && path.endsWith('/'))) {
      paths.push(repositoryPath(path));
    }
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') {
      index += 1;
      if (!records[index]) fail('git-output-invalid');
      paths.push(repositoryPath(records[index]));
    }
  }
  if (paths.length > 4_096) fail('git-output-invalid');
  return Object.freeze([...new Set(paths)].sort());
}

function parseWorktrees(output) {
  if (!output.endsWith('\0')) fail('git-output-invalid');
  const fields = output.split('\0');
  const records = [];
  let record = null;
  for (const field of fields) {
    if (field === '') continue;
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? true : field.slice(space + 1);
    if (key === 'worktree') {
      if (record) records.push(record);
      record = Object.create(null);
    }
    if (!record || Object.hasOwn(record, key)) fail('git-output-invalid');
    record[key] = value;
  }
  if (record) records.push(record);
  if (records.length === 0 || records.length > 1_024) fail('git-output-invalid');
  return Object.freeze(records.map(item => {
    if (!validPath(item.worktree) || resolve(item.worktree) !== item.worktree || !validSha(item.HEAD)) fail('git-output-invalid');
    const branch = typeof item.branch === 'string' && item.branch.startsWith('refs/heads/')
      ? item.branch.slice('refs/heads/'.length) : null;
    if (branch !== null && !validBranch(branch)) fail('git-output-invalid');
    return Object.freeze({ path: item.worktree, head: item.HEAD, branch, detached: item.detached === true });
  }));
}

function repositoryId(common) {
  return createHash('sha256').update(`${common.path}\0${common.dev}\0${common.ino}`).digest('hex');
}

export async function createGitClient(options = {}) {
  let captured;
  try { captured = captureRecord(options, new Set(['gitExecutable', 'timeoutMs', 'maxOutputBytes']), ['gitExecutable']); }
  catch { fail('invalid-client'); }
  const executable = await verifyExecutable(captured.gitExecutable);
  const timeoutMs = captured.timeoutMs ?? TIMEOUT_MS;
  const maxOutputBytes = captured.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  async function assertNoExecutableConfig(cwd) {
    const pattern = '^(alias\\.|filter\\.|diff\\.|merge\\.|credential\\.|include\\.|includeif\\.|pager\\.|gpg\\.|sequence\\.editor$|core\\.(fsmonitor|hookspath|editor|pager|sshcommand|worktree)$)';
    const inspectScope = async scope => {
      const result = await execute(executable.path, [
        'config', scope, '--no-includes', '--null', '--name-only', '--get-regexp', pattern,
      ], cwd, { timeoutMs, maxOutputBytes });
      if (result.code !== 0 && result.code !== 1) throw new GitClientError('git-operation-failed');
      if (result.code === 0) {
        if (!result.output.endsWith('\0')) fail('git-output-invalid');
        const keys = result.output.slice(0, -1).split('\0');
        if (keys.length === 0 || keys.some(key => !key || key.length > 500 || /[\u0000\r\n]/.test(key))) fail('git-output-invalid');
        fail('executable-config');
      }
      if (result.output !== '') fail('git-output-invalid');
    };
    await inspectScope('--local');
    const extension = await execute(executable.path, [
      'config', '--local', '--no-includes', '--type=bool', '--get', 'extensions.worktreeConfig',
    ], cwd, { timeoutMs, maxOutputBytes });
    if (extension.code !== 0 && extension.code !== 1) throw new GitClientError('git-operation-failed');
    if (extension.code === 0) {
      if (extension.output === 'true\n') await inspectScope('--worktree');
      else if (extension.output !== 'false\n') fail('git-output-invalid');
    }
  }

  async function run(cwd, args, allowedCodes = [0]) {
    const current = await verifyExecutable(executable.path);
    if (current.dev !== executable.dev || current.ino !== executable.ino) fail('unsafe-executable');
    await assertNoExecutableConfig(cwd);
    const result = await execute(executable.path, args, cwd, { timeoutMs, maxOutputBytes });
    if (!allowedCodes.includes(result.code)) throw new GitClientError('git-operation-failed');
    return result;
  }

  const client = {
    async inspectRepository(cwdInput) {
      const cwd = absoluteInput(cwdInput);
      const rootResult = await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
      const commonResult = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const root = await verifiedDirectory(oneLine(rootResult.output));
      const common = await verifiedDirectory(oneLine(commonResult.output));
      const [head, branch, status] = await Promise.all([
        run(root.path, ['rev-parse', '--verify', 'HEAD^{commit}']),
        run(root.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]),
        run(root.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      ]);
      const headSha = oneLine(head.output);
      if (!validSha(headSha)) fail('git-output-invalid');
      const branchName = branch.code === 0 ? oneLine(branch.output) : null;
      if (branchName !== null && !validBranch(branchName)) fail('git-output-invalid');
      const dirtyPaths = parseStatusPaths(status.output);
      return Object.freeze({
        root: root.path,
        rootIdentity: Object.freeze({ dev: root.dev, ino: root.ino }),
        gitCommonDir: common.path,
        repositoryId: repositoryId(common),
        headSha,
        branch: branchName,
        detached: branchName === null,
        dirty: dirtyPaths.length > 0,
        dirtyPaths,
      });
    },

    async listWorktrees(repoRoot) {
      const root = absoluteInput(repoRoot);
      const result = await run(root, ['worktree', 'list', '--porcelain', '-z']);
      return parseWorktrees(result.output);
    },

    async branchTip(repoRoot, branch) {
      if (!validBranch(branch)) fail('invalid-input');
      const result = await run(absoluteInput(repoRoot), ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], [0, 128]);
      if (result.code !== 0) return null;
      const sha = oneLine(result.output);
      if (!validSha(sha)) fail('git-output-invalid');
      return sha;
    },

    async createWorktree(repoRoot, input) {
      const value = captureRecord(input, new Set(['path', 'branch', 'baseSha']), ['path', 'branch', 'baseSha']);
      if (!validPath(value.path) || !validBranch(value.branch) || !validSha(value.baseSha)) fail('invalid-input');
      await run(absoluteInput(repoRoot), ['worktree', 'add', '--quiet', '-b', value.branch, value.path, value.baseSha]);
    },

    async rollbackWorktreeCreation(repoRoot, input) {
      const value = captureRecord(input, new Set(['path', 'branch', 'baseSha']), ['path', 'branch', 'baseSha']);
      if (!validPath(value.path) || !validBranch(value.branch) || !validSha(value.baseSha)) fail('invalid-input');
      const root = absoluteInput(repoRoot);
      const topology = await client.listWorktrees(root);
      const atPath = topology.filter(item => item.path === value.path);
      const onBranch = topology.filter(item => item.branch === value.branch);
      if (atPath.length > 1 || onBranch.length > 1
        || atPath.some(item => item.branch !== value.branch || item.head !== value.baseSha)
        || onBranch.some(item => item.path !== value.path || item.head !== value.baseSha)) fail('repository-changed');
      if (atPath.length === 1) {
        const worker = await client.inspectRepository(value.path);
        if (worker.dirty || worker.branch !== value.branch || worker.headSha !== value.baseSha) fail('repository-changed');
        await run(root, ['worktree', 'remove', value.path]);
      }
      const tip = await client.branchTip(root, value.branch);
      if (tip === null) return;
      if (tip !== value.baseSha) fail('repository-changed');
      await run(root, ['branch', '-d', value.branch]);
    },

    async changedPaths(cwd, fromSha, toSha) {
      if (!validSha(fromSha) || !validSha(toSha)) fail('invalid-input');
      const result = await run(absoluteInput(cwd), [
        'diff', '--name-status', '-z', '--find-renames', '--find-copies-harder',
        '--diff-filter=ACDMRTUXB', fromSha, toSha, '--',
      ]);
      return diffPaths(result.output);
    },

    async statusPaths(cwd) {
      const result = await run(absoluteInput(cwd), [
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
      ]);
      return parseStatusPaths(result.output);
    },

    async commitPaths(cwdInput, input) {
      const value = captureRecord(input, new Set(['paths', 'expectedHeadSha', 'branch', 'message']), [
        'paths', 'expectedHeadSha', 'branch', 'message',
      ]);
      if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 256
        || value.paths.some(path => typeof path !== 'string' || path !== repositoryPath(path))
        || !validSha(value.expectedHeadSha) || !validBranch(value.branch)
        || typeof value.message !== 'string' || value.message.length === 0 || value.message.length > 200
        || /[\u0000\r\n]/.test(value.message)) fail('invalid-input');
      const cwd = absoluteInput(cwdInput);
      const before = await client.inspectRepository(cwd);
      if (before.branch !== value.branch || before.headSha !== value.expectedHeadSha) fail('repository-changed');
      if (!before.dirty) return before;
      await run(before.root, ['add', '--', ...value.paths]);
      const staged = await run(before.root, [
        'diff', '--cached', '--name-status', '-z', '--find-renames', '--find-copies-harder',
        '--diff-filter=ACDMRTUXB', '--',
      ]);
      const stagedPaths = diffPaths(staged.output);
      if (stagedPaths.length === 0) return client.inspectRepository(before.root);
      if (stagedPaths.some(path => !value.paths.includes(path))) fail('repository-changed');
      await run(before.root, [
        '-c', 'user.name=Rivet Worker',
        '-c', 'user.email=rivet-worker@invalid',
        'commit', '--quiet', '-m', value.message,
      ]);
      const after = await client.inspectRepository(before.root);
      if (after.branch !== value.branch || after.headSha === before.headSha || after.dirty) fail('repository-changed');
      return after;
    },

    async isAncestor(cwd, ancestorSha, descendantSha) {
      if (!validSha(ancestorSha) || !validSha(descendantSha)) fail('invalid-input');
      const result = await run(absoluteInput(cwd), ['merge-base', '--is-ancestor', ancestorSha, descendantSha], [0, 1]);
      return result.code === 0;
    },

    async fastForward(cwd, input) {
      const value = captureRecord(input, new Set(['branch', 'expectedTip', 'newTip']), ['branch', 'expectedTip', 'newTip']);
      if (!validBranch(value.branch) || !validSha(value.expectedTip) || !validSha(value.newTip)) fail('invalid-input');
      const before = await client.inspectRepository(absoluteInput(cwd));
      if (before.dirty || before.detached || before.branch !== value.branch || before.headSha !== value.expectedTip) {
        fail('repository-changed');
      }
      if (!(await client.isAncestor(before.root, value.expectedTip, value.newTip))) fail('non-fast-forward');
      await run(before.root, ['merge', '--ff-only', '--no-edit', value.newTip]);
      const after = await client.inspectRepository(before.root);
      if (after.branch !== value.branch || after.headSha !== value.newTip || after.dirty) fail('repository-changed');
      return after;
    },
  };
  // Avoid allowing forged objects into higher-level worktree APIs.
  Object.defineProperty(client, 'isTrustedGitClient', { value: true, enumerable: false });
  Object.freeze(client);
  clients.add(client);
  return client;
}

// Kept internal to this module's trust boundary; consumers receive only a boolean.
export function assertGitClient(client) {
  if (!clients.has(client)) throw new GitClientError('invalid-client');
}
