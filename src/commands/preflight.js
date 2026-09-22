import { join, resolve } from 'node:path';

import { EXIT_CODES } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { discoverGit } from '../discovery/git.js';
import { discoverTools } from '../discovery/tools.js';
import { diagnoseDoctor } from './doctor.js';

function check(id, passed, remediation, details = {}) {
  return { id, status: passed ? 'pass' : 'fail', ...details, ...(passed ? {} : { remediation }) };
}

function emit(output, json, payload, exitCode) {
  if (json) {
    output.json(payload, exitCode === EXIT_CODES.SUCCESS ? 'stdout' : 'stderr');
  } else if (exitCode === EXIT_CODES.SUCCESS) {
    output.log(`Preflight: ${payload.status}.`);
  } else {
    output.error(`Preflight: ${payload.status}. ${payload.remediations.join(' ')}`);
  }
  return exitCode;
}

function defaultGoalState() {
  return { status: 'not_initialized' };
}

export async function preflight(parsed, dependencies = {}) {
  const json = parsed.flags.json === true;
  const projectRoot = resolve(parsed.flags.project ?? dependencies.cwd?.() ?? process.cwd());
  let config;
  try {
    config = await (dependencies.configLoader ?? loadProjectConfig)(projectRoot, { fs: dependencies.fs });
  } catch {
    return emit(dependencies.output, json, {
      ok: false,
      status: 'fail',
      checks: [],
      remediations: ['Create or repair the project configuration before preflight.'],
      error: {
        code: 'MISSING_CONFIGURATION',
        exitCode: EXIT_CODES.MISSING_CONFIGURATION,
        message: 'Project configuration is missing or invalid.',
      },
    }, EXIT_CODES.MISSING_CONFIGURATION);
  }
  try {
    const packageManager = config.project.stack.packageManager;
    const doctor = await diagnoseDoctor(projectRoot, dependencies);
    const [git, tools, goalState] = await Promise.all([
      (dependencies.gitDiscovery ?? discoverGit)(projectRoot, {
        runner: dependencies.runner,
        candidatePaths: dependencies.candidatePaths ?? [join(projectRoot, '.worktrees', 'next')],
      }),
      (dependencies.toolDiscovery ?? discoverTools)({ packageManager }, {
        cwd: projectRoot,
        runner: dependencies.runner,
      }),
      (dependencies.goalStateReader ?? defaultGoalState)(projectRoot),
    ]);
    const capacity = dependencies.runtimeCapacity ?? { available: 1, required: 1 };
    const qualityCommands = doctor.checks?.commands ?? { ready: false, steps: [] };
    const checks = [
      check('doctor', doctor.exitCode === EXIT_CODES.SUCCESS, 'Run doctor and resolve failed readiness checks.'),
      check('repository', git.repository === true, 'Run preflight inside a Git repository.'),
      check('worktree-clean', git.dirty === false, 'Commit or stash worktree changes.'),
      check('head-attached', git.detached === false, 'Switch to a local branch.'),
      check('base-freshness', git.baseFreshness === 'fresh' || git.baseFreshness === 'ahead', 'Update the local default branch from its existing remote-tracking ref.'),
      check('worktree-discovery', git.worktreeCheck?.checked === true, 'Resolve local Git worktree discovery before retrying.'),
      check('worktree-paths', (git.occupiedCandidatePaths ?? []).length === 0, 'Select an unoccupied worktree path.', {
        occupiedCount: (git.occupiedCandidatePaths ?? []).length,
      }),
      check('runtime-capacity', Number(capacity.available) >= Number(capacity.required), 'Increase available runtime capacity.', {
        available: Number(capacity.available), required: Number(capacity.required),
      }),
      check('goal-state', goalState?.status === 'ready', 'Initialize and approve the private goal instance.'),
      check('toolchain', tools.node?.supported === true && tools[packageManager]?.supported === true && tools.git?.supported === true,
        'Install a supported local Node, package manager, and Git toolchain.'),
      check('quality-commands', qualityCommands.ready, 'Define every required quality command as an effective bounded package script.', {
        commands: qualityCommands.steps,
      }),
    ];
    const failed = checks.filter(item => item.status === 'fail');
    const payload = {
      ok: failed.length === 0,
      status: failed.length === 0 ? 'pass' : 'fail',
      checks,
      remediations: [...new Set(failed.map(item => item.remediation))],
    };
    return emit(dependencies.output, json, payload,
      failed.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILED_GATE);
  } catch {
    return emit(dependencies.output, json, {
      ok: false,
      status: 'fail',
      checks: [],
      remediations: ['Retry after resolving the local discovery failure.'],
      error: {
        code: 'INTERNAL_ERROR',
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: 'Preflight could not complete safely.',
      },
    }, EXIT_CODES.INTERNAL_ERROR);
  }
}
