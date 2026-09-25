import * as filesystem from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import checkbox, { Separator } from '@inquirer/checkbox';

import {
  checkForUpdate,
  copyFileIntoPinnedDirectory,
  createMutationGuard,
  ensureContainedDirectory,
  findProjectRoot,
  install,
  withPinnedTargetDirectory,
} from '../commands/install.js';
import { deliveryCommand } from '../commands/delivery.js';
import { repositoriesCommand } from '../commands/repositories.js';
import { integrationsCommand } from '../commands/integrations.js';
import { doctor } from '../commands/doctor.js';
import { modelsCommand } from '../commands/models.js';
import { setupCommand } from '../commands/setup.js';
import { protocolsCommand } from '../commands/protocols.js';
import { workCommand } from '../commands/work.js';
import { humanRunCommand } from '../commands/human-run.js';
import { humanTaskCommand } from '../commands/human-task.js';
import { init } from '../commands/init.js';
import { preflight } from '../commands/preflight.js';
import { uninstall } from '../commands/uninstall.js';
import { goalsCommand } from '../commands/goals.js';
import { orchestrateCommand } from '../commands/orchestrate.js';
import { evidenceCommand } from '../commands/evidence.js';
import { featureCommand } from '../commands/feature.js';
import { verifyCommand } from '../commands/verify.js';
import { statusCommand } from '../commands/status.js';
import {
  CliError,
  createJsonOutputBoundary,
  createOutput,
  emitCliError,
  EXIT_CODES,
  MAX_JSON_OUTPUT_BYTES,
  observeOutputErrors,
} from './output.js';
import { ArgumentError, parseArgs } from './parse-args.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEGACY_COMMANDS = new Set(['install', 'uninstall']);
const CONFIRMATION_TIMEOUT_MS = 30_000;
const DEPENDENCY_CONFIRMATION_TIMEOUT_MS = 120_000;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const abortControllerAbort = AbortController.prototype.abort;
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

