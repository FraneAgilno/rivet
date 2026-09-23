import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, relative } from 'node:path';

import { CLAUDE_ADAPTER_SYNTAX } from '../clients/claude.js';
import { CODEX_ADAPTER_SYNTAX } from '../clients/codex.js';
import { createProcessRunner } from '../clients/process-runner.js';

const ADAPTERS = Object.freeze({ claude: CLAUDE_ADAPTER_SYNTAX, codex: CODEX_ADAPTER_SYNTAX });

function inside(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
}

async function usable(path, projectRoot) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 1024 || /[\u0000\r\n]/.test(path)) return null;
  try {
    const canonical = await realpath(path);
    if (projectRoot && inside(projectRoot, canonical)) return null;
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return null;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch { return null; }
}

async function launchForm(executable, interpreter) {
  let handle;
  try {
    handle = await open(executable, 'r');
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const magic = header.subarray(0, 4).toString('hex');
    const native = process.platform === 'linux' ? magic === '7f454c46'
      : ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic);
    if (native) return interpreter === null ? 'eligible' : 'interpreter-unneeded';
    if (interpreter !== null) {
      const binary = await open(interpreter, 'r');
      try {
        const interpreterHeader = Buffer.alloc(4);
        await binary.read(interpreterHeader, 0, 4, 0);
        const interpreterMagic = interpreterHeader.toString('hex');
        const nativeInterpreter = process.platform === 'linux' ? interpreterMagic === '7f454c46'
          : ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(interpreterMagic);
        if (!nativeInterpreter) return 'interpreter-incompatible';
      } finally { await binary.close(); }
    }
    const newline = header.indexOf(0x0a);
    if (newline < 3 || newline > 256 || newline >= bytesRead) return 'executable-unsafe';
    const firstLine = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(0, newline));
    if (interpreter === null) return 'interpreter-required';
    if (firstLine === `#!${interpreter}`
      || (firstLine === '#!/usr/bin/env node' && basename(interpreter) === 'node')) return 'eligible';
    return 'interpreter-incompatible';
  } catch { return 'executable-unsafe'; }
  finally { await handle?.close(); }
}

async function candidates(kind, env, projectRoot) {
  const configured = env[`RIVET_${kind.toUpperCase()}_EXECUTABLE`];
  const entries = configured === undefined
    ? String(env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, kind))
    : [configured];
  const found = [];
  for (const entry of entries.slice(0, 128)) {
    const canonical = await usable(entry, projectRoot);
    if (canonical !== null && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

export async function discoverHarnesses({ env, projectRoot, runner, signal }) {
  const result = [];
  for (const [kind, syntax] of Object.entries(ADAPTERS)) {
    const paths = await candidates(kind, env, projectRoot);
    let selected = null;
    let reason = paths.length === 0 ? 'not-installed' : 'version-incompatible';
    for (const executable of paths) {
      const interpreterName = env[`RIVET_${kind.toUpperCase()}_INTERPRETER`];
      const interpreter = interpreterName === undefined ? null : await usable(interpreterName, projectRoot);
      if (interpreterName !== undefined && interpreter === null) { reason = 'interpreter-unavailable'; continue; }
      const form = await launchForm(executable, interpreter);
      if (form !== 'eligible') { reason = form; continue; }
      let observed;
      try {
        const probe = runner ? await runner(
          interpreter ?? executable,
          interpreter ? [executable, ...syntax.versionArgs] : [...syntax.versionArgs],
          { cwd: projectRoot, shell: false, timeoutMs: 3_000, maxOutputBytes: 4 * 1024, signal },
        ) : {
          code: 0,
          stdout: await (await createProcessRunner({
            executable, ...(interpreter ? { interpreter } : {}), worktree: projectRoot,
            environment: Object.fromEntries(
              ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'HOME', 'USER', 'LOGNAME', 'SHELL']
                .filter(key => env[key] !== undefined).map(key => [key, env[key]]),
            ),
            timeoutMs: 3_000, launchTimeoutMs: 3_000, maxOutputBytes: 4 * 1024, signal,
          })).probeVersion(),
          truncated: {},
        };
        if (probe.code !== 0 || probe.timedOut || probe.truncated?.stdout || probe.truncated?.stderr) continue;
        observed = String(probe.stdout || probe.stderr || '').trim();
      } catch { continue; }
      if (observed === syntax.observedVersion) {
        selected = Object.freeze({ kind, executable, ...(interpreter ? { interpreter } : {}), version: observed });
        break;
      }
    }
    result.push(Object.freeze(selected ?? { kind, available: false, reason }));
  }
  return Object.freeze(result);
}
