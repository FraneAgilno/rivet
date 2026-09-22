const SAFE_COMMAND_RUNNERS = new Set([
  'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'bun',
]);
const LOGICAL_COMMANDS = Object.freeze(['build', 'test', 'lint', 'typecheck']);
const LEGACY_COMMANDS = Object.freeze([...LOGICAL_COMMANDS, 'dev']);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SCRIPT = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_STEPS = 32;
const MAX_QUALITY_STEPS = 64;

export class CommandConfigurationError extends Error {
  constructor(path, reason) {
    super('Project command configuration is invalid.');
    this.name = 'CommandConfigurationError';
    this.path = path;
    this.reason = reason;
  }
}

function fail(path, reason) {
  throw new CommandConfigurationError(path, reason);
}

export function isExecutionCompatibleCwd(value) {
  if (value === '.') return true;
  if (typeof value !== 'string' || value.length < 1 || value.length > 300
    || value.normalize('NFKC') !== value || /[\\:\u0000-\u001f\u007f]/.test(value)
    || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || WINDOWS_RESERVED.test(part) || part.toLowerCase() === '.git')) return false;
  return true;
}

function validCwd(value, path) {
  if (!isExecutionCompatibleCwd(value)) fail(path, 'unsafe-path');
  return value;
}

function validArgv(value, logicalId, path, allowTypeCheckAlias) {
  if (!Array.isArray(value) || value.length !== 3
    || Reflect.ownKeys(value).length !== 4) fail(path, 'command-grammar');
  const argv = value.map((item, index) => {
    if (typeof item !== 'string') fail(`${path}/${index}`, 'command-grammar');
    return item;
  });
  const [runner, verb, script] = argv;
  if (!SAFE_COMMAND_RUNNERS.has(runner.toLowerCase())) fail(`${path}/0`, 'unsafe-executable');
  if (verb !== 'run' || !SCRIPT.test(script)) fail(path, 'command-grammar');
  if (script !== logicalId && !(allowTypeCheckAlias && logicalId === 'typecheck' && script === 'type-check')) {
    fail(`${path}/2`, 'command-script-binding');
  }
  return Object.freeze(argv);
}

function compiledGroup(logicalId, rawSteps, path, allowTypeCheckAlias) {
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_STEPS
    || Reflect.ownKeys(rawSteps).length !== rawSteps.length + 1) fail(path, 'command-step-count');
  const seen = new Set();
  const multiple = rawSteps.length > 1;
  const steps = rawSteps.map((raw, index) => {
    const stepPath = `${path}/${index}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(stepPath, 'command-step');
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || !keys.includes('cwd') || !keys.includes('argv')
      || keys.some(key => typeof key !== 'string')) fail(stepPath, 'command-step');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(stepPath, 'command-step');
    }
    const cwd = validCwd(raw.cwd, `${stepPath}/cwd`);
    const argv = validArgv(raw.argv, logicalId, `${stepPath}/argv`, allowTypeCheckAlias);
    const identity = JSON.stringify([cwd, ...argv]);
    if (seen.has(identity)) fail(stepPath, 'duplicate-step');
    seen.add(identity);
    return Object.freeze({ id: multiple ? `${logicalId}-${index + 1}` : logicalId, cwd, argv });
  });
  return Object.freeze({ logicalId, steps: Object.freeze(steps) });
}

export function compileProjectCommands(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(project))) fail('/project', 'project');
  const version = project.schemaVersion;
  if (version !== 1 && version !== 2) fail('/project/schemaVersion', 'schema-version');
  const commands = project.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(commands))) fail('/project/commands', 'commands');
  const allowed = version === 1 ? LEGACY_COMMANDS : LOGICAL_COMMANDS;
  const expectedManager = typeof project.stack?.packageManager === 'string'
    ? project.stack.packageManager : null;
  const keys = Reflect.ownKeys(commands);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('/project/commands', 'command-key');
  const output = Object.create(null);
  for (const logicalId of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(commands, logicalId);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`/project/commands/${logicalId}`, 'command');
    if (version === 1) {
      output[logicalId] = compiledGroup(logicalId, [{ cwd: '.', argv: descriptor.value }], `/project/commands/${logicalId}`, false);
      continue;
    }
    const group = descriptor.value;
    if (!group || typeof group !== 'object' || Array.isArray(group)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(group))) fail(`/project/commands/${logicalId}`, 'command-group');
    const groupKeys = Reflect.ownKeys(group);
    const steps = Object.getOwnPropertyDescriptor(group, 'steps');
    if (groupKeys.length !== 1 || groupKeys[0] !== 'steps' || !steps?.enumerable
      || !Object.hasOwn(steps, 'value')) fail(`/project/commands/${logicalId}`, 'command-group');
    output[logicalId] = compiledGroup(logicalId, steps.value, `/project/commands/${logicalId}/steps`, true);
    if (expectedManager && output[logicalId].steps.some(step => (
      step.argv[0].toLowerCase().replace(/\.cmd$/, '') !== expectedManager
    ))) fail(`/project/commands/${logicalId}/steps`, 'package-manager-mismatch');
  }
  return Object.freeze(output);
}

export function compileQualitySteps(config) {
  const commands = compileProjectCommands(config.project);
  const expanded = config.quality.commandGates.flatMap(gate => commands[gate.command].steps.map((step, index, steps) => {
    const id = steps.length === 1 ? gate.id : `${gate.id}-${index + 1}`;
    if (id.length > 64) fail(`/quality/commandGates/${gate.id}/id`, 'expanded-command-id');
    return Object.freeze({
      ...step,
      id,
      logicalId: gate.command,
      required: gate.required,
    });
  }));
  if (expanded.length > MAX_QUALITY_STEPS) fail('/quality/commandGates', 'expanded-command-count');
  const ids = new Set();
  for (const step of expanded) {
    const id = step.id.toLowerCase();
    if (ids.has(id)) fail(`/quality/commandGates/${step.id}/id`, 'expanded-command-id-duplicate');
    ids.add(id);
  }
  return Object.freeze(expanded);
}

export { LOGICAL_COMMANDS, MAX_QUALITY_STEPS, MAX_STEPS, SAFE_COMMAND_RUNNERS };