const USAGE = `Usage:
  rivet delivery prepare|status|refresh|reconcile|recover [--run=<id>] [--project=<path>] [--json]
  rivet delivery deploy [--run=<id>] [--project=<path>]
  rivet delivery merge [--run=<id>] [--provider=<id>] [--method=merge|squash|rebase] [--project=<path>]
  rivet repositories inspect [--review=<number>] [--remote=<name>] [--provider=<id>] [--project=<path>] [--json]
  rivet integrations list|check [--project=<path>] [--host-inventory-json=<json>] [--json]
  rivet models list [--json]                List model adapters and implementation status
  rivet models check --profile=<file> [--json]  Validate a model profile without calling a model
  rivet install                    Interactive — pick which skills to install (project)
  rivet install --all              Install all skills (project)
  rivet setup [--project=<path>|--global] [--target=claude|codex|both] [--write] [--json]
  rivet run "task" [--harness=claude|codex] [--project=<path>]
  rivet task status [--project=<path>] [--run=<id>]
  rivet task resume [--project=<path>] [--run=<id>]
  rivet task deps [--project=<path>] [--run=<id>]
  rivet protocols add <slug> [--project=<path>] [--json]
  rivet protocols import <slug> --from=<path> [--project=<path>] [--json]
  rivet protocols validate [<slug>] [--project=<path>] [--json]
  rivet protocols find <query> [--include-drafts] [--project=<path>] [--json]
  rivet protocols show <slug> [--include-drafts] [--project=<path>] [--json]
  rivet protocols update <slug> --from=<path> --expected-revision=<n> [--publish] [--project=<path>] [--json]
  rivet work propose --project=<path> (--request=<file>|--request-text=<text>|--ticket=<id>|--host-context-json=<json>) (--decomposition=<file>|--decomposition-json=<json>) [--tracker=jira|linear] [--json]
  rivet work prepare <run-id> --project=<path> --expected-version=<n> [--json]
  rivet work next <run-id> --project=<path> --expected-runtime-version=<n> [--json]
  rivet work submit <run-id> --project=<path> --expected-runtime-version=<n> (--action=<file>|--action-json=<json>) (--result=<file>|--result-json=<json>) [--json]
  rivet work verify <run-id> --project=<path> --expected-version=<n> --expected-runtime-version=<n> [--json]
  rivet work status <run-id> --project=<path> [--json]
  rivet install --minimal [--project=<path>|--global] [--target=claude|codex|both] [--json]
  rivet uninstall --minimal [--project=<path>|--global] [--target=claude|codex|both] [--json]
  rivet install --global           Interactive — pick which skills to install (global)
  rivet install --all --global     Install all skills globally
  rivet install --target=codex     Install for Codex only
  rivet install --target=claude    Install for Claude only
  rivet install --target=both      Install for both
  rivet install --codex            Shortcut for --target=codex
  rivet install --claude           Shortcut for --target=claude
  rivet uninstall                  Interactive — pick which skills to uninstall (project)
  rivet uninstall --all            Uninstall all skills (project)
  rivet uninstall --global         Interactive — pick which skills to uninstall (global)
  rivet uninstall --all --global   Uninstall all skills globally
  rivet uninstall --target=codex   Uninstall from Codex only
  rivet uninstall --target=claude  Uninstall from Claude only
  rivet uninstall --target=both    Uninstall from both
  rivet init                       Copy governance rule templates to .claude/ in current project
  rivet init --project <path>      Propose v2 project configuration without writing
  rivet init --project <path> --write [--overwrite]
  rivet doctor [--project <path>] [--json]
  rivet preflight [--project <path>] [--mode=host|orchestration] [--json]
  rivet verify [--json]
  rivet evidence [--json]
  rivet feature propose --project=<path> (--request=<file>|--request-text=<text>|--ticket=<id>) [--tracker=jira|linear] [--client=claude|codex] [--json]
  rivet feature start <run-id> --project=<path> --expected-version=<n> --proposal-digest=<sha256> [--json]
  rivet feature run --project=<path> (--request=<file>|--request-text=<text>|--ticket=<id>) [--tracker=jira|linear] [--client=claude|codex]
  rivet feature status <run-id> --project=<path> [--json]
  rivet feature resume <run-id> --project=<path> --expected-version=<n> [--json]
  rivet feature cancel <run-id> --project=<path> --expected-version=<n> [--json]
  rivet status <instance> [--fixture=<path>] [--port=<n>] [--json]
  rivet goals status <instance> [--json]
  rivet goals events <instance> [--limit=<n>] [--json]
  rivet orchestrate run <instance> --expected-version=<n> [--json]
  rivet orchestrate watch <instance> --expected-version=<n> --interval-ms=<n> --max-ticks=<n> --deadline-ms=<n> [--json]
`;

async function defaultConfirmOverwrite() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  try {
    const answer = await Promise.race([
      readline.question('Replace all four existing .rivet configuration files? [y/N] '),
      new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise(''), CONFIRMATION_TIMEOUT_MS);
      }),
    ]);
    return /^(?:y|yes)$/i.test(String(answer).trim());
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    readline.close();
  }
}

async function defaultConfirmFeatureActivation(_proposal, options = {}) {
  if (options.signal?.aborted) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  let cancelQuestion;
  const interrupted = new Promise(resolvePromise => { cancelQuestion = resolvePromise; });
  const abort = () => { cancelQuestion(''); readline.close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const answer = await Promise.race([
      readline.question('Activate this private feature run? [y/N] '),
      new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(''), CONFIRMATION_TIMEOUT_MS); }),
      interrupted,
    ]);
    return /^(?:y|yes)$/i.test(String(answer).trim());
  } catch { return false; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); readline.close(); }
}

async function defaultConfirmDependencyInstall(_plan, options = {}) {
  if (options.signal?.aborted) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  const abort = () => readline.close();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const answer = await Promise.race([
      readline.question('Install these dependencies in the isolated checkout? [y/N] '),
      new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(''), DEPENDENCY_CONFIRMATION_TIMEOUT_MS); }),
    ]);
    return /^(?:y|yes)$/i.test(String(answer).trim());
  } catch { return false; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); readline.close(); }
}

