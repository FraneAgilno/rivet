const CONTRACT_KEYS = new Set([
  'nodeId', 'parentId', 'objective', 'ownedPaths', 'authority', 'commands', 'evidence',
  'budget', 'worktree', 'contextRefs', 'heartbeatInterval', 'stopConditions',
]);
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const ACTION = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const TOKEN_VALUE = /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.:=-]{8,}|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b)/i;
const SENSITIVE_LABELS = Object.freeze([
  'password', 'passwd', 'secret', 'apikey', 'accesskey', 'privatekey', 'authorization',
  'credential', 'credentials', 'token', 'accesstoken', 'apitoken', 'authtoken',
]);
const launchContracts = new WeakSet();

export class AgentContractError extends Error {
  constructor(reason = 'invalid-contract') {
    const messages = {
      'invalid-contract': 'Agent launch contract is invalid.',
      'invalid-script': 'Fake agent script is invalid.',
      'output-invalid': 'Agent output is invalid.',
      'output-overflow': 'Agent output exceeded its safe limit.',
      timeout: 'Agent execution timed out.',
      'launch-timeout': 'Agent provider launch timed out.',
      'unsupported-platform': 'Agent clients are unsupported on this platform.',
      aborted: 'Agent execution was cancelled.',
      'provider-unavailable': 'Configured agent provider is unavailable.',
      'executable-unsafe': 'Configured agent executable is unsafe.',
      'cwd-unsafe': 'Agent working directory is unsafe.',
      'argument-invalid': 'Agent provider argument is invalid.',
      'template-invalid': 'Agent provider template is invalid.',
      'spawn-failed': 'Agent provider could not be started safely.',
    };
    super(messages[reason] ?? messages['invalid-contract']);
    this.name = 'AgentContractError';
    this.code = `ERR_AGENT_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

export function failAgent(reason) { throw new AgentContractError(reason); }

function captureRecord(input, keys, required, reason = 'invalid-contract') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failAgent(reason);
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(input); } catch { failAgent(reason); }
  if (ownKeys.length > keys.size || ownKeys.some(key => typeof key !== 'string' || !keys.has(key))) failAgent(reason);
  const output = Object.create(null);
  try {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) failAgent(reason);
      output[key] = input[key];
    }
  } catch (error) {
    failAgent(reason);
  }
  if (required.some(key => !Object.hasOwn(output, key))) failAgent(reason);
  return output;
}

export function containsSecretMaterial(value) {
  if (typeof value !== 'string') return false;
  if (value.length > 1024 * 1024) return true;
  let detection;
  try { detection = value.normalize('NFKC').replace(/\p{Cf}/gu, ''); } catch { return true; }
  if (TOKEN_VALUE.test(detection)) return true;
  const separator = character => character === ' ' || character === '\t' || character === '.' || character === '-' || character === '_';
  const wrapper = character => character === '"' || character === "'" || character === '“' || character === '”'
    || character === '‘' || character === '’' || character === '\\';
  for (let delimiter = 0; delimiter < detection.length; delimiter += 1) {
    if (detection[delimiter] !== ':' && detection[delimiter] !== '=') continue;
    let valueIndex = delimiter + 1;
    while (valueIndex < detection.length && (separator(detection[valueIndex]) || wrapper(detection[valueIndex]))) valueIndex += 1;
    if (valueIndex >= detection.length || ',}]'.includes(detection[valueIndex])) continue;
    for (const label of SENSITIVE_LABELS) {
      let cursor = delimiter - 1;
      while (cursor >= 0 && (separator(detection[cursor]) || wrapper(detection[cursor]))) cursor -= 1;
      let labelIndex = label.length - 1;
      while (labelIndex >= 0 && cursor >= 0) {
        while (cursor >= 0 && (separator(detection[cursor]) || wrapper(detection[cursor]))) cursor -= 1;
        if (cursor < 0 || detection[cursor].toLowerCase() !== label[labelIndex]) break;
        cursor -= 1;
        labelIndex -= 1;
      }
      if (labelIndex >= 0) continue;
      while (cursor >= 0 && wrapper(detection[cursor])) cursor -= 1;
      if (cursor < 0 || !/[A-Za-z0-9]/.test(detection[cursor])) return true;
    }
  }
  return false;
}

function string(value, maximum, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.normalize('NFKC') !== value || /[\u0000]/.test(value) || containsSecretMaterial(value)
    || (pattern && !pattern.test(value))) failAgent('invalid-contract');
  return value;
}

function id(value) { return string(value, 64, ID); }

function relativePath(value) {
  string(value, 500);
  if (value.startsWith('/') || value.startsWith('-') || value.endsWith('/') || value.includes('//')
    || /[\\:\u0000-\u001f\u007f]/.test(value)) failAgent('invalid-contract');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || part.toUpperCase().toLowerCase() === '.git' || WINDOWS_RESERVED.test(part))) failAgent('invalid-contract');
  return value;
}

function array(input, maximum, convert) {
  if (!Array.isArray(input)) failAgent('invalid-contract');
  let length;
  try { length = input.length; } catch { failAgent('invalid-contract'); }
  if (!Number.isSafeInteger(length) || length > maximum) failAgent('invalid-contract');
  const output = [];
  try {
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(input, index)) failAgent('invalid-contract');
      output.push(convert(input[index]));
    }
  } catch (error) {
    failAgent('invalid-contract');
  }
  if (new Set(output.map(value => typeof value === 'string' ? value.toUpperCase().toLowerCase() : value)).size !== output.length) failAgent('invalid-contract');
  return Object.freeze(output);
}

function authority(input) {
  const value = captureRecord(input, new Set(['actions', 'providers']), ['actions', 'providers']);
  return Object.freeze({
    actions: array(value.actions, 64, child => string(child, 100, ACTION)),
    providers: array(value.providers, 32, child => string(child, 100, ACTION)),
  });
}

function budget(input) {
  const value = captureRecord(input, new Set(['maxTokens', 'maxRuntimeMs', 'maxCostUsd']), ['maxTokens', 'maxRuntimeMs', 'maxCostUsd']);
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0 || value.maxTokens > 10_000_000
    || !Number.isSafeInteger(value.maxRuntimeMs) || value.maxRuntimeMs <= 0 || value.maxRuntimeMs > 86_400_000
    || typeof value.maxCostUsd !== 'number' || !Number.isFinite(value.maxCostUsd) || value.maxCostUsd < 0 || value.maxCostUsd > 100_000) {
    failAgent('invalid-contract');
  }
  return Object.freeze({ maxTokens: value.maxTokens, maxRuntimeMs: value.maxRuntimeMs, maxCostUsd: value.maxCostUsd });
}

export function captureWorktree(input) {
  const value = captureRecord(input, new Set(['path', 'dev', 'ino', 'reservationId']), ['path', 'dev', 'ino', 'reservationId']);
  const path = string(value.path, 1024);
  if (!isAbsolute(path) || resolve(path) !== path || /[\\:\r\n]/.test(path)) failAgent('invalid-contract');
  return Object.freeze({
    path, dev: string(value.dev, 64, /^[0-9]+$/), ino: string(value.ino, 64, /^[0-9]+$/), reservationId: id(value.reservationId),
  });
}

export function createLaunchContract(input) {
  const value = captureRecord(input, CONTRACT_KEYS, [...CONTRACT_KEYS]);
  const parentId = value.parentId === null ? null : id(value.parentId);
  if (!Number.isSafeInteger(value.heartbeatInterval) || value.heartbeatInterval < 100 || value.heartbeatInterval > 3_600_000) failAgent('invalid-contract');
  const contract = Object.freeze({
    version: 1,
    nodeId: id(value.nodeId), parentId,
    objective: string(value.objective, 16_384),
    ownedPaths: array(value.ownedPaths, 256, relativePath),
    authority: authority(value.authority),
    commands: array(value.commands, 128, child => string(child, 100, ACTION)),
    evidence: array(value.evidence, 128, child => string(child, 200, REF)),
    budget: budget(value.budget), worktree: captureWorktree(value.worktree),
    contextRefs: array(value.contextRefs, 128, child => string(child, 200, REF)),
    heartbeatInterval: value.heartbeatInterval,
    stopConditions: array(value.stopConditions, 64, child => string(child, 200, ACTION)),
  });
  launchContracts.add(contract);
  return contract;
}

export function isLaunchContract(value) { return launchContracts.has(value); }

export function immutableJson(value, reason = 'output-invalid') {
  const active = new WeakSet();
  function clone(child, depth) {
    if (depth > 16) failAgent(reason);
    if (child === null || typeof child === 'boolean' || typeof child === 'string') {
      if (typeof child === 'string' && child.length > 16_384) failAgent(reason);
      return child;
    }
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) failAgent(reason);
      return child;
    }
    if (!child || typeof child !== 'object' || active.has(child)) failAgent(reason);
    active.add(child);
    try {
      if (Array.isArray(child)) {
        if (child.length > 256) failAgent(reason);
        const output = [];
        for (let index = 0; index < child.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(child, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failAgent(reason);
          output.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(output);
      }
      const prototype = Object.getPrototypeOf(child);
      if (prototype !== Object.prototype && prototype !== null) failAgent(reason);
      const keys = Reflect.ownKeys(child);
      if (keys.length > 256 || keys.some(key => typeof key !== 'string')) failAgent(reason);
      const output = Object.create(null);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(child, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > 200) failAgent(reason);
        output[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    } finally { active.delete(child); }
  }
  try { return clone(value, 0); } catch (error) {
    failAgent(reason);
  }
}
import { isAbsolute, resolve } from 'node:path';
