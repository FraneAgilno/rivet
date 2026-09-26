import { loadProjectConfig } from '../config/load.js';
import { gitExecutable, resolveConfiguredProject } from '../cli/project-discovery.js';
import { CliError, EXIT_CODES } from '../cli/output.js';
import { runArgv } from '../discovery/tools.js';
import { createGitClient } from '../git/client.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import {
  deliveryRecordPaths,
  listExistingFeatureRunPaths,
  resolveExistingFeatureRunPaths,
} from '../state/paths.js';
import { loadDeliveryCandidate } from '../delivery/prepare.js';
import { createDeliveryStore } from '../delivery/store.js';
import { createDeliveryService, createTrustedDeliveryExecutor } from '../delivery/service.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { createApprovalRegistry } from '../policy/approvals.js';
import { runRemoteDelivery } from './delivery-remote.js';
import { trackerTargetFromRun } from '../delivery/tracker-target.js';
import { hash } from '../delivery/contract.js';

function fail(message, code = 'INVALID_INPUT') {
  throw new CliError(message, code);
}
async function selectRun(project, flags, subcommand, runner) {
  if (flags.run !== undefined) {
    const paths = await resolveExistingFeatureRunPaths(project, flags.run, {
      runner,
    });
    if (paths === null) fail('The selected run was not found.', 'REPOSITORY_CONFLICT');
    return paths;
  }
  const candidates = [];
  for (const paths of await listExistingFeatureRunPaths(project, { runner })) {
    const record =
      subcommand !== 'prepare'
        ? await createDeliveryStore(await deliveryRecordPaths(paths)).read()
        : await createFeatureRunStore(paths).readOnly();
    if (record && (subcommand !== 'prepare' || record.status === 'awaiting-final-approval'))
      candidates.push(paths);
  }
  if (candidates.length !== 1)
    fail('Select one verified run with --run=<id>; no unique delivery run was found.', 'REPOSITORY_CONFLICT');
  return candidates[0];
}