async function defaultConfirmDelivery(preview) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  try {
    const answer = await Promise.race([
      readline.question(preview?.proposal?.action === 'deploy' ? 'Deploy this exact commit to the environment shown above? [y/N] ' : 'Merge this exact commit using the method shown above? [y/N] '),
      new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(''), CONFIRMATION_TIMEOUT_MS); }),
    ]);
    return /^(?:y|yes)$/i.test(String(answer).trim());
  } catch { return false; }
  finally { clearTimeout(timer); readline.close(); }
}

function resolveDependencies(overrides = {}) {
  return {
    fs: overrides.fs ?? filesystem,
    prompt: overrides.prompt ?? checkbox,
    separator: overrides.separator ?? (label => new Separator(label)),
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? (() => process.cwd()),
    home: overrides.home ?? homedir,
    output: overrides.output ?? createOutput(),
    fetch: overrides.fetch ?? globalThis.fetch,
    confirmDelivery: overrides.confirmDelivery ?? defaultConfirmDelivery,
    delivery: overrides.delivery,
    confirmOverwrite: overrides.confirmOverwrite ?? defaultConfirmOverwrite,
    confirmFeatureActivation: overrides.confirmFeatureActivation ?? defaultConfirmFeatureActivation,
    confirmDependencyInstall: overrides.confirmDependencyInstall ?? defaultConfirmDependencyInstall,
    terminalIsInteractive: overrides.terminalIsInteractive ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    harnesses: overrides.harnesses,
    packageRoot: overrides.packageRoot ?? PACKAGE_ROOT,
    maxJsonOutputBytes: overrides.maxJsonOutputBytes ?? MAX_JSON_OUTPUT_BYTES,
    maxUpdateResponseBytes: overrides.maxUpdateResponseBytes,
    updateCheckTimeoutMs: overrides.updateCheckTimeoutMs,
    orchestration: overrides.orchestration,
    evidence: overrides.evidence,
    quality: overrides.quality,
    feature: overrides.feature,
    work: overrides.work,
    status: overrides.status,
    runGit: overrides.runGit,
    setup: overrides.setup,
    integrationHost: overrides.integrationHost,
    repositories: overrides.repositories,
    resolveCommandExecutable: overrides.resolveCommandExecutable,
    commands: {
      doctor,
      evidence: evidenceCommand,
      feature: featureCommand,
      goals: goalsCommand,
      init,
      install,
      models: modelsCommand,
      integrations: integrationsCommand,
      repositories: repositoriesCommand,
      delivery: deliveryCommand,
      setup: setupCommand,
      orchestrate: orchestrateCommand,
      preflight,
      protocols: protocolsCommand,
      run: humanRunCommand,
      task: humanTaskCommand,
      status: statusCommand,
      uninstall,
      verify: verifyCommand,
      work: workCommand,
      ...overrides.commands,
    },
  };
}

function emitBoundaryError(dependencies, error, json) {
  if (!json) return emitCliError(dependencies.output, error);

  const boundary = createJsonOutputBoundary(dependencies.maxJsonOutputBytes);
  try {
    const exitCode = emitCliError(boundary.output, error, { json: true });
    boundary.commit(dependencies.output, exitCode);
    return exitCode;
  } catch {
    const fallback = createJsonOutputBoundary(dependencies.maxJsonOutputBytes);
    const exitCode = emitCliError(
      fallback.output,
      new CliError('Unexpected rivet failure.', 'INTERNAL_ERROR'),
      { json: true },
    );
    fallback.commit(dependencies.output, exitCode);
    return exitCode;
  }
}

