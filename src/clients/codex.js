import { lstat } from 'node:fs/promises';

import { checkCompatibility, validVersion } from './compatibility.js';
import { createLaunchContract, failAgent } from './contract.js';
import { createProcessRunner } from './process-runner.js';
import { serializeLaunchContract } from '../prompts/launch-contract.js';
import { serializeProtocolLaunch } from '../protocols/presentation.js';
import { serializePlanningContract } from '../prompts/planning-contract.js';

const ARGS = Object.freeze(['exec', '--ephemeral', '--ignore-user-config', '--color', 'never', '{stdin}']);
export const CODEX_ADAPTER_SYNTAX = Object.freeze({
  version: 1,
  provider: 'codex',
  observedVersion: 'codex-cli 0.148.0-alpha.9',
  testedVersions: Object.freeze(['codex-cli 0.148.0-alpha.9', 'codex-cli 0.155.0-alpha.16']),
  requiredOptions: Object.freeze(['--ephemeral', '--ignore-user-config', '--color', '--sandbox']),
  versionArgs: Object.freeze(['--version']),
  args: ARGS,
  inputMode: 'stdin-text',
  outputMode: 'direct-final-text-envelope-v1',
  optionalArgs: Object.freeze(['--model <id>', '--sandbox <read-only|workspace-write>', '--strict-config']),
});

const CONFIG_KEYS = new Set(['executable', 'interpreter', 'expectedVersion', 'args', 'environment', 'timeoutMs', 'maxOutputBytes']);
const PLANNING_CONFIG_KEYS = new Set(['executable', 'interpreter', 'expectedVersion', 'worktree', 'environment', 'timeoutMs', 'maxOutputBytes']);

function stable(operation) {
  try { return operation(); } catch { failAgent('template-invalid'); }
}

function capture(input, keys, required) {
  return stable(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) failAgent('template-invalid');
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length > keys.size || ownKeys.some(key => typeof key !== 'string' || !keys.has(key))) failAgent('template-invalid');
    const output = Object.create(null);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent('template-invalid');
      output[key] = input[key];
    }
    if (required.some(key => !Object.hasOwn(output, key))) failAgent('template-invalid');
    return output;
  });
}

function captureArgs(input) {
  return stable(() => {
    if (!Array.isArray(input)) failAgent('template-invalid');
    const prototype = Object.getPrototypeOf(input);
    const length = input.length;
    if (prototype !== Array.prototype || !Number.isSafeInteger(length)
      || length < ARGS.length || length > ARGS.length + 6) failAgent('template-invalid');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable) failAgent('template-invalid');
      const value = input[index];
      if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\u0000\r\n]/.test(value)) failAgent('template-invalid');
      result.push(value);
    }
    const required = ARGS.slice(0, -1);
    if (result.at(-1) !== '{stdin}' || result.filter(value => value === '{stdin}').length !== 1
      || required.some((value, index) => result[index] !== value)) failAgent('template-invalid');
    const seen = new Set();
    for (let index = required.length; index < result.length - 1; index += 1) {
      const option = result[index];
      if (seen.has(option)) failAgent('template-invalid');
      seen.add(option);
      if (option === '--strict-config') continue;
      const value = result[index + 1];
      index += 1;
      if (option === '--model' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) continue;
      if (option === '--sandbox' && ['read-only', 'workspace-write'].includes(value)) continue;
      failAgent('template-invalid');
    }
    return Object.freeze(result.filter(value => value !== '{stdin}'));
  });
}

function captureEnvironment(input) {
  if (input === undefined) return undefined;
  return stable(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) failAgent('template-invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length > 64 || keys.some(key => typeof key !== 'string')) failAgent('template-invalid');
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent('template-invalid');
      const value = input[key];
      if (typeof value !== 'string') failAgent('template-invalid');
      output[key] = value;
    }
    return Object.freeze(output);
  });
}

