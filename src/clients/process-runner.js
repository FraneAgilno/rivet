import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AgentContractError, containsSecretMaterial, failAgent, immutableJson } from './contract.js';
import { validateLaunchPayload } from '../prompts/launch-contract.js';
import { parsePlanningResult, validatePlanningPayload } from '../prompts/planning-contract.js';

const CONFIG_KEYS = new Set(['executable', 'interpreter', 'worktree', 'worktreeIdentity', 'environment', 'signal', 'launchTimeoutMs', 'timeoutMs', 'termGraceMs', 'killGraceMs', 'maxOutputBytes', 'maxInputBytes', 'allowOptionArgs']);
const REQUEST_KEYS = new Set(['args', 'cwd', 'payload', 'signal']);
// Keep the provider environment narrow, but preserve the non-secret account
// context required by native macOS clients to resolve their local login
// (Claude Code uses HOME and the shell identity variables when consulting its
// Keychain-backed session). Credential/token variables remain excluded below.
const SAFE_ENV = new Set(['LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL']);
const SENSITIVE_ENV = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_KEY|ACCESS_KEY|PRIVATE_KEY|KEY)(?:_|$)/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function assertSupportedClientPlatform(platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') failAgent('unsupported-platform');
}

function capture(input, keys, required, reason) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failAgent(reason);
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(input); } catch { failAgent(reason); }
  if (ownKeys.some(key => typeof key !== 'string' || !keys.has(key))) failAgent(reason);
  const output = Object.create(null);
  try {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent(reason);
      output[key] = input[key];
    }
  } catch { failAgent(reason); }
  if (required.some(key => !Object.hasOwn(output, key))) failAgent(reason);
  return output;
}

function boundedInteger(value, fallback, maximum, reason = 'invalid-contract') {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) failAgent(reason);
  return result;
}

function captureSignal(value, reason = 'invalid-contract') {
  try {
    if (value !== undefined && (!(value instanceof AbortSignal) || Object.getPrototypeOf(value) !== AbortSignal.prototype)) failAgent(reason);
    return value;
  } catch { failAgent(reason); }
}

function signalAborted(signal, reason = 'invalid-contract') {
  if (!signal) return false;
  try { return signal.aborted === true; } catch { failAgent(reason); }
}

function watchSignal(signal, onAbort, reason = 'invalid-contract') {
  if (!signal) return () => {};
  let installed = false;
  try {
    signal.addEventListener('abort', onAbort, { once: true });
    installed = true;
    if (signal.aborted) onAbort();
  } catch {
    if (installed) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
    failAgent(reason);
  }
  return () => {
    try { signal.removeEventListener('abort', onAbort); } catch {}
  };
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function identity(metadata) { return Object.freeze({ dev: metadata.dev.toString(), ino: metadata.ino.toString() }); }

async function verifyExecutable(path, expected, guard = () => {}) {
  if (typeof path !== 'string' || path.length < 2 || path.length > 1024 || !isAbsolute(path) || resolve(path) !== path || /[\u0000\r\n]/.test(path)) failAgent('executable-unsafe');
  try {
    const before = await lstat(path, { bigint: true });
    guard();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o111n) === 0n) failAgent('executable-unsafe');
    const canonical = await realpath(path);
    guard();
    const after = await lstat(path, { bigint: true });
    guard();
    if (canonical !== path || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameIdentity(before, after)) failAgent('executable-unsafe');
    const current = Object.freeze({
      ...identity(after), size: after.size.toString(), mode: after.mode.toString(),
      mtimeMs: after.mtimeMs.toString(), ctimeMs: after.ctimeMs.toString(),
    });
    if (expected && Reflect.ownKeys(current).some(key => expected[key] !== current[key])) failAgent('executable-unsafe');
    return current;
  } catch (error) {
    if (error instanceof AgentContractError) throw error;
    if (error?.code === 'ENOENT') failAgent('provider-unavailable');
    failAgent('executable-unsafe');
  }
}

function sameSnapshot(left, right) {
  return left && right && Reflect.ownKeys(left).length === Reflect.ownKeys(right).length
    && Reflect.ownKeys(left).every(key => left[key] === right[key]);
}