async function legacyInit(_parsed, dependencies) {
  const { cwd, fs, output, packageRoot } = dependencies;
  const root = findProjectRoot(cwd(), fs);
  if (!root) {
    throw new CliError('Could not find project root (no .git or package.json found).', 'INVALID_INPUT');
  }

  const governanceSource = join(packageRoot, 'dist', 'governance');
  const governanceGuard = createMutationGuard(root, join(root, '.claude'), fs);
  const claudeDirectory = governanceGuard.targetDir;
  if (!fs.existsSync(governanceSource)) {
    throw new CliError(
      'dist/governance/ not found. The package may be corrupted.',
      'MISSING_CONFIGURATION',
    );
  }

  let governanceIdentity;
  try {
    governanceGuard.assertPath(claudeDirectory);
    governanceIdentity = ensureContainedDirectory(governanceGuard, fs);
    governanceGuard.assertPath(claudeDirectory);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Could not create the Claude governance directory.', 'REPOSITORY_CONFLICT', {
      cause: error,
    });
  }
  let files;
  try {
    files = fs.readdirSync(governanceSource).filter(file => file.endsWith('.md'));
  } catch (error) {
    throw new CliError('Could not read governance distribution data.', 'MISSING_CONFIGURATION', {
      cause: error,
    });
  }
  const copied = [];
  const skipped = [];
  for (const file of files) {
    const destination = join(claudeDirectory, file);
    if (fs.existsSync(destination)) {
      skipped.push(file);
    } else {
      try {
        governanceGuard.assertPath(destination);
        withPinnedTargetDirectory(claudeDirectory, governanceIdentity, fs, () => {
          const destinationStatus = fs.lstatSync(file, { throwIfNoEntry: false });
          if (destinationStatus?.isSymbolicLink()) {
            throw new CliError('Target path contains a symbolic link.', 'REPOSITORY_CONFLICT');
          }
          if (destinationStatus) {
            throw new CliError('Governance destination changed during validation.', 'REPOSITORY_CONFLICT');
          }
          copyFileIntoPinnedDirectory(join(governanceSource, file), file, fs);
        });
        governanceGuard.assertPath(destination);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`Failed to copy governance template '${file}'.`, 'REPOSITORY_CONFLICT', {
          cause: error,
        });
      }
      copied.push(file);
    }
  }
  if (copied.length > 0) {
    output.log(`\nCopied to .claude/:\n${copied.map(file => `  ${file}`).join('\n')}`);
  }
  if (skipped.length > 0) {
    output.log(`\nSkipped (already exist):\n${skipped.map(file => `  ${file}`).join('\n')}`);
  }
  output.log('\nCustomize these files for your project before running /pre-push.');
  await checkForUpdate(dependencies);
  return EXIT_CODES.SUCCESS;
}

function observeCall(callback, args) {
  return new Promise(resolvePromise => {
    let result;
    try { result = reflectApply(callback, undefined, args); }
    catch { resolvePromise(); return; }
    try { reflectApply(promiseThen, result, [() => resolvePromise(), () => resolvePromise()]); }
    catch { resolvePromise(); }
  });
}

function followAbortSignal(signal, controller) {
  if (signal == null) return () => {};
  const abort = () => {
    try { reflectApply(abortControllerAbort, controller, []); } catch { /* internal cancellation is best effort */ }
  };
  try {
    if (reflectApply(abortSignalAborted, signal, [])) {
      abort();
      return () => {};
    }
    reflectApply(addEventListener, signal, ['abort', abort, { once: true }]);
  } catch { return () => {}; }
  let listening = true;
  return () => {
    if (!listening) return;
    listening = false;
    try { reflectApply(removeEventListener, signal, ['abort', abort]); } catch { /* cleanup is best effort */ }
  };
}

function createStatusJsonLifecycle(wait, signal, close) {
  if (typeof wait !== 'function' || typeof close !== 'function') throw new Error('Invalid status JSON lifecycle.');
  const controller = new AbortController();
  const stopFollowing = followAbortSignal(signal, controller);
  const stopped = observeCall(wait, [controller.signal]);
  try { reflectApply(promiseThen, stopped, [stopFollowing, stopFollowing]); } catch { stopFollowing(); }
  let closing = null;
  let cancelled = false;
  return Object.freeze({
    stopped,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      stopFollowing();
      try { reflectApply(abortControllerAbort, controller, []); } catch { /* internal cancellation is best effort */ }
    },
    close() {
      if (!closing) closing = observeCall(close, []);
      return closing;
    },
  });
}

