import { randomUUID } from 'node:crypto';
import { CliError } from '../cli/output.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createDeliveryService } from '../delivery/service.js';
import { hash, plain } from '../delivery/contract.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';

function fail(message, code = 'MISSING_CONFIGURATION') { throw new CliError(message, code); }
function selectProvider(config, target, selectedId, writing) {
  const matches = config.providers.providers.filter(provider =>
    provider.kind === target.kind && provider.mode !== 'disabled' &&
    (!writing || provider.mode === 'read-write-with-approval') &&
    (provider.transport ?? 'direct-api') === 'direct-api' &&
    ['issues-read', 'comments-read', ...(writing ? ['tracker-update'] : [])].every(cap => provider.capabilities.includes(cap)) &&
    (!provider.projectIds?.length || provider.projectIds.includes(config.project.id)) &&
    (!provider.resourceIds?.length || provider.resourceIds.includes(target.issueKey)) &&
    (selectedId === undefined || selectedId === provider.id));
  if (matches.length !== 1) fail('Configure one scoped direct Jira/Linear provider with issues-read and comments-read. Posting also requires tracker-update and read-write-with-approval. Use --provider when ambiguous.');
  const provider = matches[0];
  const validEndpoint = target.kind === 'jira'
    ? /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(provider.endpoint ?? '') && target.issueUrl === `${provider.endpoint}/browse/${target.issueKey}`
    : provider.endpoint === 'https://api.linear.app';
  if (!validEndpoint) fail('Tracker endpoint must match the recorded Jira Cloud site or the Linear API.');
  return provider;
}
function authHeaders(provider, env) {
  const credentials = provider.credentials ?? {}, keys = Object.keys(credentials);
  const value = name => {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) fail('Configure tracker credential environment references.');
    const text = env[name];
    if (typeof text !== 'string' || !text || text.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(text))
      fail('Configured tracker credentials are missing or invalid.', 'PROVIDER_UNAVAILABLE');
    return text;
  };
  if (provider.kind === 'jira') {
    if (keys.length !== 2 || !keys.includes('usernameEnv') || !keys.includes('apiTokenEnv')) fail('Jira delivery requires usernameEnv and apiTokenEnv.');
    const username = value(credentials.usernameEnv);
    if (username.includes(':')) fail('Jira username is invalid.');
    return {authorization: `Basic ${Buffer.from(`${username}:${value(credentials.apiTokenEnv)}`).toString('base64')}`, accept:'application/json'};
  }
  if (keys.length !== 1 || !['apiTokenEnv','accessTokenEnv','tokenEnv'].includes(keys[0])) fail('Configure one Linear API key or OAuth token reference.');
  const token = value(credentials[keys[0]]);
  return {authorization: keys[0] === 'accessTokenEnv' ? `Bearer ${token}` : token, accept:'application/json'};
}

export async function runTrackerDelivery({action, state, store, config, flags, dependencies, reloadConfig, loadTrackerTarget, confirm}) {
  const writing = action === 'tracker-update';
  if (writing && state.operations.some(op => op.action === 'tracker-update' && op.state === 'succeeded')) return state;
  const pending = state.operations.find(op => ['dispatching','indeterminate'].includes(op.state));
  if (writing && pending) fail('Reconcile the pending delivery operation before posting a tracker update.', 'REPOSITORY_CONFLICT');
  const mergeReceipt = state.operations.find(op => op.action === 'merge' && op.state === 'succeeded')?.receipt;
  if (!mergeReceipt) fail('A tracker delivery summary requires a confirmed merge.', 'REPOSITORY_CONFLICT');
  const deploymentReceipt = state.operations.find(op => op.action === 'deploy' && op.state === 'succeeded')?.receipt ?? null;
  let target, selectedId = flags.provider;
  if (writing) {
    if (typeof loadTrackerTarget !== 'function') fail('The run must contain a recorded Jira or Linear source ticket.');
    try { target = plain(await loadTrackerTarget(state.candidate)); }
    catch { fail('This run has no validated Jira/Linear source ticket. Tracker updates require the recorded source; a replacement ticket cannot be supplied.'); }
  } else {
    if (pending?.action !== 'tracker-update' || state.proposal?.digest !== pending.digest) fail('No pending tracker update was found.', 'REPOSITORY_CONFLICT');
    const p = pending.payload;
    target = plain({kind:p.kind,issueKey:p.issueKey,issueUrl:p.issueUrl,requestDigest:p.requestDigest});
    if (selectedId !== undefined && selectedId !== state.proposal.providerId) fail('Reconciliation requires the originally approved tracker provider.');
    selectedId = state.proposal.providerId;
  }
  const provider = selectProvider(config, target, selectedId, writing);
  if (!writing && pending.payload.endpoint !== provider.endpoint) fail('Restore the originally approved tracker endpoint before reconciliation.');
  const factory = dependencies.delivery?.trackerFactory ?? (await import('../delivery/tracker.js')).createTrackerDelivery;
  const prepared = await factory({repository:state.candidate.repository,target,mergeReceipt,deploymentReceipt,
    providerId:provider.id,baseUrl:provider.endpoint,headers:authHeaders(provider,dependencies.env),
    transport:dependencies.delivery?.transport ?? createNodeProviderTransport(),
    ...(!writing ? {persistedPayload:pending.payload} : {})});
  const service = createDeliveryService({store,executor:prepared.executor,providerId:provider.id,timeoutMs:120000,
    subjectId:'delivery-cli',expectedApproverId:'terminal-human',
    authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:writing?['provider.write']:[],ownedPaths:[],commands:[],
      providers:writing?[{id:provider.id,mode:provider.mode,capabilities:['tracker-update']}]:[]}),
    approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
  if (!writing) return service.reconcile({expectedVersion:state.version});
  state = await service.refresh({expectedVersion:state.version});
  const expiresAt = new Date(Date.now()+5*60*1000).toISOString();
  state = await service.propose({expectedVersion:state.version,action:'tracker-update',payload:prepared.payload,expiresAt});
  dependencies.output.log(`Post delivery summary to ${target.issueUrl}`);
  dependencies.output.log(`${prepared.preview}\n\nRivet delivery operation: ${state.proposal.digest}`);
  if (!(await confirm(state))) fail('Tracker update was not approved. No comment was posted.', 'INVALID_INPUT');
  const freshConfig = await reloadConfig();
  const freshProvider = selectProvider(freshConfig,target,provider.id,true);
  if (hash(freshProvider) !== hash(provider) || hash(await loadTrackerTarget(state.candidate)) !== hash(target))
    fail('Tracker source or provider configuration changed. Review a new proposal.', 'REPOSITORY_CONFLICT');
  const approval = createApprovalReceipt({id:`tracker-${randomUUID()}`,approverId:'terminal-human',approverPrincipal:'human',subjectId:'delivery-cli',
    action:'provider.write',resource:state.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt,singleUse:true});
  return service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval});
}
