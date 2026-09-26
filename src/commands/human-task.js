import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { withTerminalInterruption } from '../cli/interrupt.js';
import { CliError, EXIT_CODES } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { createGitClient } from '../git/client.js';
import { createReservationStore } from '../git/reservations.js';
import { bootstrapWorktreeDependencies } from '../runtime/worktree-bootstrap.js';
import { listExistingFeatureRunPaths, resolveExistingStatePaths } from '../state/paths.js';
import { invokeFeature } from './feature.js';
import { confirmIsolatedDependencyInstall } from './dependency-approval.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTIVE = new Set(['proposed', 'approved', 'running', 'blocked', 'awaiting-final-approval']);

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function visible(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function diagnostic(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character =>
    character === '\n' || character === '\t'
      ? character : `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

async function runs(project) {
  try {
    const paths = await listExistingFeatureRunPaths(project);
    const result = [];
    for (const path of paths) {
      const record = await createFeatureRunStore(path).readOnly();
      if (record === null) fail('A private run is incomplete. Inspect its state before selecting another run.', 'REPOSITORY_CONFLICT');
      result.push(record);
    }
    return result;
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Private run discovery failed or found unsafe state. Inspect it before continuing.', 'REPOSITORY_CONFLICT');
  }
}

function summary(record) {
  const criterion = record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title;
  return `${record.runId}: ${record.status} (${record.featurePlan.client}) ${visible(criterion.slice(0, 100))}`;
}

async function selectedRun(project, wanted, operation, output) {
  const records = await runs(project);
  if (wanted !== undefined) {
    if (typeof wanted !== 'string' || !RUN_ID.test(wanted)) fail('Run selector is invalid.');
    const exact = records.find(record => record.runId === wanted);
    if (!exact) fail('No task with that run ID exists in this project.', 'REPOSITORY_CONFLICT');
    return exact;
  }
  const eligible = records.filter(record => ACTIVE.has(record.status)
    && (operation !== 'recover' || record.featurePlan.client === 'host'));
  if (eligible.length === 0) fail(operation === 'recover' ? 'No active host task exists in this project.'
    : 'No active task exists in this project. Start one with rivet run "task".', 'REPOSITORY_CONFLICT');
  if (eligible.length > 1) {
    output.log('Several active tasks exist:');
    for (const record of eligible) output.log(`  ${summary(record)}`);
    fail('Choose one with --run=<id>. Rivet will not guess which task you mean.');
  }
  return eligible[0];
}

async function dependencyCommand(project, record, dependencies) {
  if (dependencies.terminalIsInteractive?.() !== true || typeof dependencies.confirmDependencyInstall !== 'function') {
    fail('Run rivet task deps in an interactive terminal to approve dependency installation.');
  }
  if (typeof dependencies.work?.status !== 'function'
    || typeof dependencies.resolveCommandExecutable !== 'function') fail('Dependency setup is unavailable.', 'MISSING_CONFIGURATION');
  const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
  let target = null;
  if (record.featurePlan.client === 'host' && record.status === 'running') {
    const statePaths = await resolveExistingStatePaths(project.root, record.runId);
    const workerIds = new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => node.id));
    const nodes = (status.runtime?.nodes ?? []).filter(node => node.status === 'running' && workerIds.has(node.id));
    if (statePaths && nodes.length === 1) {
      const reservations = await createReservationStore(statePaths).list();
      const matches = reservations.reservations.filter(item => item.status === 'active' && item.nodeId === nodes[0].id);
      if (matches.length === 1) target = {
        path: matches[0].worktreePath,
        commit: matches[0].baseSha,
        branch: matches[0].branch,
        kind: 'worker',
      };
    }
  }
  if (!target && status.checkout?.status === 'clean') target = {
    path: status.checkout.path,
    commit: status.checkout.acceptedCommit,
    branch: status.checkout.branch,
    kind: 'integration',
  };
  if (!['running', 'blocked'].includes(record.status) || !target) {
    fail('This task has no eligible isolated checkout yet. Continue the task, then retry dependency setup.', 'REPOSITORY_CONFLICT');
  }
  const config = await loadProjectConfig(project.root);
  let gitClient;
  try { gitClient = await createGitClient({ gitExecutable: await dependencies.resolveCommandExecutable('git') }); }
  catch { fail('A supported Git executable is required for dependency setup.', 'PROVIDER_UNAVAILABLE'); }
  return withTerminalInterruption(async signal => {
    let result;
    try {
      result = await bootstrapWorktreeDependencies({
        projectRoot: project.root,
        worktreePath: target.path,
        expectedCommit: target.commit,
        expectedBranch: target.branch,
        manager: config.project.stack.packageManager,
      }, {
        gitClient,
        resolveCommandExecutable: dependencies.resolveCommandExecutable,
        confirm: confirmIsolatedDependencyInstall(dependencies, signal),
        signal,
      });
    } catch (error) {
      fail(error?.safeMessage ?? 'Dependency setup failed safely.', 'FAILED_GATE');
    }
    if (result.status === 'declined') {
      dependencies.output.log('Dependency setup was declined.');
      return EXIT_CODES.SUCCESS;
    }
    if (result.status !== 'ready') {
      dependencies.output.error(`Dependency setup failed (${visible(result.result.status)}).`);
      if (result.result.stdout) dependencies.output.error(`stdout:\n${diagnostic(result.result.stdout)}`);
      if (result.result.stderr) dependencies.output.error(`stderr:\n${diagnostic(result.result.stderr)}`);
      return EXIT_CODES.FAILED_GATE;
    }
    dependencies.output.log(record.featurePlan.client === 'host'
      ? target.kind === 'worker'
        ? 'Dependencies are ready in the Worker checkout. Continue in the owning harness.'
        : 'Dependencies are ready in the isolated checkout. Continue in the owning harness and retry work verify.'
      : 'Dependencies are ready in the isolated checkout. Use rivet task resume to retry verification.');
    return EXIT_CODES.SUCCESS;
  });
}

function renderWorkerCheckouts(status, output) {
  for (const worker of status.workerCheckouts ?? []) {
    output.log(`Worker checkout: ${visible(worker.nodeId)} (${visible(worker.status)}; ${visible(worker.reservationStatus)}${worker.leaseExpired ? '; lease expired' : ''})`);
    output.log(`  Path: ${visible(worker.path)}`);
    output.log(`  Branch: ${visible(worker.expectedBranch)}; observed: ${visible(worker.observedBranch ?? 'unknown')}`);
    for (const path of worker.dirtyPaths) output.log(`  Uncommitted: ${visible(path)}`);
    for (const path of worker.branchLocations) output.log(`  Branch location: ${visible(path)}`);
    output.log(`  Next: ${visible(worker.nextAction)}`);
  }
}

export async function humanTaskCommand(parsed, dependencies) {
  if (parsed.command !== 'task' || !['status', 'resume', 'deps', 'recover'].includes(parsed.subcommand)
    || parsed.operands.length !== 0 || Object.keys(parsed.flags).some(key => !['project', 'run'].includes(key))) {
    fail('Use rivet task status|resume|deps|recover [--project=<path>] [--run=<id>].');
  }
  const project = await resolveConfiguredProject(dependencies.cwd(), parsed.flags.project, { env: dependencies.env });
  const record = await selectedRun(project.root, parsed.flags.run, parsed.subcommand, dependencies.output);
  if (parsed.subcommand === 'recover') {
    if (record.featurePlan.client !== 'host') fail('Lock recovery is only available for host tasks; a spawned worker must not be restarted by recovery.', 'REPOSITORY_CONFLICT');
    if (typeof dependencies.work?.recover !== 'function') fail('Host recovery is unavailable.', 'MISSING_CONFIGURATION');
    const result = await invokeFeature(dependencies.work, 'recover', { project: project.root, runId: record.runId });
    dependencies.output.log(`Recovery: ${visible(result.status)}.`);
    dependencies.output.log(`Recovered locks: ${result.recoveredLocks.map(visible).join(', ') || 'none'}.`);
    if (result.blockedLock) dependencies.output.error(`Blocked lock: ${visible(result.blockedLock)}.`);
    dependencies.output.log(visible(result.nextAction));
    return result.status === 'recovered' ? EXIT_CODES.SUCCESS : EXIT_CODES.REPOSITORY_CONFLICT;
  }
  if (parsed.subcommand === 'deps') return dependencyCommand(project, record, dependencies);
  if (parsed.subcommand === 'status') {
    if (typeof dependencies.work?.status !== 'function') fail('Task status is unavailable.', 'MISSING_CONFIGURATION');
    const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
    dependencies.output.log(`Task: ${visible(record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title)}`);
    dependencies.output.log(`State: ${visible(record.status)}`);
    if (record.featurePlan.nodes.some(node => node.execution)) {
      dependencies.output.log(`Planning harness: ${record.featurePlan.client}`);
      dependencies.output.log(`Worker harnesses: ${[...new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => node.execution?.client ?? record.featurePlan.client))].join(', ')}`);
    } else dependencies.output.log(`Harness: ${record.featurePlan.client}`);
    dependencies.output.log(`Next: ${visible(status.nextAction)}`);
    if (status.verification) {
      dependencies.output.log(`Verification: ${status.verification.status} at ${status.verification.commitSha}`);
      for (const path of status.verification.changedPaths) dependencies.output.log(`Changed: ${visible(path)}`);
      for (const check of status.verification.checks) {
        dependencies.output.log(`Check: ${visible(check.id)} ${check.status} (${visible(check.cwd)})`);
        if (check.status === 'failed') {
          dependencies.output.log(`  Exit: ${check.exitCode ?? 'unknown'}; execution: ${visible(check.executionStatus)}`);
          if (check.output?.stdout) dependencies.output.log(`  stdout:\n${diagnostic(check.output.stdout)}`);
          if (check.output?.stderr) dependencies.output.log(`  stderr:\n${diagnostic(check.output.stderr)}`);
          if (check.output?.truncated?.combined || check.output?.truncated?.stdout || check.output?.truncated?.stderr) {
            dependencies.output.log('  Output was truncated.');
          }
          if (check.output?.redacted) dependencies.output.log('  Output was redacted.');
          if (check.output?.suppressed) dependencies.output.log('  Output was suppressed.');
        }
      }
      if (status.verification.failure) dependencies.output.log(`Failure: ${visible(status.verification.failure)}`);
    }
    renderWorkerCheckouts(status, dependencies.output);
    if (status.checkout) dependencies.output.log(`Integration checkout: ${visible(status.checkout.path)} (${status.checkout.status})`);
    return EXIT_CODES.SUCCESS;
  }
  if (record.featurePlan.client === 'host') {
    const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
    renderWorkerCheckouts(status, dependencies.output);
    dependencies.output.log(`Host task: ${visible(status.run.status)}. ${visible(status.nextAction)}`);
    dependencies.output.log('Continue in the coding harness that owns this task; Rivet will not launch a second worker.');
    return EXIT_CODES.SUCCESS;
  }
  if (record.status === 'running') {
    fail('This spawned run is already marked running. Rivet cannot prove its worker stopped, so it will not launch a duplicate. Inspect its process and state.', 'REPOSITORY_CONFLICT');
  }
  if (!['approved', 'blocked'].includes(record.status)) {
    fail('This task cannot be resumed from its current state.', 'REPOSITORY_CONFLICT');
  }
  if (typeof dependencies.feature?.resume !== 'function') fail('Feature resume is unavailable.', 'MISSING_CONFIGURATION');
  if (typeof dependencies.harnesses?.select !== 'function') fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
  return withTerminalInterruption(async signal => {
    const clients = new Set(record.featurePlan.nodes.filter(node => node.role === 'worker')
      .map(node => node.execution?.client ?? record.featurePlan.client));
    for (const client of clients) {
      try { await dependencies.harnesses.select(client, project.root, { signal }); }
      catch { fail(`The saved worker harness ${client} is unavailable or incompatible. Restore it before resuming; Rivet will not switch models.`, 'PROVIDER_UNAVAILABLE'); }
    }
    const result = await invokeFeature(dependencies.feature, 'resume', {
      project: project.root, runId: record.runId, expectedVersion: record.version,
    }, { signal, confirmDependencyInstall: confirmIsolatedDependencyInstall(dependencies, signal) });
    dependencies.output.log(`Task: ${visible(result.status)}.`);
    if (result.summary) dependencies.output.log(visible(result.summary));
    return result.status === 'awaiting-final-approval' ? EXIT_CODES.SUCCESS
      : result.status === 'blocked' ? EXIT_CODES.FAILED_GATE : EXIT_CODES.REPOSITORY_CONFLICT;
  });
}
