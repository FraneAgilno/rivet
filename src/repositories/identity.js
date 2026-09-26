import { resolve } from 'node:path';
import { boundedString, captureRecord, failProvider } from '../adapters/contract.js';
import { runArgv } from '../discovery/tools.js';

const HOSTS = Object.freeze({ 'github.com': 'github', 'bitbucket.org': 'bitbucket', 'gitlab.com': 'gitlab' });
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export function parseRepositoryRemote(input) {
  const value = boundedString(input, 2048);
  // Parse before URL normalization, which would otherwise silently remove traversal.
  const match = /^(?:https:\/\/|ssh:\/\/git@)([^/:?#]+)\/([^?#]+)$/.exec(value)
    ?? /^git@([^/:?#]+):([^?#]+)$/.exec(value);
  if (!match || !Object.hasOwn(HOSTS, match[1])) failProvider('invalid-request');
  const host = match[1];
  const fullName = match[2].replace(/\.git$/, '');
  const segments = fullName.split('/');
  if (segments.length < 2 || segments.length > 20 || fullName.length > 255
    || (host !== 'gitlab.com' && segments.length !== 2)
    || segments.some(part => !SEGMENT.test(part) || part === '.' || part === '..' || part.endsWith('.'))) failProvider('invalid-request');
  return Object.freeze({ provider: HOSTS[host], host, namespace: segments.slice(0, -1).join('/'), name: segments.at(-1), fullName, url: `https://${host}/${fullName}` });
}

export function selectRepositoryRemote(input, options = {}) {
  const { remoteName } = captureRecord(options, new Set(['remoteName']), []);
  if (remoteName !== undefined) boundedString(remoteName, 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) failProvider('invalid-request');
  const candidates = input.map(value => {
    const remote = captureRecord(value, new Set(['name', 'url']), ['name', 'url']);
    boundedString(remote.name, 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    return remote;
  }).filter(remote => remoteName === undefined || remote.name === remoteName);
  if (candidates.length === 0) failProvider('invalid-request');
  const parsed = candidates.map(remote => ({ ...parseRepositoryRemote(remote.url), remoteName: remote.name }));
  if (new Set(parsed.map(remote => remote.url)).size !== 1) failProvider('invalid-request');
  return Object.freeze(parsed[0]);
}

export async function discoverRepositoryRemotes(projectRoot, { runner = runArgv } = {}) {
  let result;
  try { result = await runner('git', ['remote', '-v'], { cwd: resolve(projectRoot), shell: false, timeoutMs: 3000, maxOutputBytes: 32768 }); }
  catch { failProvider('invalid-request'); }
  if (result?.code !== 0 || result.timedOut === true || result.truncated?.stdout === true || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 32768) failProvider('invalid-request');
  const remotes = [];
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const match = /^(\S+)\s+(\S+) \((fetch|push)\)$/.exec(line);
    if (!match) failProvider('invalid-request');
    if (match[3] === 'fetch') remotes.push(Object.freeze({ name: boundedString(match[1], 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/), url: boundedString(match[2], 2048) }));
  }
  if (remotes.length > 100) failProvider('invalid-request');
  return Object.freeze(remotes);
}

// Explicit per-operation choices do not rewrite the tracked onboarding preference.
export function selectConfiguredRepositoryRemote(remotes, preference, remoteName) {
  const selected = selectRepositoryRemote(remotes, remoteName !== undefined ? {remoteName}
    : preference ? {remoteName: preference.name} : {});
  if (remoteName === undefined && preference && selected.url !== preference.url) failProvider('invalid-request');
  return selected;
}