export async function deliveryCommand(parsed, dependencies) {
  const { subcommand, operands, flags } = parsed;
  if (
    !['prepare', 'status', 'refresh', 'review', 'merge', 'deploy', 'tracker-update', 'reconcile', 'recover'].includes(subcommand) ||
    operands.length ||
    Object.keys(flags).some(
      (key) => !['project', 'run', 'remote', 'json', 'provider', 'method'].includes(key)
    ) ||
    (flags.run !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(flags.run)) ||
    flags.run?.length > 64 ||
    (subcommand !== 'prepare' && flags.remote !== undefined) ||
    (flags.provider !== undefined &&
      (!['refresh', 'review', 'merge', 'deploy', 'tracker-update', 'reconcile'].includes(subcommand) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(flags.provider))) ||
    (flags.method !== undefined &&
      (subcommand !== 'merge' || !['merge', 'squash', 'rebase'].includes(flags.method))) ||
    (['review', 'merge', 'deploy', 'tracker-update'].includes(subcommand) && flags.json)
  ) {
    fail(
      'Use rivet delivery prepare|status|refresh|review|merge|deploy|tracker-update|reconcile|recover [--run=<id>] [--project=<path>]. Prepare accepts --remote; remote operations accept --provider; interactive merge accepts --method=merge|squash|rebase. JSON is unavailable for delivery writes.'
    );
  }
  const project = await resolveConfiguredProject(dependencies.cwd(), flags.project, {
    runner: dependencies.runGit,
    env: dependencies.env,
  });
  const executable = await gitExecutable(dependencies.env);
  const runner = (_command, args, options) => (dependencies.runGit ?? runArgv)(executable, args, options);
  let result;
  try {
    const paths = await selectRun(project.root, flags, subcommand, runner);
    const store = createDeliveryStore(await deliveryRecordPaths(paths));
    if (subcommand === 'recover') {
      const recovery = await store.recover();
      if (flags.json) dependencies.output.json({ok: true, runId: paths.runId, recovery});
      else {
        dependencies.output.log(recovery.recoveredLocks.length
          ? `Recovered abandoned delivery locks: ${recovery.recoveredLocks.join(', ')}.`
          : 'No abandoned delivery locks needed recovery.');
        dependencies.output.log('Reconcile any pending provider outcome with rivet delivery reconcile.');
      }
      return EXIT_CODES.SUCCESS;
    }
    result = await store.read();
    if (subcommand === 'prepare') {
      const gitClient = await createGitClient({ gitExecutable: executable });
      const candidate = await loadDeliveryCandidate({
        project: project.root,
        runId: paths.runId,
        remoteName: flags.remote,
        gitClient,
        runner,
      });
      if (result !== null) {
        if (
          result.candidate.localVerification.evidenceDigest !== candidate.localVerification.evidenceDigest ||
          result.candidate.repository.url !== candidate.repository.url ||
          result.candidate.sourceBranch !== candidate.sourceBranch ||
          result.candidate.targetBranch !== candidate.targetBranch
        )
          fail(
            'Delivery already records a different candidate. Inspect its status before continuing.',
            'REPOSITORY_CONFLICT'
          );
      } else {
        const service = createDeliveryService({
          store,
          executor: createTrustedDeliveryExecutor({
            provider: candidate.repository.provider,
            capabilities: [],
          }),
          providerId: 'repository',
          subjectId: 'delivery-cli',
          expectedApproverId: 'terminal-human',
          authority: createAuthorityEnvelope({
            actorId: 'delivery-cli',
            principal: 'agent',
            actions: [],
            ownedPaths: [],
            providers: [],
            commands: [],
          }),
          approvalRegistry: createApprovalRegistry({
            approvers: [{ id: 'terminal-human', principal: 'human' }],
          }),
          clock: () => new Date().toISOString(),
        });
        result = await service.initialize(candidate);
      }
    }
    if (['refresh', 'review', 'merge', 'deploy', 'tracker-update', 'reconcile'].includes(subcommand)) {
      result = await runRemoteDelivery({
        action: subcommand,
        store,
        config: project.config,
        reloadConfig: () => loadProjectConfig(project.root),
        loadTrackerTarget: async candidate => trackerTargetFromRun(await createFeatureRunStore(paths).readOnly(), candidate),
        flags,
        dependencies,
        validateLocal: async (expected) => {
          const gitClient = await createGitClient({ gitExecutable: executable });
          // Select the previously recorded repository even if another remote exists.
          const { discoverRepositoryRemotes } = await import('../repositories/index.js');
          const remotes = await discoverRepositoryRemotes(project.root, { runner });
          const remote = remotes.find((item) => item.url === expected.repository.url);
          if (!remote) fail('The prepared repository remote is no longer configured.', 'REPOSITORY_CONFLICT');
          const current = await loadDeliveryCandidate({
            project: project.root,
            runId: paths.runId,
            remoteName: remote.remoteName,
            gitClient,
            runner,
          });
          if (
            hash(current.localVerification) !== hash(expected.localVerification) ||
            hash(current.repository) !== hash(expected.repository) ||
            current.sourceBranch !== expected.sourceBranch ||
            current.targetBranch !== expected.targetBranch
          )
            fail(
              'The local candidate changed. Verify the work before preparing delivery again.',
              'REPOSITORY_CONFLICT'
            );
        },
      });
    }
    if (result === null)
      fail(
        'No delivery record exists. Run rivet delivery prepare after verification.',
        'REPOSITORY_CONFLICT'
      );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === 'ERR_DELIVERY_BRANCH_NOT_PUBLISHED') fail(error.safeMessage, 'REPOSITORY_CONFLICT');
    if (subcommand === 'recover') fail(
      'Delivery recovery stopped. Locks must be at least five minutes old and owned by a provably dead process on this machine. Live, foreign, unsafe or previously claimed locks require investigation; no force option is available.',
      'REPOSITORY_CONFLICT'
    );
    fail(
      'Delivery stopped. Check verification, configured provider access, supported delivery policy and delivery status. An uncertain operation requires delivery reconcile before retry.',
      'REPOSITORY_CONFLICT'
    );
  }
  const incomplete =
    ['review', 'merge', 'deploy', 'tracker-update', 'reconcile'].includes(subcommand) &&
    (result.operations.some((op) => ['dispatching', 'indeterminate'].includes(op.state)) ||
      (['review', 'merge', 'deploy', 'tracker-update'].includes(subcommand) &&
        !result.operations.some((op) => op.action === (subcommand === 'review' ? 'review-request' : subcommand) && op.state === 'succeeded')));
  if (flags.json) dependencies.output.json({ ok: !incomplete, result });
  else {
    dependencies.output.log(`Recorded delivery stage: ${result.stage}`);
    dependencies.output.log(`Run: ${result.candidate.runId}`);
    dependencies.output.log(`Repository: ${result.candidate.repository.url}`);
    dependencies.output.log(`Commit: ${result.candidate.headSha}`);
    dependencies.output.log(
      incomplete
        ? 'Outcome is not confirmed. Run rivet delivery reconcile; do not repeat the write.'
        : 'Status records confirmed stages. Delivery writes require configured provider support and interactive approval.'
    );
  }
  return incomplete ? EXIT_CODES.PROVIDER_UNAVAILABLE : EXIT_CODES.SUCCESS;
}
