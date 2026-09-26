const COMMANDS = new Set([
  'doctor',
  'support',
  'delivery',
  'evidence',
  'feature',
  'goals',
  'init',
  'install',
  'models',
  'integrations',
  'repositories',
  'orchestrate',
  'preflight',
  'protocols',
  'run',
  'status',
  'setup',
  'uninstall',
  'verify',
  'work',
  'task',
  'worktrees',
]);

const LEGACY_COMMANDS = new Set(['init', 'install', 'uninstall']);
const NESTED_COMMANDS = new Set(['delivery', 'feature', 'goals', 'integrations', 'repositories', 'models', 'orchestrate', 'protocols', 'task', 'work', 'worktrees']);
const FLAG_NAME = /^[a-z][a-z0-9-]*$/;
const LEGACY_OPTIONS = {
  init: {
    boolean: new Set(['json', 'overwrite', 'write']),
    valued: new Set(['project']),
  },
  install: {
    boolean: new Set(['all', 'claude', 'codex', 'global', 'json', 'minimal']),
    valued: new Set(['target', 'project']),
  },
  uninstall: {
    boolean: new Set(['all', 'claude', 'codex', 'global', 'json', 'minimal']),
    valued: new Set(['target', 'project']),
  },
};
const STRICT_OPTIONS = {
  delivery: { boolean: new Set(['json']), valued: new Set(['project', 'run', 'remote', 'provider', 'method', 'title', 'body']) },
  repositories: { boolean: new Set(['json']), valued: new Set(['project', 'remote', 'provider', 'review']) },
  integrations: { boolean: new Set(['json']), valued: new Set(['project', 'host-inventory-json']) },
  protocols: {
    boolean: new Set(['json', 'include-drafts', 'publish']),
    valued: new Set(['expected-revision', 'from', 'project']),
  },
  work: {
    boolean: new Set(['json']),
    valued: new Set([
      'action', 'action-json', 'decomposition', 'decomposition-json', 'result-json', 'expected-runtime-version', 'expected-version', 'project', 'result',
      'request', 'request-text', 'ticket', 'tracker', 'host-context-json', 'acceptance-criteria',
    ]),
  },
  run: {
    boolean: new Set(),
    valued: new Set(['project', 'harness']),
  },
  task: {
    boolean: new Set(),
    valued: new Set(['project', 'run']),
  },
  setup: {
    boolean: new Set(['global', 'write', 'json']),
    valued: new Set(['project', 'target']),
  },
  models: {
    boolean: new Set(['json']),
    valued: new Set(['profile', 'roles', 'role', 'project']),
  },
  support: {
    boolean: new Set(['json', 'probe-harnesses']),
    valued: new Set(['project']),
  },
  doctor: {
    boolean: new Set(['json']),
    valued: new Set(['project']),
  },
  feature: {
    boolean: new Set(['json']),
    valued: new Set([
      'client', 'expected-version', 'project', 'proposal-digest', 'request', 'request-text', 'ticket', 'tracker', 'acceptance-criteria',
    ]),
  },
  preflight: {
    boolean: new Set(['json']),
    valued: new Set(['project', 'mode']),
  },
  status: {
    boolean: new Set(['json']),
    valued: new Set(['fixture', 'port']),
  },
};
const NO_POSITIONAL_COMMANDS = new Set(['doctor', 'support', 'init', 'install', 'preflight', 'setup', 'uninstall']);

