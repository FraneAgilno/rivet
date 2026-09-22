import * as filesystem from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { immutableJson } from '../clients/contract.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_DECOMPOSITION_BYTES = 128 * 1024;
const SUBCOMMANDS = new Set(['propose', 'prepare', 'next', 'status', 'submit', 'verify']);

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function absolute(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || !isAbsolute(value)
    || resolve(value) !== value || /[\u0000\r\n]/.test(value)) fail(`${label} is invalid.`);
  return value;
}

function runId(value) {
  if (typeof value !== 'string' || value.length > 64 || !RUN_ID.test(value)) fail('Work run ID is invalid.');
  return value;
}

function version(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) fail(`${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is invalid.`);
  return parsed;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink;
}

function readJson(project, path, fs, label) {
  const target = absolute(path, `${label} path`);
  const contained = relative(project, target);
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    fail(`${label} must stay within the project.`);
  }
  let ancestor = project;
  for (const part of contained.split(sep).slice(0, -1)) {
    ancestor = join(ancestor, part);
    let status;
    try { status = fs.lstatSync(ancestor); } catch { fail(`${label} has an unsafe ancestor.`, 'REPOSITORY_CONFLICT'); }
    if (status.isSymbolicLink() || !status.isDirectory()) fail(`${label} has an unsafe ancestor.`, 'REPOSITORY_CONFLICT');
  }
  let descriptor;
  try {
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
      || before.size < 1 || before.size > MAX_DECOMPOSITION_BYTES) fail(`${label} must be a bounded regular file.`);
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(before, opened)) fail(`${label} changed during validation.`, 'REPOSITORY_CONFLICT');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!sameFile(opened, after) || bytes.byteLength !== after.size) fail(`${label} changed during validation.`, 'REPOSITORY_CONFLICT');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(`${label} is not valid UTF-8.`); }
    try { return JSON.parse(source); } catch { fail(`${label} is not valid JSON.`); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(`${label} could not be read.`, 'REPOSITORY_CONFLICT');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readDecomposition(project, path, fs) {
  return readJson(project, path, fs, 'Work decomposition');
}

function service(dependencies, name, method) {
  const value = dependencies?.[name];
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    fail('Host work execution is not configured.', 'MISSING_CONFIGURATION');
  }
  return value;
}

async function invoke(target, method, input) {
  try { return await target[method](input); }
  catch (error) {
    if (error instanceof CliError) throw error;
    const code = String(error?.code ?? '');
    const publicCode = code.includes('STATE_CONFLICT') || code.includes('VERSION') || code.startsWith('ERR_GIT_')
      ? 'REPOSITORY_CONFLICT'
      : code.includes('INVALID') ? 'INVALID_INPUT'
        : code.includes('MISSING') || code.includes('CONFIGURATION') ? 'MISSING_CONFIGURATION' : 'INTERNAL_ERROR';
    throw new CliError(error?.safeMessage ?? 'Host work execution failed.', publicCode, { cause: error });
  }
}

function emit(parsed, dependencies, result) {
  const safe = immutableJson(result);
  if (parsed.flags.json) dependencies.output.json({ ok: true, command: 'work', subcommand: parsed.subcommand, result: safe });
  else dependencies.output.log(JSON.stringify(safe, null, 2));
  return EXIT_CODES.SUCCESS;
}

function proposalInput(parsed, dependencies) {
  if (parsed.operands.length !== 0) fail('Work propose does not accept a run ID.');
  const project = absolute(parsed.flags.project, 'Work project');
  const selectors = ['request', 'request-text', 'ticket'].filter(key => parsed.flags[key] !== undefined);
  if (selectors.length !== 1 || typeof parsed.flags.decomposition !== 'string') {
    fail('Work propose requires one request source and --decomposition.');
  }
  const selected = selectors[0];
  let source;
  if (selected === 'request') source = { kind: 'file', value: absolute(parsed.flags.request, 'Work request path') };
  else if (selected === 'request-text') source = { kind: 'inline', value: parsed.flags['request-text'] };
  else source = { kind: 'ticket', value: parsed.flags.ticket };
  return Object.freeze({
    project,
    source: Object.freeze(source),
    client: 'host',
    decomposition: readDecomposition(project, parsed.flags.decomposition, dependencies.fs ?? filesystem),
    ...(parsed.flags.tracker === undefined ? {} : { tracker: parsed.flags.tracker }),
  });
}

