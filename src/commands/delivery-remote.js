import { randomUUID } from 'node:crypto';
import { CliError } from '../cli/output.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { hash, plain } from '../delivery/contract.js';
import { createDeliveryService } from '../delivery/service.js';

function fail(message, code = 'REPOSITORY_CONFLICT') {
  throw new CliError(message, code);
}
const ENDPOINTS = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
function providerFor(config, repository, flags, writing, operation = 'merge') {
  const providers = config.providers.providers.filter(
    (provider) =>
      provider.kind === 'git-ci' &&
      provider.mode !== 'disabled' &&
      (!writing || provider.mode === 'read-write-with-approval') &&
      (provider.transport ?? 'direct-api') === 'direct-api' &&
      ['repository-read', ...(operation === 'deploy' ? ['deployments-read', 'actions-read'] : ['checks-read']), ...(writing ? [operation] : [])].every((cap) =>
        provider.capabilities.includes(cap)
      ) &&
      (!provider.projectIds?.length || provider.projectIds.includes(config.project.id)) &&
      (!provider.resourceIds?.length || provider.resourceIds.includes(repository.fullName)) &&
      provider.endpoint?.replace(/\/$/, '') === ENDPOINTS[repository.provider] &&
      (flags.provider === undefined || provider.id === flags.provider)
  );
  if (providers.length !== 1)
    fail(
      'Configure one scoped repository API provider. Merge needs repository-read/checks-read; deployment needs repository-read/deployments-read/actions-read. Writes require the action capability and read-write-with-approval mode.',
      'MISSING_CONFIGURATION'
    );
  return providers[0];
}
function headers(provider, environment, kind) {
  const credentials = provider.credentials ?? {};
  const keys = Object.keys(credentials);
  if (
    keys.length !== 1 ||
    !['tokenEnv', 'accessTokenEnv', 'apiTokenEnv'].includes(keys[0]) ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(credentials[keys[0]])
  )
    fail('Configure one token environment reference for repository delivery.', 'MISSING_CONFIGURATION');
  const token = environment[credentials[keys[0]]];
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(token))
    fail('The configured repository token is missing or invalid.', 'PROVIDER_UNAVAILABLE');
  return {
    authorization: `Bearer ${token}`,
    accept: kind === 'github' ? 'application/vnd.github+json' : 'application/json',
  };
}
async function confirm(dependencies, preview) {
  let timer;
  try {
    return (
      (await Promise.race([
        Promise.resolve().then(() => dependencies.confirmDelivery(preview)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 30000);
        }),
      ])) === true
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runRemoteDelivery({ action, store, config, flags, dependencies, validateLocal, loadTrackerTarget, reloadConfig = async () => config }) {
  const writing = ['merge', 'deploy', 'tracker-update'].includes(action);
  if (!['merge', 'deploy', 'tracker-update', 'refresh', 'reconcile'].includes(action))
    fail('Unsupported delivery action.', 'INVALID_INPUT');
  if (
    writing &&
    (flags.json ||
      dependencies.terminalIsInteractive?.() !== true ||
      typeof dependencies.confirmDelivery !== 'function')
  )
    fail(
      'Run delivery writes in an interactive terminal to review and approve the exact operation. JSON and unattended writes are unavailable.',
      'INVALID_INPUT'
    );
  let state = await store.read();
  if (!state) fail('Run rivet delivery prepare after verification first.');
  const pendingAction = state.operations.find(op => ['dispatching','indeterminate'].includes(op.state))?.action;
  if (action === 'tracker-update' || (action === 'reconcile' && pendingAction === 'tracker-update')) {
    const {runTrackerDelivery} = await import('./delivery-tracker.js');
    return runTrackerDelivery({action,state,store,config,flags,dependencies,reloadConfig,loadTrackerTarget,
      confirm: preview => confirm(dependencies,preview)});
  }
  const kind = state.candidate.repository.provider;
  if (!Object.hasOwn(ENDPOINTS, kind))
    fail('Native merge currently supports GitHub.com and GitLab.com only.', 'PROVIDER_UNAVAILABLE');
  if (action === 'merge' && kind === 'gitlab' && flags.method !== undefined && flags.method !== 'merge')
    fail(
      'GitLab currently supports --method=merge only; squash and rebase are unavailable.',
      'INVALID_INPUT'
    );
  if (writing && state.operations.some((op) => op.action === action && op.state === 'succeeded'))
    return state;
  const operation = action === 'reconcile'
    ? state.operations.find(op => ['dispatching', 'indeterminate'].includes(op.state))?.action
    : action;
  const deploying = operation === 'deploy';
  let deployment;
  let mergeReceipt;
  if (deploying) {
    if (kind !== 'github' || !config.project.deployment)
      fail('Configure project.deployment for GitHub Actions deployment first.', 'MISSING_CONFIGURATION');
    deployment = plain(config.project.deployment);
    if (flags.provider !== undefined && flags.provider !== deployment.providerId)
      fail('Deployment uses the provider declared in project.deployment.', 'INVALID_INPUT');
    mergeReceipt = state.operations.find(op => op.action === 'merge' && op.state === 'succeeded')?.receipt;
    if (!mergeReceipt) fail('Deployment requires a confirmed merge receipt.');
  }
  const selectedFlags = deploying ? { ...flags, provider: deployment.providerId } : flags;
  const provider = providerFor(config, state.candidate.repository, selectedFlags, writing, deploying ? 'deploy' : 'merge');
  const auth = headers(provider, dependencies.env, kind);
  const executorFactory =
    (deploying ? dependencies.delivery?.deploymentExecutorFactory : dependencies.delivery?.executorFactory) ??
    (deploying ? (await import('../delivery/github-deployment.js')).createGithubDeploymentExecutor :
    (kind === 'github'
      ? (await import('../delivery/github.js')).createGithubDeliveryExecutor
      : (await import('../delivery/gitlab.js')).createGitlabDeliveryExecutor));
  const executor = executorFactory({
    repository: state.candidate.repository,
    ...(deploying ? {deployment, mergeReceipt} : {}),
    headers: auth,
    transport: dependencies.delivery?.transport ?? createNodeProviderTransport(),
  });
  const service = createDeliveryService({
    store,
    executor,
    timeoutMs: 120000,
    providerId: provider.id,
    subjectId: 'delivery-cli',
    expectedApproverId: 'terminal-human',
    authority: createAuthorityEnvelope({
      actorId: 'delivery-cli',
      principal: 'agent',
      actions: writing ? ['provider.write'] : [],
      ownedPaths: [],
      commands: [],
      providers: writing ? [{ id: provider.id, mode: provider.mode, capabilities: [action] }] : [],
    }),
    approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'terminal-human', principal: 'human' }] }),
  });
  if (action === 'reconcile') return service.reconcile({ expectedVersion: state.version });
  if (action === 'merge') await validateLocal(state.candidate);
  state = await service.refresh({ expectedVersion: state.version });
  if (!writing) return state;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  state = await service.propose({
    expectedVersion: state.version,
    action,
    expiresAt,
    payload: deploying ? {workflow: deployment.workflow, environment: deployment.environment, productionEnvironment: deployment.productionEnvironment} : {
      reviewNumber: state.observation.review?.number,
      mergeMethod: flags.method ?? (kind === 'github' ? 'squash' : 'merge'),
    },
  });
  if (deploying) {
    dependencies.output.log(`Deploy ${mergeReceipt.commitSha} to ${deployment.environment}`);
    dependencies.output.log(`Workflow: ${deployment.workflow}. Production environment: ${deployment.productionEnvironment}.`);
  } else {
  dependencies.output.log(`Merge ${state.observation.review.url}`);
  dependencies.output.log(
    `${state.candidate.sourceBranch} (${state.candidate.headSha}) -> ${state.candidate.targetBranch} (${state.observation.baseSha})`
  );
  dependencies.output.log(
    `Method: ${state.proposal.payload.mergeMethod}. Required checks and supported review policy passed.`
  );
  }
  if (!(await confirm(dependencies, state)))
    fail('Delivery operation was not approved. Nothing was dispatched.', 'INVALID_INPUT');
  if (deploying) {
    const currentConfig = await reloadConfig();
    const currentProvider = providerFor(currentConfig, state.candidate.repository, selectedFlags, true, 'deploy');
    if (hash(currentConfig.project.deployment) !== hash(deployment) || hash(currentProvider) !== hash(provider))
      fail('Deployment configuration changed. Review a new proposal.');
  }
  if (action === 'merge') await validateLocal(state.candidate);
  const approval = createApprovalReceipt({
    id: `${action}-${randomUUID()}`,
    approverId: 'terminal-human',
    approverPrincipal: 'human',
    subjectId: 'delivery-cli',
    action: 'provider.write',
    resource: state.proposal.approvalResource,
    policyId: 'authority.external-write',
    decision: 'approved',
    expiresAt,
    singleUse: true,
  });
  return service.execute({ expectedVersion: state.version, proposalDigest: state.proposal.digest, approval });
}