function targetSet(target) {
  const normalized = typeof target === 'string' ? target.toLowerCase() : target;
  if (normalized === 'both') return new Set(['claude', 'codex']);
  if (normalized === 'claude' || normalized === 'codex') return new Set([normalized]);
  return null;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function validateTargetSelectors(command, flags) {
  if (!['install', 'uninstall', 'setup'].includes(command)) return;
  const aliases = new Set();
  if (flags.claude) aliases.add('claude');
  if (flags.codex) aliases.add('codex');
  const explicit = targetSet(flags.target);
  if (flags.target !== undefined && !explicit) {
    throw new ArgumentError("Invalid --target value. Use 'claude', 'codex', or 'both'.");
  }
  if (aliases.size > 0 && explicit && !sameSet(aliases, explicit)) {
    throw new ArgumentError('Conflicting target selectors');
  }
}

export class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(argument => typeof argument !== 'string')) {
    throw new TypeError('CLI arguments must be an array of strings');
  }

  const [command = null, ...tokens] = argv;
  if (command === null) {
    return { command: null, subcommand: null, operands: [], flags: {} };
  }
  if (!command || command.startsWith('-')) {
    throw new ArgumentError('A command must be provided before flags');
  }
  if (!COMMANDS.has(command)) {
    throw new ArgumentError(`Unknown command '${command}'`);
  }

  const flags = {};
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('--')) {
      // Legacy parsing never supported `--`; reject it explicitly instead of
      // ambiguously treating subsequent tokens as flags or operands.
      if (token === '--') {
        throw new ArgumentError("End-of-options separator '--' is not supported");
      }
      const body = token.slice(2);
      const separator = body.indexOf('=');
      const name = separator === -1 ? body : body.slice(0, separator);
      let value = separator === -1 ? true : body.slice(separator + 1);
      if (!FLAG_NAME.test(name) || (value === '' && !(command === 'delivery' && positionals[0] === 'review-update' && name === 'body' && separator !== -1))) {
        throw new ArgumentError(`Malformed flag '${token}'`);
      }
      if (Object.hasOwn(flags, name)) {
        throw new ArgumentError(`Duplicate flag '--${name}'`);
      }
      if (name === 'json' && value !== true) {
        throw new ArgumentError("Flag '--json' does not take a value");
      }
      const commandOptions = LEGACY_OPTIONS[command] ?? STRICT_OPTIONS[command];
      if (commandOptions) {
        if (!commandOptions.boolean.has(name) && !commandOptions.valued.has(name)) {
          throw new ArgumentError(`Unknown option '--${name}' for command '${command}'`);
        }
        if (commandOptions.boolean.has(name) && value !== true) {
          throw new ArgumentError(`Flag '--${name}' does not take a value`);
        }
        if (commandOptions.valued.has(name) && value === true) {
          if (command === 'delivery' || command === 'repositories' || command === 'integrations' || command === 'setup' || command === 'protocols' || ((command === 'install' || command === 'uninstall') && name === 'project') || command === 'init' || command === 'doctor' || command === 'support' || command === 'feature' || command === 'preflight' || command === 'status') {
            const next = tokens[index + 1];
            if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
              value = next;
              index += 1;
            } else {
              throw new ArgumentError(`Flag '--${name}' requires a value`);
            }
          } else {
            throw new ArgumentError(`Flag '--${name}' requires a value`);
          }
        }
      }
      flags[name] = value;
    } else if (!token || token.startsWith('-')) {
      throw new ArgumentError(`Malformed argument '${token}'`);
    } else {
      positionals.push(token);
    }
  }

  validateTargetSelectors(command, flags);
  if (['install', 'uninstall', 'setup'].includes(command) && flags.global && flags.project !== undefined) {
    throw new ArgumentError('--global and --project cannot be combined');
  }
  if (['install', 'uninstall'].includes(command)) {
    if (flags.project !== undefined && !flags.minimal) throw new ArgumentError('--project requires --minimal');
    if (flags.minimal && flags.all) throw new ArgumentError('--minimal and --all cannot be combined');
  }

  if (command === 'init' && flags.overwrite && !flags.write) {
    throw new ArgumentError("Flag '--overwrite' requires '--write'");
  }

  if (NO_POSITIONAL_COMMANDS.has(command) && positionals.length > 0) {
    throw new ArgumentError(`Command '${command}' does not accept positional arguments`);
  }
  if (command === 'status' && positionals.length !== 1) {
    throw new ArgumentError("Command 'status' requires exactly one instance ID");
  }
  if (NESTED_COMMANDS.has(command) && positionals.length === 0) {
    throw new ArgumentError(`Command '${command}' requires a subcommand`);
  }
  if (command === 'protocols' && !['add', 'import', 'validate', 'find', 'show', 'update'].includes(positionals[0])) {
    throw new ArgumentError('Unsupported protocol subcommand');
  }
  if (command === 'work' && !['propose', 'prepare', 'next', 'status', 'submit', 'verify', 'recover'].includes(positionals[0])) {
    throw new ArgumentError('Unsupported work subcommand');
  }
  if (command === 'task' && !['status', 'resume', 'deps', 'recover'].includes(positionals[0])) {
    throw new ArgumentError('Unsupported task subcommand');
  }

  return {
    command,
    subcommand: NESTED_COMMANDS.has(command) ? positionals.shift() : null,
    operands: positionals,
    flags,
  };
}