function nativeHeader(header) {
  const magic = header.subarray(0, 4).toString('hex');
  if (process.platform === 'linux') return magic === '7f454c46';
  return ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic);
}

async function readPinnedHeader(path, expectedIdentity, guard = () => {}) {
  let handle;
  try {
    handle = await open(path, 'r');
    guard();
    const metadata = await handle.stat({ bigint: true });
    guard();
    const current = Object.freeze({
      ...identity(metadata), size: metadata.size.toString(), mode: metadata.mode.toString(),
      mtimeMs: metadata.mtimeMs.toString(), ctimeMs: metadata.ctimeMs.toString(),
    });
    if (!sameSnapshot(current, expectedIdentity)) failAgent('executable-unsafe');
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    guard();
    return header.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof AgentContractError) throw error;
    failAgent('executable-unsafe');
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function inspectNativeInterpreter(path, expectedIdentity, guard = () => {}) {
  const interpreterIdentity = await verifyExecutable(path, expectedIdentity, guard);
  const header = await readPinnedHeader(path, interpreterIdentity, guard);
  await verifyExecutable(path, interpreterIdentity, guard);
  guard();
  if (!nativeHeader(header)) failAgent('executable-unsafe');
  return interpreterIdentity;
}

async function inspectLaunchTarget(executable, interpreter, expected, guard = () => {}) {
  const executableIdentity = await verifyExecutable(executable, expected?.executableIdentity, guard);
  const header = await readPinnedHeader(executable, executableIdentity, guard);
  await verifyExecutable(executable, executableIdentity, guard);
  guard();
  let target;
  if (nativeHeader(header)) {
    if (interpreter !== undefined) failAgent('executable-unsafe');
    target = Object.freeze({
      kind: 'native', executableIdentity, interpreterIdentity: null,
      spawnExecutable: executable, scriptPath: null,
    });
  } else {
    let firstLine;
    try {
      const newline = header.indexOf(0x0a);
      if (newline < 3 || newline > 256) failAgent('executable-unsafe');
      firstLine = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(0, newline));
    } catch { failAgent('executable-unsafe'); }
    const pinnedShebang = typeof interpreter === 'string' && firstLine === `#!${interpreter}`;
    const npmNodeShebang = firstLine === '#!/usr/bin/env node' && typeof interpreter === 'string' && basename(interpreter) === 'node';
    if (!pinnedShebang && !npmNodeShebang) failAgent('executable-unsafe');
    const interpreterIdentity = await inspectNativeInterpreter(interpreter, expected?.interpreterIdentity, guard);
    target = Object.freeze({
      kind: 'script', executableIdentity, interpreterIdentity,
      spawnExecutable: interpreter, scriptPath: executable,
    });
  }
  if (expected && (expected.kind !== target.kind || expected.spawnExecutable !== target.spawnExecutable
    || expected.scriptPath !== target.scriptPath)) failAgent('executable-unsafe');
  return target;
}

function invocation(target, args) {
  return target.kind === 'script'
    ? Object.freeze({ executable: target.spawnExecutable, args: Object.freeze([target.scriptPath, ...args]) })
    : Object.freeze({ executable: target.spawnExecutable, args });
}

async function verifyDirectory(path, expected, reason = 'cwd-unsafe', guard = () => {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.length > 1024) failAgent(reason);
  try {
    const before = await lstat(path, { bigint: true });
    guard();
    if (!before.isDirectory() || before.isSymbolicLink()) failAgent(reason);
    const canonical = await realpath(path);
    guard();
    const after = await lstat(path, { bigint: true });
    guard();
    if (canonical !== path || !after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) failAgent(reason);
    const current = identity(after);
    if (expected && (expected.dev !== current.dev || expected.ino !== current.ino)) failAgent(reason);
    return current;
  } catch (error) {
    if (error instanceof AgentContractError) throw error;
    failAgent(reason);
  }
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function verifyCwd(worktree, value, guard = () => {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || isAbsolute(value)
    || value.includes('//') || value.includes('\\') || value.includes(':') || /[\u0000-\u001f\u007f]/.test(value)) failAgent('cwd-unsafe');
  const normalized = value.normalize('NFKC');
  if (normalized !== value) failAgent('cwd-unsafe');
  const parts = value === '.' ? [] : value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED.test(part))) failAgent('cwd-unsafe');
  let cursor = worktree;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const metadata = await lstat(cursor, { bigint: true });
      guard();
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) failAgent('cwd-unsafe');
    } catch (error) {
      if (error instanceof AgentContractError) throw error;
      failAgent('cwd-unsafe');
    }
  }
  const candidate = resolve(worktree, ...parts);
  if (!within(worktree, candidate)) failAgent('cwd-unsafe');
  await verifyDirectory(candidate, undefined, 'cwd-unsafe', guard);
  guard();
  return candidate;
}