export function createCodexClient(input) {
  const config = capture(input, CONFIG_KEYS, ['executable', 'args']);
  if (typeof config.executable !== 'string' || !config.executable.startsWith('/') || config.executable.length > 1024
    || (config.interpreter !== undefined && (typeof config.interpreter !== 'string' || !config.interpreter.startsWith('/') || config.interpreter.length > 1024))
    || (config.expectedVersion !== undefined && !validVersion(config.expectedVersion))) failAgent('template-invalid');
  const args = captureArgs(config.args);
  const environment = captureEnvironment(config.environment);
  const executable = config.executable;
  const interpreter = config.interpreter;
  const expectedVersion = config.expectedVersion;
  const timeoutMs = config.timeoutMs;
  const maxOutputBytes = config.maxOutputBytes;

  async function launch(contractInput, optionInput = {}) {
    const options = capture(optionInput, new Set(['signal','protocolContext']), []);
    const signalState = stable(() => {
      const value = options.signal;
      if (value !== undefined && (!(value instanceof AbortSignal) || Object.getPrototypeOf(value) !== AbortSignal.prototype)) failAgent('template-invalid');
      return Object.freeze({ value, aborted: value?.aborted === true });
    });
    if (signalState.aborted) failAgent('aborted');
    const contract = createLaunchContract(contractInput);
    serializeProtocolLaunch(contract, options.protocolContext);
    const runner = await createProcessRunner({
      executable, interpreter, worktree: contract.worktree.path,
      worktreeIdentity: { dev: contract.worktree.dev, ino: contract.worktree.ino },
      environment, signal: signalState.value,
      timeoutMs: Math.min(timeoutMs ?? contract.budget.maxRuntimeMs, contract.budget.maxRuntimeMs, 10 * 60_000),
      maxOutputBytes, allowOptionArgs: true,
    });
    await checkCompatibility(runner, 'codex', args, expectedVersion);
    return runner.run({ args, cwd: '.', payload: serializeLaunchContract(contract), protocolContext: options.protocolContext, signal: signalState.value });
  }

  return Object.freeze({ provider: 'codex', syntaxVersion: 1, launch });
}

export function createCodexPlanningClient(input) {
  const config = capture(input, PLANNING_CONFIG_KEYS, ['executable', 'worktree']);
  if (typeof config.executable !== 'string' || !config.executable.startsWith('/') || config.executable.length > 1024
    || (config.interpreter !== undefined && (typeof config.interpreter !== 'string' || !config.interpreter.startsWith('/') || config.interpreter.length > 1024))
    || (config.expectedVersion !== undefined && !validVersion(config.expectedVersion))
    || typeof config.worktree !== 'string' || !config.worktree.startsWith('/') || config.worktree.length > 1024) {
    failAgent('template-invalid');
  }
  const args = captureArgs([...ARGS.slice(0, -1), '--sandbox', 'read-only', '{stdin}']);
  const environment = captureEnvironment(config.environment);
  const executable = config.executable;
  const interpreter = config.interpreter;
  const expectedVersion = config.expectedVersion;
  const worktree = config.worktree;

  async function propose(contract, optionInput = {}) {
    const options = capture(optionInput, new Set(['signal']), []);
    const signal = options.signal;
    if (signal !== undefined && (!(signal instanceof AbortSignal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) {
      failAgent('template-invalid');
    }
    if (signal?.aborted) failAgent('aborted');
    let metadata;
    try { metadata = await lstat(worktree, { bigint: true }); } catch { failAgent('provider-unavailable'); }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) failAgent('provider-unavailable');
    const identity = Object.freeze({ dev: metadata.dev.toString(), ino: metadata.ino.toString() });
    const runner = await createProcessRunner({
      executable, interpreter, worktree, worktreeIdentity: identity, environment, signal,
      timeoutMs: config.timeoutMs, maxInputBytes: 512 * 1024,
      maxOutputBytes: config.maxOutputBytes ?? 512 * 1024, allowOptionArgs: true,
    });
    await checkCompatibility(runner, 'codex', args, expectedVersion);
    return runner.runPlanning({
      args,
      cwd: '.',
      payload: serializePlanningContract({
        worktree: { path: worktree, ...identity, reservationId: 'planning-read-only' },
        contract,
      }),
      signal,
    });
  }

  return Object.freeze({ provider: 'codex', syntaxVersion: 1, propose });
}
