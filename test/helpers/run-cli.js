import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = resolve(REPOSITORY_ROOT, 'bin', 'cli.js');
const DISABLE_NETWORK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'disable-network.cjs');
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_REDACTION_LENGTH = 8;
const SENSITIVE_ENVIRONMENT_KEY = /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i;

function looksHighEntropy(value) {
  if (value.length < 20 || /\s/.test(value)) return false;
  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/]
    .filter(pattern => pattern.test(value)).length;
  return characterClasses >= 3 && new Set(value).size >= 10;
}

function redactionCandidates(environment) {
  const candidates = Object.entries(environment)
    .map(([key, value]) => [key, String(value ?? '')])
    .filter(([key, value]) => (
      value.length >= MIN_REDACTION_LENGTH
      && (SENSITIVE_ENVIRONMENT_KEY.test(key) || looksHighEntropy(value))
    ))
    .map(([, value]) => value);

  // Short values are deliberately excluded: globally replacing values such as
  // "1" destroys exit codes and ordinary prose. Diagnostics never serialize
  // the environment itself, while meaningful secret material is redacted.
  return [...new Set(candidates)].sort((left, right) => right.length - left.length);
}

function redactEnvironmentValues(value, environment) {
  let redacted = String(value);
  for (const environmentValue of redactionCandidates(environment)) {
    redacted = redacted.split(environmentValue).join('[REDACTED]');
  }
  return redacted;
}

function diagnostic(result, environment) {
  const output = [
    `CLI exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}.`,
    result.timedOut ? `CLI exceeded its ${result.timeoutMs}ms timeout.` : '',
    `stdout:\n${result.stdout || '(empty)'}`,
    `stderr:\n${result.stderr || '(empty)'}`,
  ].filter(Boolean).join('\n');

  return redactEnvironmentValues(output, environment);
}

export function runCli(args, options = {}) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('runCli args must be an array of strings');
  }

  const environment = { ...process.env, ...options.env };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--require', DISABLE_NETWORK_PATH, CLI_PATH, ...args], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once('error', error => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      reject(new Error(redactEnvironmentValues(`Failed to start CLI: ${error.message}`, environment)));
    });

    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      const result = {
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        assertExitCode(expectedCode) {
          if (code !== expectedCode || timedOut) {
            throw new Error(diagnostic(result, environment));
          }
          return result;
        },
        assertSuccess() {
          return result.assertExitCode(0);
        },
      };
      resolvePromise(result);
    });
  });
}