function snapshotArgs(input, allowOptions) {
  if (!Array.isArray(input)) failAgent('argument-invalid');
  let length;
  try { length = input.length; } catch { failAgent('argument-invalid'); }
  if (!Number.isSafeInteger(length) || length > 128) failAgent('argument-invalid');
  const output = [];
  try {
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(input, index)) failAgent('argument-invalid');
      const value = input[index];
      if (typeof value !== 'string' || value.length > 4096 || value.length === 0 || /[\u0000\r\n]/.test(value)
        || (!allowOptions && value.startsWith('-'))) failAgent('argument-invalid');
      output.push(value);
    }
  } catch { failAgent('argument-invalid'); }
  return Object.freeze(output);
}

function environment(input) {
  if (input === undefined) input = Object.create(null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) failAgent('invalid-contract');
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { failAgent('invalid-contract'); }
  if (keys.length > 64 || keys.some(key => typeof key !== 'string')) failAgent('invalid-contract');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent('invalid-contract');
      const value = input[key];
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 32768 || value.includes('\0')) failAgent('invalid-contract');
      if (SAFE_ENV.has(key) && !SENSITIVE_ENV.test(key)) result[key] = value;
    }
  } catch { failAgent('invalid-contract'); }
  return Object.freeze({
    PATH: result.PATH ?? '/usr/bin:/bin',
    LANG: result.LANG ?? 'C.UTF-8', LC_ALL: result.LC_ALL ?? 'C.UTF-8', TZ: result.TZ ?? 'UTC',
    TERM: 'dumb', NO_COLOR: '1', CI: '1', GIT_TERMINAL_PROMPT: '0',
    ...(result.TMPDIR ? { TMPDIR: result.TMPDIR } : {}),
    ...(result.HOME ? { HOME: result.HOME } : {}),
    ...(result.USER !== undefined ? { USER: result.USER } : {}),
    ...(result.LOGNAME !== undefined ? { LOGNAME: result.LOGNAME } : {}),
    ...(result.SHELL !== undefined ? { SHELL: result.SHELL } : {}),
  });
}

function strictDecode(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { failAgent('output-invalid'); }
}

