import * as filesystem from 'node:fs';
import { resolve, join } from 'node:path';

import { CliError, EXIT_CODES } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { init } from './init.js';
import { inspectManagedInstall, managedInstall } from '../install/managed.js';

const CONFIG_FILES = ['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml'];

function emit(parsed, dependencies, result, code = EXIT_CODES.SUCCESS) {
  if (parsed.flags.json) dependencies.output.json(result, code === 0 ? 'stdout' : 'stderr');
  else {
    const write = code === 0 ? dependencies.output.log : dependencies.output.error;
    write(result.message);
    for (const action of result.nextSteps ?? []) write(`  ${action}`);
  }
  return code;
}

async function captured(operation, parsed, dependencies) {
  let value;
  const code = await operation({ ...parsed, flags: { ...parsed.flags, json: true } }, {
    ...dependencies,
    output: { json: payload => { value = payload; }, log() {}, error() {} },
  });
  return { code, value };
}

async function existingConfiguration(root, fs) {
  const path = join(root, '.rivet');
  const entry = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new CliError('Project .rivet configuration must be a regular directory.', 'REPOSITORY_CONFLICT');
  }
  // A partially initialized directory needs explicit repair, never automatic replacement.
  if (!CONFIG_FILES.every(name => {
    const file = fs.lstatSync(join(path, name), { throwIfNoEntry: false });
    return file?.isFile() && !file.isSymbolicLink();
  })) throw new CliError('Existing .rivet configuration is incomplete. Repair it before running setup; no files were replaced.', 'REPOSITORY_CONFLICT');
  try { await loadProjectConfig(root, { fs }); }
  catch { throw new CliError('Existing .rivet configuration is invalid. Repair it before running setup; no files were replaced.', 'REPOSITORY_CONFLICT'); }
  return true;
}

function previewSteps(preview) {
  if (!preview?.proposal?.commands) return [];
  const gates = new Map((preview.proposal.qualityGates ?? [])
    .map(gate => [gate.command, gate.required ? 'required' : 'optional']));
  return Object.entries(preview.proposal.commands).flatMap(([logicalId, command]) => {
    const steps = Array.isArray(command) ? [{ cwd: '.', argv: command }] : command.steps;
    return steps.map((step, index) => {
      const prefix = Array.isArray(command)
        ? `project.commands.${logicalId}` : `project.commands.${logicalId}.steps[${index}]`;
      const source = preview.proposal.provenance?.[`${prefix}.cwd`]?.source
        ?? preview.proposal.provenance?.[`${prefix}[0]`]?.source
        ?? preview.proposal.provenance?.[prefix]?.source
        ?? 'unavailable';
      return `${logicalId} (${gates.get(logicalId) ?? 'not-gated'}): ${step.cwd} -> ${step.argv.join(' ')} [source: ${source}]`;
    });
  });
}

