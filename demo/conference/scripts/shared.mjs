import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const CHECKPOINT = /^(?:baseline|corrected|verified)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export class ConferenceDemoError extends Error {
  constructor(reason = 'invalid-input') {
    super('Conference demo operation is invalid.');
    this.name = 'ConferenceDemoError';
    this.code = 'ERR_CONFERENCE_DEMO_INVALID';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

export function fail(reason) {
  throw new ConferenceDemoError(reason);
}

export function checkpointName(value) {
  if (typeof value !== 'string' || !CHECKPOINT.test(value)) fail('checkpoint-name');
  return value;
}

export function commitId(value) {
  if (typeof value !== 'string' || !COMMIT.test(value)) fail('commit-id');
  return value;
}

export function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function exactDirectory(value, reason = 'directory') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) fail(reason);
  const resolved = path.resolve(value);
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(reason);
    const canonical = await realpath(resolved);
    const canonicalMetadata = await lstat(canonical);
    if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()
      || !sameIdentity(metadata, canonicalMetadata)) fail(reason);
    return canonical;
  } catch (error) {
    if (error instanceof ConferenceDemoError) throw error;
    fail(reason);
  }
}

function cleanGitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) environment[key] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

export async function git(repositoryRoot, args, { optional = false } = {}) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) fail('git-arguments');
  try {
    const result = await execFile('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      env: cleanGitEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    if (optional) return null;
    fail('git-operation');
  }
}

export async function exactRepository(value) {
  const root = await exactDirectory(value, 'repository');
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (path.resolve(top) !== root) fail('repository-root');
  return root;
}

export async function trackedClean(repositoryRoot, { allowDemoState = false } = {}) {
  const status = await git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status === '') return;
  if (allowDemoState) {
    const lines = status.split('\n');
    if (lines.every(line => /^(?:\?\?) demo\/conference\/\.state(?:-archive)?\//.test(line))) return;
  }
  fail('dirty-repository');
}

export async function repositoryHead(repositoryRoot) {
  return commitId(await git(repositoryRoot, ['rev-parse', 'HEAD']));
}

export async function regularFile(root, relativePath, maximumBytes = 128 * 1024) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('..') || relativePath.includes('\\')) fail('file-path');
  const absolutePath = path.join(root, relativePath);
  let descriptor;
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) fail('file');
    const canonical = await realpath(absolutePath);
    const canonicalMetadata = await lstat(canonical);
    if (!sameIdentity(metadata, canonicalMetadata)) fail('file');
    descriptor = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await descriptor.stat();
    if (!opened.isFile() || !sameIdentity(metadata, opened) || opened.size !== metadata.size) fail('file');
    return Object.freeze({ path: canonical, size: opened.size });
  } catch (error) {
    if (error instanceof ConferenceDemoError) throw error;
    fail('file');
  } finally {
    if (descriptor) {
      try { await descriptor.close(); } catch { fail('file-close'); }
    }
  }
}