function lifecycleInput(parsed, versionFlag = null) {
  if (parsed.operands.length !== 1) fail(`Work ${parsed.subcommand} requires one run ID.`);
  const input = { project: absolute(parsed.flags.project, 'Work project'), runId: runId(parsed.operands[0]) };
  if (versionFlag) input[versionFlag.output] = version(parsed.flags[versionFlag.flag], `--${versionFlag.flag}`);
  return Object.freeze(input);
}

export async function workCommand(parsed, dependencies) {
  if (!parsed || parsed.command !== 'work' || !SUBCOMMANDS.has(parsed.subcommand)
    || !Array.isArray(parsed.operands) || !parsed.flags || typeof parsed.flags !== 'object') fail('Work command is invalid.');
  const allowedFlags = {
    propose: ['project', 'request', 'request-text', 'ticket', 'tracker', 'decomposition', 'json'],
    prepare: ['project', 'expected-version', 'json'],
    next: ['project', 'expected-runtime-version', 'json'],
    status: ['project', 'json'],
    submit: ['project', 'expected-runtime-version', 'action', 'result', 'json'],
    verify: ['project', 'expected-version', 'expected-runtime-version', 'json'],
  };
  if (Object.keys(parsed.flags).some(key => !allowedFlags[parsed.subcommand].includes(key))) {
    fail(`Work ${parsed.subcommand} options are invalid.`);
  }
  if (parsed.subcommand === 'propose') {
    return emit(parsed, dependencies, await invoke(
      service(dependencies, 'feature', 'propose'), 'propose', proposalInput(parsed, dependencies),
    ));
  }
  if (parsed.subcommand === 'prepare') {
    return emit(parsed, dependencies, await invoke(service(dependencies, 'work', 'prepare'), 'prepare', lifecycleInput(
      parsed, { flag: 'expected-version', output: 'expectedRunVersion' },
    )));
  }
  if (parsed.subcommand === 'next') {
    return emit(parsed, dependencies, await invoke(service(dependencies, 'work', 'nextAction'), 'nextAction', lifecycleInput(
      parsed, { flag: 'expected-runtime-version', output: 'expectedRuntimeVersion' },
    )));
  }
  if (parsed.subcommand === 'status') {
    return emit(parsed, dependencies, await invoke(
      service(dependencies, 'work', 'status'), 'status', lifecycleInput(parsed),
    ));
  }
  if (parsed.subcommand === 'submit') {
    const input = lifecycleInput(parsed, { flag: 'expected-runtime-version', output: 'expectedRuntimeVersion' });
    if (typeof parsed.flags.action !== 'string' || typeof parsed.flags.result !== 'string') {
      fail('Work submit requires --action and --result JSON files.');
    }
    const fs = dependencies.fs ?? filesystem;
    return emit(parsed, dependencies, await invoke(service(dependencies, 'work', 'submitResult'), 'submitResult', Object.freeze({
      ...input,
      action: readJson(input.project, parsed.flags.action, fs, 'Work action'),
      result: readJson(input.project, parsed.flags.result, fs, 'Work result'),
    })));
  }
  if (parsed.subcommand === 'verify') {
    const input = lifecycleInput(parsed, { flag: 'expected-version', output: 'expectedRunVersion' });
    return emit(parsed, dependencies, await invoke(service(dependencies, 'work', 'verify'), 'verify', Object.freeze({
      ...input,
      expectedRuntimeVersion: version(parsed.flags['expected-runtime-version'], '--expected-runtime-version'),
    })));
  }
  fail(`Work ${parsed.subcommand} is invalid.`);
}

export { MAX_DECOMPOSITION_BYTES };