export async function setupCommand(parsed, dependencies) {
  const flags = parsed.flags;
  if (parsed.operands.length || parsed.subcommand !== null
    || Object.keys(flags).some(key => !['project', 'global', 'target', 'write', 'json'].includes(key))
    || (flags.global && flags.project !== undefined)
    || (flags.target !== undefined && !['claude', 'codex', 'both'].includes(flags.target))) {
    throw new CliError('Use rivet setup [--project=<path>|--global] [--target=claude|codex|both] [--write].', 'INVALID_INPUT');
  }
  const fs = dependencies.fs ?? filesystem;
  const root = resolve(dependencies.cwd(), flags.project ?? '.');
  const target = flags.target ?? 'both';
  const projectArgument = root === resolve(dependencies.cwd()) ? ''
    : ` --project='${root.replaceAll("'", "'\"'\"'")}'`;
  const installer = { command: 'install', subcommand: null, operands: [], flags: {
    minimal: true, target, ...(flags.global ? { global: true } : { project: root }),
  } };
  const services = dependencies.setup ?? {};
  const inspect = services.inspectInstall ?? inspectManagedInstall;
  const install = services.install ?? managedInstall;
  const initialize = services.init ?? init;
  // Preflight every install destination before creating any project configuration.
  const installation = await inspect(installer, dependencies);
  let configuration = { status: 'not-applicable' };
  let preview;
  if (!flags.global) {
    const retained = await existingConfiguration(root, fs);
    if (retained) configuration = { status: 'preserved' };
    else {
      preview = await captured(initialize, {
        command: 'init', subcommand: null, operands: [], flags: { project: root },
      }, dependencies);
      if (preview.code !== 0) return emit(parsed, dependencies, {
        ok: false, status: 'blocked', message: 'Project discovery failed. No setup files were written.',
        configuration: preview.value,
        nextSteps: [`Run rivet init${projectArgument} --json for configuration diagnostics.`],
      }, preview.code);
      configuration = { ...preview.value, status: 'proposed' };
    }
  }
  const missingScripts = preview?.value.discovery.unresolved?.map(item => item.command) ?? [];
  const tools = preview?.value.discovery.tools;
  const missingTools = tools ? ['node', 'git', ...Object.keys(tools).filter(key => ['npm', 'pnpm', 'yarn', 'bun'].includes(key))]
    .filter(name => !tools[name]?.present || (name === 'node' && Number.parseInt(tools.node.version, 10) < 22)) : [];
  const blockers = [
    ...missingTools.map(name => `Install ${name === 'node' ? 'Node.js 22 or newer' : name} and make it available on PATH.`),
  ];
  const warnings = [
    ...missingScripts.map(name => `No '${name}' package script was detected in the supported root/immediate-child scope. Add one before relying on this required check.`),
    ...(preview?.value.discovery.warnings ?? []).map(item => item.message),
  ];
  const result = {
    ok: true, status: 'preview', scope: flags.global ? 'global' : 'project', target,
    configuration, installation, blockers, warnings,
    message: 'Setup preview: no files were written.',
    nextSteps: blockers.length ? [...blockers, ...warnings] : [
      ...warnings,
      ...(!flags.global && preview ? [
        `Project configuration: ${CONFIG_FILES.map(name => join(root, '.rivet', name)).join(', ')}`,
        ...previewSteps(preview.value),
        'Checks have not run; setup only inspected bounded project metadata.',
      ] : []),
      ...(installation.targets ?? installation.result?.targets ?? [])
        .map(entry => `${entry.target} skill: ${entry.skillDir} (${entry.action})`),
      'Repeat with --write to apply this setup.',
    ],
  };
  if (!flags.write) return emit(parsed, dependencies, result);
  if (blockers.length) return emit(parsed, dependencies, {
    ...result, ok: false, status: 'blocked', message: 'Resolve the setup checks before writing configuration.',
  }, EXIT_CODES.FAILED_GATE);
  let configurationWritten = false;
  if (preview) {
    const written = await captured(initialize, {
      command: 'init', subcommand: null, operands: [], flags: { project: root, write: true },
    }, dependencies);
    if (written.code !== 0) return emit(parsed, dependencies, {
      ...result, ok: false, status: 'blocked', configuration: written.value,
      message: 'Configuration could not be written safely; harness installation was not started.',
    }, written.code);
    configuration = { ...written.value, status: 'written' };
    configurationWritten = true;
  }
  try {
    const installed = await captured(install, installer, dependencies);
    if (installed.code !== 0) throw new CliError('Harness installation did not complete.', 'REPOSITORY_CONFLICT');
    return emit(parsed, dependencies, {
      ...result, status: 'configured', configuration, installation: installed.value,
      message: flags.global ? 'Minimal Rivet harness instructions installed globally.' : 'Project configuration and minimal Rivet harness instructions are ready.',
      nextSteps: [
        ...warnings,
        'Reload your harness so it discovers the Rivet skill.',
        'Ask your harness: "Read the Rivet skill and report this project\'s configured checks."',
        ...(flags.global ? ['Run rivet setup from each project root to configure that project.'] : [
          'Review and commit the generated setup files. Confirm repository.defaultBranch in .rivet/project.yaml and switch to that branch before starting a task.',
          `Run rivet doctor${projectArgument} to inspect configured readiness.`,
          `Optionally run rivet integrations setup${projectArgument} to guide read-only tracker and context configuration.`,
          `Run rivet preflight --mode=host${projectArgument} before starting a task.`,
        ]),
        'This configures instructions and policy; model authentication and active-harness execution are separate.',
      ],
    });
  } catch {
    return emit(parsed, dependencies, {
      ok: false, status: configurationWritten ? 'partial' : 'blocked', configurationWritten,
      message: 'Harness installation stopped. Existing files and any newly written project configuration are preserved.',
      nextSteps: ['Resolve the installation conflict, then rerun setup. Inspect rivet install --minimal --json for details.'],
    }, EXIT_CODES.REPOSITORY_CONFLICT);
  }
}