function parseEnvelope(buffer, contract) {
  const source = strictDecode(buffer);
  const document = source.trim();
  if (!document || source.length - document.length > 16 || /[^\t\n\r ]/.test(source.slice(0, source.indexOf(document)))
    || /[^\t\n\r ]/.test(source.slice(source.indexOf(document) + document.length))) failAgent('output-invalid');
  let parsed;
  try { parsed = JSON.parse(document); } catch { failAgent('output-invalid'); }
  const captured = immutableJson(parsed);
  const value = captured && typeof captured === 'object' && !Array.isArray(captured)
    && Object.hasOwn(captured, 'structured_output')
    ? (captured.type === 'result' && captured.subtype === 'success' && captured.structured_output
      && typeof captured.structured_output === 'object' && !Array.isArray(captured.structured_output)
      ? captured.structured_output
      : failAgent('output-invalid'))
    : captured;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || !['version', 'status', 'output', 'usage'].every(key => Object.hasOwn(value, key))
    || value.version !== 1 || !['success', 'retry', 'failed', 'blocked', 'budget-exhausted'].includes(value.status)
    || !value.output || typeof value.output !== 'object' || Array.isArray(value.output)
    || !value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)) failAgent('output-invalid');
  const outputKeys = Reflect.ownKeys(value.output);
  const usageKeys = Reflect.ownKeys(value.usage);
  if (outputKeys.length !== 2 || !['summary', 'evidence'].every(key => Object.hasOwn(value.output, key))
    || typeof value.output.summary !== 'string' || value.output.summary.length === 0 || value.output.summary.length > 16_384
    || containsSecretMaterial(value.output.summary)
    || !Array.isArray(value.output.evidence) || value.output.evidence.length > 128
    || value.output.evidence.some(item => typeof item !== 'string' || item.length === 0 || item.length > 500 || containsSecretMaterial(item))
    || usageKeys.length !== 2 || !['tokens', 'costUsd'].every(key => Object.hasOwn(value.usage, key))
    || !Number.isSafeInteger(value.usage.tokens) || value.usage.tokens < 0 || value.usage.tokens > 10_000_000
    || typeof value.usage.costUsd !== 'number' || !Number.isFinite(value.usage.costUsd) || value.usage.costUsd < 0 || value.usage.costUsd > 100_000) {
    failAgent('output-invalid');
  }
  if (value.status !== 'budget-exhausted'
    && (value.usage.tokens > contract.budget.maxTokens || value.usage.costUsd > contract.budget.maxCostUsd)) failAgent('output-invalid');
  return value;
}

function killTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