async function publishStatusJson(jsonBoundary, output, exitCode, lifecycle) {
  let signalOutputFailure;
  const outputFailed = new Promise(resolvePromise => { signalOutputFailure = resolvePromise; });
  const unsubscribe = observeOutputErrors(output, () => signalOutputFailure());
  if (typeof unsubscribe !== 'function') {
    lifecycle.cancel();
    await lifecycle.close();
    throw new Error('Status JSON output is not observable.');
  }
  let committed = false;
  try {
    try {
      jsonBoundary.commit(output, exitCode);
      committed = true;
    } catch { /* the installed observer owns publication failure cleanup */ }
    if (committed) await Promise.race([lifecycle.stopped, outputFailed]);
  } finally {
    lifecycle.cancel();
    unsubscribe();
    await lifecycle.close();
  }
}

export async function main(argv, overrides = {}) {
  const dependencies = resolveDependencies(overrides);
  const json = Array.isArray(argv) && argv.includes('--json');
  let statusJsonLifecycle = null;

  try {
    if (Array.isArray(argv) && argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) {
      dependencies.output.log(USAGE);
      return EXIT_CODES.SUCCESS;
    }
    const parsed = parseArgs(argv);
    if (parsed.command === null) {
      dependencies.output.log(USAGE);
      return EXIT_CODES.INVALID_INPUT;
    }

    const explicitV2Init = parsed.command === 'init' && Object.keys(parsed.flags).length > 0;
    const handler = parsed.command === 'init' && !explicitV2Init
      ? legacyInit
      : dependencies.commands[parsed.command];
    if (!handler) {
      throw new CliError(`Command '${parsed.command}' is not implemented.`, 'INVALID_INPUT');
    }
    if (parsed.flags.json && LEGACY_COMMANDS.has(parsed.command) && parsed.flags.minimal !== true) {
      throw new CliError(
        `JSON output is not available for legacy command '${parsed.command}'.`,
        'INVALID_INPUT',
      );
    }

    const jsonBoundary = parsed.flags.json
      ? createJsonOutputBoundary(dependencies.maxJsonOutputBytes)
      : null;
    const builtinStatusJson = Boolean(jsonBoundary && parsed.command === 'status' && handler === statusCommand);
    const commandDependencies = jsonBoundary ? {
      ...dependencies,
      output: jsonBoundary.output,
      ...(builtinStatusJson ? {
        registerStatusJsonLifecycle(wait, signal, close) {
          if (statusJsonLifecycle) throw new Error('Status JSON lifecycle is already registered.');
          statusJsonLifecycle = createStatusJsonLifecycle(wait, signal, close);
        },
      } : {}),
    } : dependencies;
    const exitCode = await handler(parsed, commandDependencies);
    if (!Object.values(EXIT_CODES).includes(exitCode)) {
      throw new Error('Command handler returned an invalid exit code');
    }
    if (jsonBoundary) {
      if (builtinStatusJson) {
        if (!statusJsonLifecycle) throw new Error('Status JSON lifecycle was not registered.');
        await publishStatusJson(jsonBoundary, dependencies.output, exitCode, statusJsonLifecycle);
      } else jsonBoundary.commit(dependencies.output, exitCode);
    }
    return exitCode;
  } catch (error) {
    if (statusJsonLifecycle) {
      statusJsonLifecycle.cancel();
      await statusJsonLifecycle.close();
    }
    if (error instanceof ArgumentError) {
      if (!json && error.message.startsWith('Unknown command')) {
        dependencies.output.log(USAGE);
        return EXIT_CODES.INVALID_INPUT;
      }
      return emitBoundaryError(
        dependencies,
        new CliError(error.message, 'INVALID_INPUT'),
        json,
      );
    }
    return emitBoundaryError(dependencies, error, json);
  }
}
