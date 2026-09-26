import { resolve } from 'node:path';

import { runArgv } from './tools.js';

async function git(runner, cwd, args) {
  try {
    return await runner('git', args, {
      cwd,
      shell: false,
      timeoutMs: 3_000,
      maxOutputBytes: 32 * 1024,
    });
  } catch {
    return { code: 1, stdout: '', stderr: '' };
  }
}

function pathsFromWorktrees(output) {
  if (typeof output !== 'string' || !output.includes('\0')) return null;
  const records = output.split('\0\0').filter(Boolean);
  const paths = [];
  for (const record of records) {
    const fields = record.split('\0').filter(Boolean);
    if (!fields[0]?.startsWith('worktree ') || fields[0].length === 'worktree '.length) return null;
    paths.push(resolve(fields[0].slice('worktree '.length)));
  }
  return paths.length > 0 ? paths : null;
}

export async function discoverGit(projectRoot, options = {}) {
  const cwd = resolve(projectRoot);
  const runner = options.runner ?? runArgv;
  const rootResult = await git(runner, cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.code !== 0) {
    return {
      repository: false,
      root: null,
      currentBranch: null,
      defaultBranch: null,
      detached: false,
      dirty: false,
      baseFreshness: 'not_checked',
      worktrees: [],
      occupiedCandidatePaths: [],
      worktreeCheck: { checked: false, error: 'not_repository' },
    };
  }
  const [branchResult, statusResult, defaultResult, worktreeResult] = await Promise.all([
    git(runner, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(runner, cwd, ['status', '--porcelain']),
    git(runner, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    git(runner, cwd, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;
  const remoteHead = defaultResult.code === 0 ? defaultResult.stdout.trim() : '';
  const defaultBranch = options.defaultBranch ?? (remoteHead.replace(/^origin\//, '')
    || (currentBranch === 'main' || currentBranch === 'master' ? currentBranch : 'main'));
  const defaultBranchSource = options.defaultBranch !== undefined ? 'configuration' : remoteHead
    ? 'remote_tracking' : (currentBranch === 'main' || currentBranch === 'master') ? 'current_branch' : 'default';
  const freshnessResult = await git(runner, cwd, [
    'rev-list', '--left-right', '--count', `${defaultBranch}...refs/remotes/origin/${defaultBranch}`,
  ]);
  let baseFreshness = 'not_checked';
  if (freshnessResult.code === 0 && /^\d+\s+\d+$/.test(freshnessResult.stdout.trim())) {
    const [ahead = 0, behind = 0] = freshnessResult.stdout.trim().split(/\s+/).map(Number);
    baseFreshness = behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'fresh';
  }
  const worktrees = worktreeResult.code === 0 ? pathsFromWorktrees(worktreeResult.stdout) : null;
  const worktreeError = worktreeResult.timedOut === true
    ? 'timeout' : worktreeResult.code !== 0 ? 'unavailable' : worktrees === null ? 'malformed' : null;
  const candidates = (options.candidatePaths ?? []).map(path => resolve(path));
  return {
    repository: true,
    root: resolve(rootResult.stdout.trim()),
    currentBranch,
    defaultBranch,
    defaultBranchSource,
    detached: currentBranch === null,
    dirty: statusResult.code !== 0 || statusResult.stdout.trim().length > 0,
    baseFreshness,
    worktrees: worktrees ?? [],
    occupiedCandidatePaths: worktrees === null ? null : candidates.filter(path => worktrees.includes(path)),
    worktreeCheck: worktreeError ? { checked: false, error: worktreeError } : { checked: true },
  };
}