export async function createProcessRunner(input) {
  assertSupportedClientPlatform();
  const config = capture(input, CONFIG_KEYS, ['executable', 'worktree'], 'invalid-contract');
  const timeoutMs = boundedInteger(config.timeoutMs, 30_000, 10 * 60_000);
  const launchTimeoutMs = boundedInteger(config.launchTimeoutMs, 5_000, 30_000);
  const termGraceMs = boundedInteger(config.termGraceMs, 250, 10_000);
  const killGraceMs = boundedInteger(config.killGraceMs, 1_000, 30_000);
  const maxOutputBytes = boundedInteger(config.maxOutputBytes, 256 * 1024, 10 * 1024 * 1024);
  const maxInputBytes = boundedInteger(config.maxInputBytes, 128 * 1024, 1024 * 1024);
  if (config.allowOptionArgs !== undefined && typeof config.allowOptionArgs !== 'boolean') failAgent('invalid-contract');
  const executable = config.executable;
  const interpreter = config.interpreter;
  const worktree = config.worktree;
  const boundSignal = captureSignal(config.signal);
  let constructionCancelled = signalAborted(boundSignal);
  if (constructionCancelled) failAgent('aborted');
  const removeConstructionListener = watchSignal(boundSignal, () => { constructionCancelled = true; });
  const constructionGuard = () => {
    if (constructionCancelled || signalAborted(boundSignal)) failAgent('aborted');
  };
  let launchTarget;
  let worktreeIdentity;
  try {
    constructionGuard();
    launchTarget = await inspectLaunchTarget(executable, interpreter, undefined, constructionGuard);
    constructionGuard();
    worktreeIdentity = await verifyDirectory(worktree, undefined, 'cwd-unsafe', constructionGuard);
    constructionGuard();
    if (config.worktreeIdentity !== undefined) {
      const supplied = capture(config.worktreeIdentity, new Set(['dev', 'ino']), ['dev', 'ino'], 'cwd-unsafe');
      if (typeof supplied.dev !== 'string' || typeof supplied.ino !== 'string'
        || !/^[0-9]+$/.test(supplied.dev) || !/^[0-9]+$/.test(supplied.ino)
        || supplied.dev !== worktreeIdentity.dev || supplied.ino !== worktreeIdentity.ino) failAgent('cwd-unsafe');
    }
  } finally { removeConstructionListener(); }
  const executionEnvironment = environment(config.environment);

  async function probeVersion() {
    let cancelled = signalAborted(boundSignal);
    if (cancelled) failAgent('aborted');
    let terminateChild;
    const removeListener = watchSignal(boundSignal, () => {
      cancelled = true;
      terminateChild?.('aborted');
    });
    const guard = () => { if (cancelled || signalAborted(boundSignal)) failAgent('aborted'); };
    try {
      await verifyDirectory(worktree, worktreeIdentity, 'cwd-unsafe', guard);
      guard();
      const currentTarget = await inspectLaunchTarget(executable, interpreter, launchTarget, guard);
      guard();
      const command = invocation(currentTarget, ['--version']);
      return await new Promise((resolvePromise, rejectPromise) => {
        let child;
        let classification;
        let settled = false;
        let timer;
        let killTimer;
        let hardTimer;
        const chunks = [];
        let bytes = 0;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardTimer);
          if (error) rejectPromise(error); else resolvePromise(value);
        };
        terminateChild = reason => {
          if (classification || !child) return;
          classification = reason;
          killTree(child, 'SIGTERM');
          killTimer = setTimeout(() => killTree(child, 'SIGKILL'), termGraceMs);
          killTimer.unref?.();
          hardTimer = setTimeout(() => {
            killTree(child, 'SIGKILL');
            finish(new AgentContractError(reason));
          }, termGraceMs + killGraceMs);
          hardTimer.unref?.();
        };
        if (cancelled) { finish(new AgentContractError('aborted')); return; }
        try {
          child = spawn(command.executable, command.args, {
            cwd: worktree, shell: false, windowsHide: true, detached: true,
            env: executionEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { finish(new AgentContractError('provider-unavailable')); return; }
        if (cancelled) terminateChild('aborted');
        const collect = (chunk, keep) => {
          if (classification) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const available = Math.max(0, 4096 - bytes);
          if (keep && available > 0) chunks.push(buffer.subarray(0, available));
          bytes += Math.min(buffer.byteLength, available);
          if (buffer.byteLength > available) terminateChild('provider-unavailable');
        };
        child.stdout.on('data', chunk => collect(chunk, true));
        child.stderr.on('data', chunk => collect(chunk, false));
        child.once('error', () => {
          if (classification) killTree(child, 'SIGKILL');
          finish(new AgentContractError(classification ?? 'provider-unavailable'));
        });
        child.once('close', code => {
          if (classification) {
            // A detached adapter can exit before a descendant in its process
            // group. Kill the group before clearing the escalation timer.
            killTree(child, 'SIGKILL');
            finish(new AgentContractError(classification));
            return;
          }
          if (code !== 0) { finish(new AgentContractError('provider-unavailable')); return; }
          try {
            const value = strictDecode(Buffer.concat(chunks)).trim();
            if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) failAgent('provider-unavailable');
            finish(null, value);
          } catch { finish(new AgentContractError('provider-unavailable')); }
        });
        timer = setTimeout(() => terminateChild('provider-unavailable'), Math.min(launchTimeoutMs, timeoutMs));
        timer.unref?.();
      });
    } finally {
      terminateChild = undefined;
      removeListener();
    }
  }

  async function execute(inputRequest, protocol) {
    const request = capture(inputRequest, REQUEST_KEYS, ['args', 'cwd', 'payload'], 'invalid-contract');
    const args = snapshotArgs(request.args, config.allowOptionArgs === true);
    if (typeof request.payload !== 'string' || Buffer.byteLength(request.payload, 'utf8') > maxInputBytes || request.payload.includes('\0')) failAgent('invalid-contract');
    let contract;
    try {
      contract = protocol === 'launch'
        ? validateLaunchPayload(request.payload)
        : validatePlanningPayload(request.payload);
    } catch { failAgent('invalid-contract'); }
    if (contract.worktree.path !== worktree
      || contract.worktree.dev !== worktreeIdentity.dev || contract.worktree.ino !== worktreeIdentity.ino) failAgent('cwd-unsafe');
    const requestSignal = captureSignal(request.signal);
    if (boundSignal && requestSignal && boundSignal !== requestSignal) failAgent('invalid-contract');
    const signal = requestSignal ?? boundSignal;
    let cancelled = signalAborted(signal);
    if (cancelled) failAgent('aborted');
    let terminateChild;
    const removeListener = watchSignal(signal, () => {
      cancelled = true;
      terminateChild?.('aborted');
    });
    const guard = () => { if (cancelled || signalAborted(signal)) failAgent('aborted'); };
    try {
      await verifyDirectory(worktree, worktreeIdentity, 'cwd-unsafe', guard);
      guard();
      const cwd = await verifyCwd(worktree, request.cwd, guard);
      guard();
      const currentTarget = await inspectLaunchTarget(executable, interpreter, launchTarget, guard);
      guard();
      const command = invocation(currentTarget, args);
      return await new Promise((resolvePromise, rejectPromise) => {
        let child;
        const stdout = [];
        let totalBytes = 0;
        let classification;
        let settled = false;
        let runtimeTimer;
        let launchTimer;
        let termTimer;
        let hardTimer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(runtimeTimer); clearTimeout(launchTimer); clearTimeout(termTimer); clearTimeout(hardTimer);
          if (error) rejectPromise(error); else resolvePromise(value);
        };
        terminateChild = reason => {
          if (classification || !child) return;
          classification = reason;
          killTree(child, 'SIGTERM');
          termTimer = setTimeout(() => killTree(child, 'SIGKILL'), termGraceMs);
          termTimer.unref?.();
          hardTimer = setTimeout(() => {
            killTree(child, 'SIGKILL');
            finish(new AgentContractError(reason));
          }, termGraceMs + killGraceMs);
          hardTimer.unref?.();
        };
        if (cancelled) { finish(new AgentContractError('aborted')); return; }
        try {
          child = spawn(command.executable, command.args, {
            cwd, shell: false, windowsHide: true, detached: true,
            env: executionEnvironment, stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch { finish(new AgentContractError('spawn-failed')); return; }
        const collect = (target, chunk) => {
          if (classification) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const available = Math.max(0, maxOutputBytes - totalBytes);
          if (target && available > 0) target.push(buffer.subarray(0, available));
          totalBytes += Math.min(buffer.byteLength, available);
          if (buffer.byteLength > available) terminateChild('output-overflow');
        };
        child.stdout.on('data', chunk => collect(stdout, chunk));
        child.stderr.on('data', chunk => collect(null, chunk));
        // Once spawn() has returned a child, a closed provider stdin is an
        // execution/availability failure. Classifying EPIPE as a spawn failure
        // makes the result depend on whether stdin or close wins the event race.
        child.stdin.on('error', () => terminateChild('provider-unavailable'));
        child.once('error', () => {
          if (classification) killTree(child, 'SIGKILL');
          finish(new AgentContractError(classification ?? 'spawn-failed'));
        });
        child.once('spawn', () => clearTimeout(launchTimer));
        child.once('close', code => {
          if (classification) {
            // The direct adapter may be gone while its descendants remain.
            killTree(child, 'SIGKILL');
            finish(new AgentContractError(classification));
            return;
          }
          // The child emitted a close event, so it did spawn successfully. A
          // non-zero exit is a provider execution failure, not a spawn failure;
          // classify it as unavailable so the runtime can apply its bounded
          // transient-provider retry policy.
          if (code !== 0) { finish(new AgentContractError('provider-unavailable')); return; }
          try {
            const bytes = Buffer.concat(stdout);
            finish(null, protocol === 'launch' ? parseEnvelope(bytes, contract) : parsePlanningResult(bytes));
          } catch (error) {
            finish(error instanceof AgentContractError ? error : new AgentContractError('output-invalid'));
          }
        });
        const runtimeLimit = protocol === 'launch' ? Math.min(timeoutMs, contract.budget.maxRuntimeMs) : timeoutMs;
        runtimeTimer = setTimeout(() => terminateChild('timeout'), runtimeLimit);
        runtimeTimer.unref?.();
        launchTimer = setTimeout(() => terminateChild('launch-timeout'), Math.min(launchTimeoutMs, runtimeLimit));
        launchTimer.unref?.();
        if (cancelled) { terminateChild('aborted'); return; }
        try { child.stdin.end(request.payload, 'utf8'); } catch { terminateChild('provider-unavailable'); }
      });
    } finally {
      terminateChild = undefined;
      removeListener();
    }
  }

  async function run(inputRequest) { return execute(inputRequest, 'launch'); }
  async function runPlanning(inputRequest) { return execute(inputRequest, 'planning'); }

  return Object.freeze({ probeVersion, run, runPlanning });
}
