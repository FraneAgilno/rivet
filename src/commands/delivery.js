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
    !['prepare', 'status', 'refresh', 'publish', 'review', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-status', 'tracker-transition', 'reconcile', 'recover'].includes(subcommand) ||
    operands.length ||
    Object.keys(flags).some(
      (key) => !['project', 'run', 'remote', 'json', 'provider', 'method', 'title', 'body'].includes(key)
    ) ||
    (subcommand === 'review-update' ? typeof flags.title !== 'string' || typeof flags.body !== 'string' : flags.title !== undefined || flags.body !== undefined) ||
    (flags.run !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(flags.run)) ||
    flags.run?.length > 64 ||
    (subcommand !== 'prepare' && flags.remote !== undefined) ||
    (flags.provider !== undefined &&
      (!['refresh', 'publish', 'review', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-status', 'tracker-transition', 'reconcile'].includes(subcommand) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(flags.provider))) ||
    (flags.method !== undefined &&
      (subcommand !== 'merge' || !['merge', 'squash', 'rebase'].includes(flags.method))) ||
    (['publish', 'review', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-transition'].includes(subcommand) && flags.json)
  ) {
    fail(
      'Use rivet delivery prepare|status|refresh|publish|review|review-update|merge|deploy|tracker-update|tracker-status|tracker-transition|reconcile|recover [--run=<id>] [--project=<path>]. Prepare accepts --remote; remote operations accept --provider; interactive merge accepts --method=merge|squash|rebase. JSON is unavailable for delivery writes.'
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
    if (['refresh', 'publish', 'review', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-status', 'tracker-transition', 'reconcile'].includes(subcommand)) {
      result = await runRemoteDelivery({
        action: subcommand,
        publicationContext: {project: project.root, gitExecutable: executable},
        store,
        config: project.config,
        reloadConfig: () => loadProjectConfig(project.root),
        loadTrackerTarget: async candidate => trackerTargetFromRun(await createFeatureRunStore(paths).readOnly(), candidate),
        flags,
        dependencies,
        validateLocal: async (expected) => {
          const gitClient = await createGitClient({ gitExecutable: executable });
          // Select the previously recorded repository even if another remote exists.
          const { discoverRepositoryRemotes, parseRepositoryRemote } = await import('../repositories/index.js');
          const remotes = await discoverRepositoryRemotes(project.root, { runner });
          const remote = remotes.find((item) => {try {return hash(parseRepositoryRemote(item.url)) === hash(expected.repository);} catch {return false;}});
          if (!remote) fail('The prepared repository remote is no longer configured.', 'REPOSITORY_CONFLICT');
          const current = await loadDeliveryCandidate({
            project: project.root,
            runId: paths.runId,
            remoteName: remote.name,
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
  const incomplete = deliveryOutcomeIncomplete(subcommand, result);
  if (flags.json) dependencies.output.json({ ok: !incomplete, result });
  else {
    if (result.trackerStatus) {
      dependencies.output.log(`Tracker: ${result.trackerStatus.target.issueUrl}\nCurrent status: ${result.trackerStatus.current.name}`);
      for (const choice of result.trackerStatus.destinations) dependencies.output.log(`${choice.state.name} (${choice.name}; ${choice.state.type})${choice.eligible ? '' : ' - unavailable: requires fields or screen'}`);
    }
    if (result.reviewUpdateNoop) dependencies.output.log('The review already has the requested title and body. No write was sent.');
    if (result.trackerTransitionNoop) dependencies.output.log('The selected destination is already current. No write was sent and no transition receipt was created.');
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

export function deliveryOutcomeIncomplete(subcommand, result) {
  if (subcommand === 'review-update' && result.reviewUpdateNoop) return false;
  if (subcommand === 'tracker-transition' && result.trackerTransitionNoop) return false;
  if (subcommand === 'tracker-status') return false;
  if (!['publish', 'review', 'review-update', 'merge', 'deploy', 'tracker-update', 'tracker-status', 'tracker-transition', 'reconcile'].includes(subcommand)) return false;
  if (result.operations.some(op => ['dispatching', 'indeterminate'].includes(op.state))) return true;
  if (subcommand === 'reconcile') return false;
  const action = subcommand === 'publish' ? 'branch-publish' : subcommand === 'review' ? 'review-request' : subcommand;
  const alreadyPublished = subcommand === 'publish' && result.observation?.publication?.remoteSha === result.candidate.headSha;
  return !alreadyPublished && !result.operations.some(op => op.action === action && op.state === 'succeeded');
}
