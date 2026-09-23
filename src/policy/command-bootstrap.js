import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

const VERSION = 1;
const STARTUP_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 100;
const NONCE = /^[a-f0-9]{32}$/;
const IDENTITY = /^\d+$/;
const ACTION_ARG_LIMIT = 256;
const ENV_LIMIT = 256;

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function boundedStrings(value, maximum, itemMaximum) {
  return Array.isArray(value) && value.length <= maximum
    && value.every(item => typeof item === 'string' && item.length <= itemMaximum && !item.includes('\0'));
}

function validEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= ENV_LIMIT && keys.every(key => (
    typeof key === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(key)
    && typeof value[key] === 'string' && value[key].length <= 32_768 && !value[key].includes('\0')
  ));
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function validIdentity(value) {
  return exactObject(value, ['dev', 'ino']) && IDENTITY.test(value.dev) && IDENTITY.test(value.ino);
}

function captureInit(message) {
  if (!exactObject(message, ['version', 'type', 'nonce', 'worktree', 'cwd', 'executable', 'args', 'environment', 'identities'])) return null;
  if (message.version !== VERSION || message.type !== 'init' || !NONCE.test(message.nonce)) return null;
  if (![message.worktree, message.cwd, message.executable].every(value => (
    typeof value === 'string' && value.length > 0 && value.length <= 1_024 && isAbsolute(value) && !value.includes('\0')
  ))) return null;
  if (!boundedStrings(message.args, ACTION_ARG_LIMIT, 4_096) || !validEnvironment(message.environment)) return null;
  if (!exactObject(message.identities, ['worktree', 'cwd', 'executable'])) return null;
  if (!Object.values(message.identities).every(validIdentity)) return null;
  return Object.freeze({
    version: VERSION,
    nonce: message.nonce,
    worktree: message.worktree,
    cwd: message.cwd,
    executable: message.executable,
    args: Object.freeze([...message.args]),
    environment: Object.freeze(Object.assign(Object.create(null), message.environment)),
    identities: Object.freeze({
      worktree: Object.freeze({ ...message.identities.worktree }),
      cwd: Object.freeze({ ...message.identities.cwd }),
      executable: Object.freeze({ ...message.identities.executable }),
    }),
  });
}

function sameIdentity(metadata, expected) {
  return metadata.dev.toString() === expected.dev && metadata.ino.toString() === expected.ino;
}

async function verifyAnchor(config) {
  const [cwdMetadata, cwdReal, worktreeMetadata, worktreeReal, executableMetadata, executableReal] = await Promise.all([
    lstat('.', { bigint: true }),
    realpath('.'),
    lstat(config.worktree, { bigint: true }),
    realpath(config.worktree),
    lstat(config.executable, { bigint: true }),
    realpath(config.executable),
  ]);
  return cwdMetadata.isDirectory() && !cwdMetadata.isSymbolicLink()
    && worktreeMetadata.isDirectory() && !worktreeMetadata.isSymbolicLink()
    && executableMetadata.isFile() && !executableMetadata.isSymbolicLink() && executableMetadata.nlink === 1n
    && cwdReal === config.cwd && worktreeReal === config.worktree && executableReal === config.executable
    && within(worktreeReal, cwdReal)
    && sameIdentity(cwdMetadata, config.identities.cwd)
    && sameIdentity(worktreeMetadata, config.identities.worktree)
    && sameIdentity(executableMetadata, config.identities.executable);
}

function startBootstrap() {
  let config;
  let target;
  let settled = false;
  let killTimer;
  let anchorTimer;
  const startupTimer = setTimeout(() => shutdown('startup-timeout'), STARTUP_TIMEOUT_MS);
  startupTimer.unref?.();

  function send(type, fields = {}) {
    if (process.connected) process.send({ version: VERSION, type, nonce: config?.nonce ?? null, ...fields }, () => {});
  }

  function terminateTarget() {
    if (!target) return;
    const signalTarget = signal => {
      try {
        if (process.platform !== 'win32' && Number.isSafeInteger(target.pid) && target.pid > 0) process.kill(-target.pid, signal);
        else target.kill(signal);
      } catch {}
    };
    signalTarget('SIGTERM');
    killTimer = setTimeout(() => signalTarget('SIGKILL'), KILL_GRACE_MS);
  }

  function shutdown(reason, exitCode = 1) {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer);
    clearInterval(anchorTimer);
    terminateTarget();
    send('failed', { reason });
    setTimeout(() => process.exit(exitCode), target ? KILL_GRACE_MS + 25 : 0);
  }

  async function launch() {
    if (!await verifyAnchor(config)) return shutdown('anchor-invalid');
    try {
      target = spawn(config.executable, config.args, {
        env: config.environment,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });
    } catch {
      return shutdown('target-spawn-failed');
    }
    target.once('error', () => shutdown('target-spawn-failed'));
    anchorTimer = setInterval(async () => {
      try {
        if (!await verifyAnchor(config)) shutdown('anchor-changed');
      } catch {
        shutdown('anchor-changed');
      }
    }, 5);
    anchorTimer.unref?.();
    target.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(anchorTimer);
      send('result', {
        code: Number.isInteger(code) ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      });
      process.disconnect?.();
      process.exitCode = 0;
    });
  }

  process.on('message', async message => {
    try {
      if (!config) {
        config = captureInit(message);
        if (!config || !await verifyAnchor(config)) return shutdown('invalid-init');
        clearTimeout(startupTimer);
        send('ready');
        return;
      }
      if (!exactObject(message, ['version', 'type', 'nonce']) || message.version !== VERSION || message.nonce !== config.nonce) {
        return shutdown('invalid-message');
      }
      if (message.type === 'launch' && !target) return launch();
      if (message.type === 'cancel') return shutdown('cancelled');
      return shutdown('invalid-message');
    } catch {
      return shutdown('internal-failure');
    }
  });
  process.once('disconnect', () => shutdown('ipc-closed'));
  // The foreground process group may receive a second signal while shutdown
  // is waiting to kill the target group. Keep consuming it until cleanup ends.
  process.on('SIGTERM', () => shutdown('terminated'));
  process.on('SIGINT', () => shutdown('terminated'));
}

if (process.argv[2] === '--agilno-command-bootstrap-v1' && typeof process.send === 'function') startBootstrap();
