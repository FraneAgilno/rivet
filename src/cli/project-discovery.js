import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { loadProjectConfig } from '../config/load.js';
import { runArgv } from '../discovery/tools.js';
import { CliError } from './output.js';

function fail(message) { throw new CliError(message, 'MISSING_CONFIGURATION'); }

async function gitRoot(directory, runner, env) {
  const result = await runner(await gitExecutable(env), ['rev-parse', '--show-toplevel'], {
    cwd: directory, shell: false, timeoutMs: 3_000, maxOutputBytes: 4 * 1024,
  });
  const output = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (result?.code !== 0 || result?.timedOut || result?.truncated?.stdout
    || !output.startsWith('/') || /[\u0000\r\n]/.test(output)) {
    fail('Run this command from a Git project configured by rivet setup, or pass --project.');
  }
  return realpath(output);
}

async function gitExecutable(env) {
  const configured = env.RIVET_GIT_EXECUTABLE;
  if (configured !== undefined) {
    if (!configured.startsWith('/') || /[\u0000\r\n]/.test(configured)) fail('Configured Git executable is invalid.');
    try { return await realpath(configured); }
    catch { fail('Configured Git executable is unavailable.'); }
  }
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  fail('Git is unavailable. Install Git or set RIVET_GIT_EXECUTABLE to its absolute path.');
}

export async function resolveConfiguredProject(cwd, explicit, options = {}) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')
    || (explicit !== undefined && (typeof explicit !== 'string' || !explicit || /[\u0000\r\n]/.test(explicit)))) {
    throw new CliError('Project path is invalid.', 'INVALID_INPUT');
  }
  let selected;
  try { selected = await realpath(resolve(cwd, explicit ?? '.')); }
  catch { fail('Project directory was not found. Run from a configured project or pass --project.'); }
  const root = await gitRoot(selected, options.runner ?? runArgv, options.env ?? process.env);
  if (explicit !== undefined && selected !== root) {
    throw new CliError('--project must name the configured Git project root.', 'INVALID_INPUT');
  }
  if (explicit === undefined) {
    const inside = relative(root, selected);
    if (inside === '..' || inside.startsWith(`..${sep}`)) fail('Current directory is outside the Git project.');
    let ancestor = selected;
    while (ancestor !== root) {
      const nested = await lstat(join(ancestor, '.rivet')).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (nested !== null) fail('A nested .rivet configuration is present. Pass the intended project root explicitly.');
      ancestor = dirname(ancestor);
    }
  }
  let configured;
  try {
    const marker = await lstat(join(root, '.rivet'));
    if (!marker.isDirectory() || marker.isSymbolicLink()) fail('Project .rivet configuration is unsafe.');
    configured = await loadProjectConfig(root);
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Rivet is not configured in this Git project. Run rivet setup --write first.');
  }
  return Object.freeze({ root, config: configured });
}
