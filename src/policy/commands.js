import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyApproval } from './approvals.js';
import { evaluateAuthority } from './authority.js';
import { redactSecrets } from '../state/redact.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SENSITIVE_ENVIRONMENT_KEY = /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i;
const SHELL_METACHARACTER = /[;&|`$<>*?!(){}[\]~\r\n\u0000]/;
const UNSAFE_EXECUTABLE = /^(?:sh|bash|dash|mksh|yash|zsh|fish|nu|elvish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|node(?:\.exe)?|python\d*(?:\.exe)?|ruby(?:\.exe)?|perl(?:\.exe)?|env|sudo)$/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const REDACTION_LOOKAHEAD_BYTES = 4 * 1024;
const KILL_GRACE_MS = 100;
const BOOTSTRAP_KILL_GRACE_MS = 300;
const HARD_STOP_MS = 1_000;
const BOOTSTRAP_VERSION = 1;
const BOOTSTRAP_FLAG = '--agilno-command-bootstrap-v1';
const BOOTSTRAP_PATH = fileURLToPath(new URL('./command-bootstrap.js', import.meta.url));
const RESULT_FRAMING = /[\s\p{P}\p{S}\p{Cf}\p{Cc}]/u;
const MAX_RESULT_FRAMING = 256;
const preparedData = new WeakMap();

export class CommandPolicyError extends Error {
  constructor(reason = 'invalid-command') {
    const messages = {
      'command-not-allowlisted': 'Command is not allowlisted.',
      'shell-metacharacter': 'Command argument contains a shell metacharacter.',
      'unsafe-executable': 'Command has an unsafe executable.',
      'worktree-boundary': 'Command cwd must remain inside the assigned worktree.',
      'cwd-symlink': 'Command cwd contains a symlink.',
      'authority-denied': 'Command authority denied.',
      'approval-required': 'Command approval required.',
    };
    super(messages[reason] ?? 'Command policy input is invalid.');
    this.name = 'CommandPolicyError';
    this.code = 'ERR_COMMAND_POLICY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new CommandPolicyError(reason); }

function capture(value, allowed, required, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(reason); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail(reason);
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail(reason);
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof CommandPolicyError) throw error;
    fail(reason);
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail(reason);
  return result;
}

function captureArray(value, limit, itemLimit, reason) {
  if (!Array.isArray(value)) fail(reason);
  const result = [];
  try {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) fail(reason);
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(reason);
      const item = value[index];
      if (typeof item !== 'string' || item.length > itemLimit || item.includes('\0')) fail(reason);
      result.push(item);
    }
  } catch (error) {
    if (error instanceof CommandPolicyError) throw error;
    fail(reason);
  }
  return result;
}

function captureDictionary(value, limit, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(reason); }
  if (keys.length > limit || keys.some(key => typeof key !== 'string')) fail(reason);
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail(reason);
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof CommandPolicyError) throw error;
    fail(reason);
  }
  return result;
}

function captureEnvironment(value) {
  if (value === undefined) return Object.freeze(Object.create(null));
  const environment = captureDictionary(value, 256, 'invalid-environment');
  for (const [key, child] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof child !== 'string' || child.includes('\0') || child.length > 32_768) fail('invalid-environment');
  }
  return Object.freeze(environment);
}

function boundedInteger(value, fallback, maximum, reason) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) fail(reason);
  return result;
}

function validId(value) {
  return typeof value === 'string' && value.length <= 64 && ID.test(value);
}

function validAction(value) {
  return typeof value === 'string' && value.length <= 100 && ACTION.test(value);
}

function snapshotInputs(contractInput, requestInput) {
  const contract = capture(contractInput, new Set([
    'worktree', 'authority', 'commands', 'timeoutMs', 'maxOutputBytes', 'maxStreamOutputBytes', 'environment',
  ]), ['worktree', 'authority', 'commands'], 'invalid-contract');
  const request = capture(requestInput, new Set([
    'actorId', 'commandId', 'cwd', 'args', 'approval', 'approvalRegistry', 'nowMs',
  ]), ['actorId', 'commandId', 'cwd'], 'invalid-request');
  const commands = captureDictionary(contract.commands, 64, 'invalid-commands');
  if (!validId(request.commandId)) fail('invalid-command-id');
  const configured = commands[request.commandId];
  if (configured === undefined) fail('command-not-allowlisted');
  const command = capture(configured, new Set([
    'executable', 'args', 'action', 'allowExtraArgs', 'elevated', 'approvalPolicyId', 'approverId',
  ]), ['executable', 'args', 'action'], 'invalid-command-entry');
  const configuredArgs = captureArray(command.args, 256, 4_096, 'invalid-command-args');
  const extraArgs = request.args === undefined ? [] : captureArray(request.args, 128, 4_096, 'invalid-command-args');
  const environment = captureEnvironment(contract.environment);

  if (typeof contract.worktree !== 'string' || !isAbsolute(contract.worktree) || contract.worktree.length > 1_024) fail('invalid-worktree');
  if (!validId(request.actorId)) fail('invalid-actor');
  if (typeof command.action !== 'string' || command.action.length > 100 || !ACTION.test(command.action)) fail('invalid-command-action');
  if (command.action !== `command.${request.commandId}` && command.action !== 'dependency.install') fail('invalid-command-action');
  if (command.allowExtraArgs !== undefined && typeof command.allowExtraArgs !== 'boolean') fail('invalid-command-entry');
  if (extraArgs.length > 0 && command.allowExtraArgs !== true) fail('unexpected-command-args');
  const args = [...configuredArgs, ...extraArgs];
  if (args.some(argument => SHELL_METACHARACTER.test(argument))) fail('shell-metacharacter');
  const elevated = command.elevated ?? false;
  if (typeof elevated !== 'boolean') fail('invalid-command-entry');
  if (command.action === 'dependency.install' && !elevated) fail('approval-required');
  if (elevated) {
    if (!validAction(command.approvalPolicyId) || !validId(command.approverId)) fail('invalid-command-entry');
  } else if (command.approvalPolicyId !== undefined || command.approverId !== undefined) fail('invalid-command-entry');

  return Object.freeze({
    worktree: contract.worktree,
    authority: contract.authority,
    executable: command.executable,
    args: Object.freeze(args),
    action: command.action,
    elevated,
    approvalPolicyId: command.approvalPolicyId,
    approverId: command.approverId,
    environment,
    timeoutMs: boundedInteger(contract.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'invalid-timeout'),
    maxOutputBytes: boundedInteger(contract.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'invalid-output-limit'),
    maxStreamOutputBytes: boundedInteger(contract.maxStreamOutputBytes, contract.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'invalid-output-limit'),
    actorId: request.actorId,
    commandId: request.commandId,
    cwd: request.cwd,
    approval: request.approval,
    approvalRegistry: request.approvalRegistry,
    nowMs: request.nowMs,
  });
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(metadata) {
  return Object.freeze({ dev: metadata.dev.toString(), ino: metadata.ino.toString() });
}

async function verifiedDirectory(path, reason) {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail(reason);
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (canonical !== path || !after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) fail(reason);
  return Object.freeze({ path, identity: identity(after) });
}

function safeCwdPath(worktree, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 500 || /[\u0000\r\n:\\]/.test(cwd)) fail('invalid-cwd');
  if (cwd === '.') return worktree;
  if (isAbsolute(cwd) || cwd.includes('//') || cwd.endsWith('/')) fail('worktree-boundary');
  const normalized = cwd.normalize('NFKC');
  if (normalized !== cwd && /[/\\:]/.test(normalized)) fail('invalid-cwd');
  if (/[\u0000\r\n:\\]/.test(normalized) || normalized.includes('//')) fail('invalid-cwd');
  const parts = normalized.split('/');
  if (parts.includes('..')) fail('worktree-boundary');
  if (parts.some(part => (
    part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || WINDOWS_RESERVED.test(part)
  ))) fail('invalid-cwd');
  const candidate = resolve(worktree, normalized);
  if (!isWithin(worktree, candidate)) fail('worktree-boundary');
  return candidate;
}

async function verifyCwd(worktree, cwdInput) {
  const candidate = safeCwdPath(worktree, cwdInput);
  const relativePath = relative(worktree, candidate);
  let cursor = worktree;
  if (relativePath) {
    for (const component of relativePath.split(sep)) {
      cursor = join(cursor, component);
      const metadata = await lstat(cursor, { bigint: true });
      if (metadata.isSymbolicLink()) fail('cwd-symlink');
      if (!metadata.isDirectory()) fail('invalid-cwd');
    }
  }
  const verified = await verifiedDirectory(candidate, 'cwd-symlink');
  if (!isWithin(worktree, verified.path)) fail('worktree-boundary');
  return verified;
}

async function verifyExecutable(executable) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.length > 1_024 || !isAbsolute(executable)) fail('unsafe-executable');
  if (SHELL_METACHARACTER.test(executable) || UNSAFE_EXECUTABLE.test(basename(executable))) fail('unsafe-executable');
  const before = await lstat(executable, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o111n) === 0n) fail('unsafe-executable');
  const canonical = await realpath(executable);
  const after = await lstat(executable, { bigint: true });
  if (canonical !== executable || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameIdentity(before, after)) fail('unsafe-executable');
  return Object.freeze({ path: executable, identity: identity(after) });
}

function sanitizedFailure(error) {
  return error instanceof CommandPolicyError ? error : new CommandPolicyError('invalid-command');
}

function approvalForElevated(input, worktree) {
  if (!input.approval || !input.approvalRegistry || input.nowMs === undefined) fail('approval-required');
  const verified = verifyApproval(input.approval, {
    subjectId: input.actorId,
    action: input.action,
    resource: `command:${input.commandId}:${worktree}`,
    policyId: input.approvalPolicyId,
  }, {
    registry: input.approvalRegistry,
    expectedApproverId: input.approverId,
    requireHumanApprover: true,
    requireSingleUse: true,
    nowMs: input.nowMs,
  });
  if (!verified.valid) fail('approval-required');
}

export async function prepareCommand(contractInput, requestInput) {
  try {
    const input = snapshotInputs(contractInput, requestInput);
    const worktree = resolve(input.worktree);
    const verifiedWorktree = await verifiedDirectory(worktree, 'invalid-worktree');
    const executable = await verifyExecutable(input.executable);
    const cwd = await verifyCwd(worktree, input.cwd);
    if (input.maxStreamOutputBytes > input.maxOutputBytes) fail('invalid-output-limit');
    const authorityDecision = evaluateAuthority(input.authority, {
      actorId: input.actorId,
      action: input.action,
      commandId: input.commandId,
      resource: input.commandId,
    });
    if (authorityDecision.decision === 'deny') fail('authority-denied');
    if (authorityDecision.decision === 'approval-required' && !input.elevated) fail('approval-required');
    if (input.elevated) approvalForElevated(input, worktree);

    const prepared = Object.freeze({
      executable: executable.path,
      args: input.args,
      cwd: cwd.path,
      shell: false,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      maxStreamOutputBytes: input.maxStreamOutputBytes,
      commandId: input.commandId,
    });
    preparedData.set(prepared, Object.freeze({
      worktree: verifiedWorktree.path,
      environment: input.environment,
      identities: Object.freeze({
        worktree: verifiedWorktree.identity,
        cwd: cwd.identity,
        executable: executable.identity,
      }),
    }));
    return prepared;
  } catch (error) {
    throw sanitizedFailure(error);
  }
}

function captureAbortSignal(signal) {
  if (signal === undefined) return Object.freeze({ aborted: () => false, onAbort: () => {}, cleanup: () => {} });
  if (!signal || typeof signal !== 'object') fail('invalid-abort-signal');
  let add;
  let remove;
  try {
    add = signal.addEventListener;
    remove = signal.removeEventListener;
  } catch { fail('invalid-abort-signal'); }
  if (typeof add !== 'function' || typeof remove !== 'function') fail('invalid-abort-signal');
  let aborted = false;
  const callbacks = new Set();
  const listener = () => {
    aborted = true;
    for (const callback of callbacks) callback();
  };
  try {
    add.call(signal, 'abort', listener, { once: true });
    aborted = signal.aborted;
  } catch {
    try { remove.call(signal, 'abort', listener); } catch {}
    fail('invalid-abort-signal');
  }
  if (typeof aborted !== 'boolean') fail('invalid-abort-signal');
  let cleaned = false;
  return Object.freeze({
    aborted: () => aborted,
    onAbort(callback) {
      if (aborted) callback();
      else callbacks.add(callback);
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      callbacks.clear();
      try { remove.call(signal, 'abort', listener); } catch {}
    },
  });
}

async function sameVerifiedPath(path, expected, kind) {
  try {
    const metadata = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    const matchesKind = kind === 'file' ? metadata.isFile() : metadata.isDirectory();
    return matchesKind && !metadata.isSymbolicLink() && canonical === path
      && metadata.dev.toString() === expected.dev && metadata.ino.toString() === expected.ino;
  } catch {
    return false;
  }
}

async function anchorsStillValid(prepared, data) {
  const [worktree, cwd, executable] = await Promise.all([
    sameVerifiedPath(data.worktree, data.identities.worktree, 'directory'),
    sameVerifiedPath(prepared.cwd, data.identities.cwd, 'directory'),
    sameVerifiedPath(prepared.executable, data.identities.executable, 'file'),
  ]);
  return worktree && cwd && executable && isWithin(data.worktree, prepared.cwd);
}

function exactMessage(message, keys) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && Reflect.ownKeys(message).length === keys.length && keys.every(key => Object.hasOwn(message, key));
}

function rawCaptureLimit(prepared, environment) {
  let environmentBytes = 0;
  for (const value of Object.values(environment)) environmentBytes = Math.max(environmentBytes, Buffer.byteLength(value));
  return prepared.maxOutputBytes + (2 * Math.max(REDACTION_LOOKAHEAD_BYTES, environmentBytes));
}

function executeAnchored(prepared, data, abortHandle) {
  return new Promise(resolvePromise => {
    const nonce = randomBytes(16).toString('hex');
    const rawLimit = rawCaptureLimit(prepared, data.environment);
    const chunks = { stdout: [], stderr: [] };
    let rawBytes = 0;
    let rawOverflow = false;
    let overflowStream;
    let child;
    let resultMessage;
    let timedOut = false;
    let aborted = abortHandle.aborted();
    let bootstrapError = false;
    let launched = false;
    let settled = false;
    let stopping = false;
    let killTimer;
    let termTimer;
    let timeoutTimer;
    let hardTimer;
    let anchorTimer;
    let anchorCheckRunning = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardTimer);
      clearTimeout(killTimer);
      clearTimeout(termTimer);
      clearInterval(anchorTimer);
      abortHandle.cleanup();
      resolvePromise({
        code: resultMessage?.code ?? null,
        signal: resultMessage?.signal ?? null,
        timedOut,
        aborted,
        rawOverflow,
        overflowStream,
        bootstrapError,
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
      });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try { child?.send({ version: BOOTSTRAP_VERSION, type: 'cancel', nonce }, () => {}); } catch {}
      termTimer = setTimeout(() => { try { child?.kill('SIGTERM'); } catch {} }, KILL_GRACE_MS);
      termTimer.unref?.();
      killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, BOOTSTRAP_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const collect = stream => chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, rawLimit - rawBytes);
      const accepted = buffer.subarray(0, available);
      if (accepted.length > 0) chunks[stream].push(accepted);
      rawBytes += accepted.length;
      if (accepted.length < buffer.length) {
        rawOverflow = true;
        overflowStream = stream;
        stop();
      }
    };
    const malformed = () => { bootstrapError = true; stop(); };
    const onMessage = async message => {
      if (!message || message.version !== BOOTSTRAP_VERSION || message.nonce !== nonce) return malformed();
      if (message.type === 'ready') {
        if (!exactMessage(message, ['version', 'type', 'nonce']) || launched) return malformed();
        launched = true;
        if (!await anchorsStillValid(prepared, data)) return malformed();
        try { child.send({ version: BOOTSTRAP_VERSION, type: 'launch', nonce }, error => { if (error) malformed(); }); } catch { malformed(); }
        return;
      }
      if (message.type === 'result') {
        if (!exactMessage(message, ['version', 'type', 'nonce', 'code', 'signal']) || resultMessage) return malformed();
        if (!(message.code === null || Number.isInteger(message.code)) || !(message.signal === null || typeof message.signal === 'string')) return malformed();
        resultMessage = Object.freeze({ code: message.code, signal: message.signal });
        return;
      }
      if (message.type === 'failed') {
        if (!exactMessage(message, ['version', 'type', 'nonce', 'reason'])) return malformed();
        bootstrapError = true;
        return;
      }
      return malformed();
    };

    if (aborted) {
      finish();
      return;
    }
    try {
      child = spawn(process.execPath, [BOOTSTRAP_PATH, BOOTSTRAP_FLAG], {
        cwd: prepared.cwd,
        env: Object.create(null),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch {
      bootstrapError = true;
      finish();
      return;
    }
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('message', onMessage);
    child.once('error', () => { bootstrapError = true; finish(); });
    child.once('close', code => {
      if (code !== 0 || !resultMessage) bootstrapError = true;
      finish();
    });
    anchorTimer = setInterval(async () => {
      if (anchorCheckRunning || settled || stopping) return;
      anchorCheckRunning = true;
      try {
        if (!await anchorsStillValid(prepared, data)) {
          bootstrapError = true;
          stop();
        }
      } finally {
        anchorCheckRunning = false;
      }
    }, 5);
    anchorTimer.unref?.();
    abortHandle.onAbort(() => { aborted = true; stop(); });
    child.send({
      version: BOOTSTRAP_VERSION,
      type: 'init',
      nonce,
      worktree: data.worktree,
      cwd: prepared.cwd,
      executable: prepared.executable,
      args: prepared.args,
      environment: data.environment,
      identities: data.identities,
    }, error => { if (error) malformed(); });
    timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, prepared.timeoutMs);
    timeoutTimer.unref?.();
    hardTimer = setTimeout(() => { bootstrapError = true; stop(); finish(); }, prepared.timeoutMs + HARD_STOP_MS);
    hardTimer.unref?.();
  });
}

function utf8Prefix(buffer, maximumBytes) {
  const bounded = buffer.subarray(0, maximumBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let length = bounded.length; length >= 0; length -= 1) {
    try { return decoder.decode(bounded.subarray(0, length)); } catch {}
  }
  return '';
}

function sensitiveEnvironmentValues(environment) {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_ENVIRONMENT_KEY.test(key) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

function unicodeSplitBoundaries(value) {
  const boundaries = [];
  let offset = 0;
  for (const character of value) {
    offset += character.length;
    if (offset < value.length) boundaries.push(offset);
  }
  return boundaries;
}

function greatestPrefixMatch(value, secret, boundaries) {
  let lower = 0;
  let upper = boundaries.length - 1;
  let match = -1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (value.includes(secret.slice(0, boundaries[middle]))) {
      match = middle;
      lower = middle + 1;
    } else upper = middle - 1;
  }
  return match;
}

function leastSuffixMatch(value, secret, boundaries) {
  let lower = 0;
  let upper = boundaries.length - 1;
  let match = -1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (value.includes(secret.slice(boundaries[middle]))) {
      match = middle;
      upper = middle - 1;
    } else lower = middle + 1;
  }
  return match;
}

function collectCrossStreamFragments(first, second, secret, firstFragments, secondFragments) {
  const boundaries = unicodeSplitBoundaries(secret);
  if (boundaries.length === 0) return;
  const longestPrefix = greatestPrefixMatch(first, secret, boundaries);
  const longestSuffix = leastSuffixMatch(second, secret, boundaries);
  if (longestPrefix < 0 || longestSuffix < 0 || longestSuffix > longestPrefix) return;
  firstFragments.add(secret.slice(0, boundaries[longestSuffix]));
  secondFragments.add(secret.slice(boundaries[longestPrefix]));
}

function secretPrefixMatcher(secret) {
  const characters = [...secret];
  const fallback = new Array(characters.length).fill(0);
  for (let index = 1, matched = 0; index < characters.length; index += 1) {
    while (matched > 0 && characters[index] !== characters[matched]) matched = fallback[matched - 1];
    if (characters[index] === characters[matched]) matched += 1;
    fallback[index] = matched;
  }
  return Object.freeze({ characters: Object.freeze(characters), fallback: Object.freeze(fallback) });
}

function candidateEndPositions(characters) {
  const positions = [characters.length];
  let cursor = characters.length;
  let framing = 0;
  while (cursor > 0 && RESULT_FRAMING.test(characters[cursor - 1])) {
    framing += 1;
    if (framing > MAX_RESULT_FRAMING) return Object.freeze({ excessive: true, positions: Object.freeze([]) });
    cursor -= 1;
    positions.push(cursor);
  }
  return Object.freeze({ excessive: false, positions: Object.freeze(positions) });
}

function prefixStatesAtPositions(characters, matcher, positions) {
  const maximumPrefix = matcher.characters.length - 1;
  const earliestEnd = positions[positions.length - 1];
  const absoluteEnd = positions[0];
  const start = Math.max(0, earliestEnd - maximumPrefix);
  const required = new Set(positions);
  const states = new Map();
  let matched = 0;
  if (required.has(start)) states.set(start, matched);
  for (let index = start; index < absoluteEnd; index += 1) {
    const character = characters[index];
    while (matched > 0 && character !== matcher.characters[matched]) matched = matcher.fallback[matched - 1];
    if (character === matcher.characters[matched]) matched += 1;
    if (matched === matcher.characters.length) matched = matcher.fallback[matched - 1];
    if (required.has(index + 1)) states.set(index + 1, matched);
  }
  return states;
}

function hasCredibleSecretPrefix(value, matchers) {
  if (matchers.length === 0) return false;
  const characters = [...value];
  const candidates = candidateEndPositions(characters);
  if (candidates.excessive) return true;

  for (const matcher of matchers) {
    if (matcher.characters.length < 2) continue;
    const states = prefixStatesAtPositions(characters, matcher, candidates.positions);
    for (const candidateEnd of candidates.positions) {
      let matched = states.get(candidateEnd) ?? 0;
      while (matched > 0) {
        const candidateStart = candidateEnd - matched;
        if (candidateStart === 0 || RESULT_FRAMING.test(characters[candidateStart - 1])) return true;
        matched = matcher.fallback[matched - 1];
      }
    }
  }
  return false;
}

function analyzeWholeOutput(decoded, environment) {
  const stdoutFragments = new Set();
  const stderrFragments = new Set();
  const secrets = sensitiveEnvironmentValues(environment);
  const prefixMatchers = secrets.map(secretPrefixMatcher);
  for (const secret of secrets) {
    collectCrossStreamFragments(decoded.stdout, decoded.stderr, secret, stdoutFragments, stderrFragments);
    collectCrossStreamFragments(decoded.stderr, decoded.stdout, secret, stderrFragments, stdoutFragments);
  }
  const redacted = redactSecrets(decoded, { environment });
  return Object.freeze({
    sensitive: redacted.stdout !== decoded.stdout || redacted.stderr !== decoded.stderr
      || stdoutFragments.size > 0 || stderrFragments.size > 0
      || hasCredibleSecretPrefix(decoded.stdout, prefixMatchers)
      || hasCredibleSecretPrefix(decoded.stderr, prefixMatchers),
  });
}

function actualTruncation(raw, prepared) {
  const stdoutLimit = Math.min(prepared.maxStreamOutputBytes, prepared.maxOutputBytes);
  const stdoutAccepted = Math.min(raw.stdout.length, stdoutLimit);
  const stderrLimit = Math.min(prepared.maxStreamOutputBytes, prepared.maxOutputBytes - stdoutAccepted);
  return Object.freeze({
    stdout: raw.stdout.length > stdoutLimit,
    stderr: raw.stderr.length > stderrLimit,
    combined: raw.stdout.length + raw.stderr.length > prepared.maxOutputBytes,
  });
}

function sanitizeAndLimit(raw, prepared, environment) {
  if (raw.rawOverflow) {
    return Object.freeze({
      stdout: '',
      stderr: '',
      redacted: false,
      suppressed: true,
      truncated: Object.freeze({ stdout: true, stderr: true, combined: true }),
    });
  }
  const decoded = {
    stdout: raw.bootstrapError ? '' : utf8Prefix(raw.stdout, raw.stdout.length),
    stderr: raw.bootstrapError ? '' : utf8Prefix(raw.stderr, raw.stderr.length),
  };
  const analysis = analyzeWholeOutput(decoded, environment);
  const stdoutLimit = Math.min(prepared.maxStreamOutputBytes, prepared.maxOutputBytes);
  const stdoutAccepted = Math.min(raw.stdout.length, stdoutLimit);
  const stderrLimit = Math.min(prepared.maxStreamOutputBytes, prepared.maxOutputBytes - stdoutAccepted);
  const stdout = utf8Prefix(raw.stdout, stdoutLimit);
  const stderr = utf8Prefix(raw.stderr, stderrLimit);
  const suppressed = analysis.sensitive || raw.bootstrapError;
  return Object.freeze({
    stdout: suppressed ? '' : stdout,
    stderr: suppressed ? '' : stderr,
    redacted: analysis.sensitive,
    suppressed,
    truncated: actualTruncation(raw, prepared),
  });
}

function commandStatus(raw, truncated) {
  if (raw.aborted) return 'aborted';
  if (raw.timedOut) return 'timeout';
  if (truncated.stdout || truncated.stderr || truncated.combined) return 'output-overflow';
  if (raw.bootstrapError) return 'bootstrap-error';
  if (raw.signal) return 'signal';
  if (raw.code !== 0) return 'nonzero';
  return 'success';
}

export async function runCommand(contractInput, requestInput, optionsInput = {}) {
  let abortHandle;
  try {
    const options = capture(optionsInput, new Set(['signal']), [], 'invalid-options');
    abortHandle = captureAbortSignal(options.signal);
    const prepared = await prepareCommand(contractInput, requestInput);
    const data = preparedData.get(prepared);
    if (!data) fail('invalid-prepared-command');
    const raw = await executeAnchored(prepared, data, abortHandle);
    const output = sanitizeAndLimit(raw, prepared, data.environment);
    return Object.freeze({
      status: commandStatus(raw, output.truncated),
      code: raw.code,
      signal: raw.signal,
      timedOut: raw.timedOut,
      aborted: raw.aborted,
      stdout: output.stdout,
      stderr: output.stderr,
      redacted: output.redacted,
      suppressed: output.suppressed,
      truncated: output.truncated,
    });
  } catch (error) {
    abortHandle?.cleanup();
    throw sanitizedFailure(error);
  }
}
