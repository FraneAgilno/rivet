import { randomUUID } from 'node:crypto';
import { CliError } from '../cli/output.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createDeliveryService } from '../delivery/service.js';
import { hash, plain } from '../delivery/contract.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { selectProvider, authHeaders } from './delivery-tracker.js';

function fail(message, code = 'REPOSITORY_CONFLICT') { throw new CliError(message, code); }
async function select(dependencies, choices) {
  let timer;
  try {
    const index = await Promise.race([
      Promise.resolve().then(() => dependencies.selectTrackerDestination(choices)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); }),
    ]);
    return Number.isInteger(index) && index >= 0 && index < choices.length ? choices[index] : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function runTrackerTransition({action,state,store,config,flags,dependencies,reloadConfig,loadTrackerTarget,confirm}) {
  const writing = action === 'tracker-transition', reconciling = action === 'reconcile';
  if (writing && state.operations.some(op => op.action === action && op.state === 'succeeded')) return state;
  const pending = state.operations.find(op => ['dispatching','indeterminate'].includes(op.state));
  if (writing && pending) fail('Reconcile the pending delivery operation before changing tracker status.');
  const mergeReceipt = state.operations.find(op => op.action === 'merge' && op.state === 'succeeded')?.receipt;
  if (!mergeReceipt) fail('Tracker status delivery requires a confirmed merge.');
  let target, selectedId = flags.provider;
  if (reconciling) {
    if (pending?.action !== 'tracker-transition' || state.proposal?.digest !== pending.digest) fail('No pending tracker transition was found.');
    const p = pending.payload;
    target = plain({kind:p.kind,issueKey:p.issueKey,issueUrl:p.issueUrl,requestDigest:p.requestDigest});
    if (selectedId !== undefined && selectedId !== state.proposal.providerId) fail('Reconciliation requires the originally approved tracker provider.');
    selectedId = state.proposal.providerId;
  } else {
    try { target = plain(await loadTrackerTarget(state.candidate)); }
    catch { fail('This run has no validated Jira/Linear source ticket. A replacement ticket cannot be supplied.','MISSING_CONFIGURATION'); }
  }
  const provider = selectProvider(config,target,selectedId,writing,'tracker-transition');
  if (reconciling && provider.endpoint !== pending.payload.endpoint) fail('Restore the originally approved tracker endpoint before reconciliation.');
  const intake = await (dependencies.delivery?.transitionFactory ?? (await import('../delivery/tracker-transition.js')).createTrackerTransition)({
    repository:state.candidate.repository,target,mergeReceipt,providerId:provider.id,baseUrl:provider.endpoint,
    headers:authHeaders(provider,dependencies.env),transport:dependencies.delivery?.transport ?? createNodeProviderTransport(),
    ...(reconciling ? {persistedPayload:pending.payload} : {}),
  });
  if (action === 'tracker-status') return {...state,trackerStatus:intake.status};
  let prepared = intake;
  if (writing) {
    dependencies.output.log(`Tracker: ${target.issueUrl}\nCurrent status: ${intake.status.current.name}`);
    const choices = intake.status.destinations.filter(choice => choice.eligible);
    const labels = choices.map(choice => `${choice.state.name} (${choice.name}; ${choice.state.type})`);
    if (new Set(labels).size !== labels.length) fail('Some tracker destinations have indistinguishable names. Review these transitions in the tracker before continuing.');
    for (const [index,choice] of choices.entries()) dependencies.output.log(`${index+1}. ${choice.state.name} (${choice.name}; ${choice.state.type})`);
    for (const choice of intake.status.destinations.filter(choice => !choice.eligible)) dependencies.output.log(`Unavailable: ${choice.state.name} (${choice.name}): requires fields or a transition screen.`);
    if (!choices.length) fail('No supported tracker destinations are available. Complete required fields or transition screens in the tracker.');
    const selected = await select(dependencies,choices);
    if (!selected) fail('No destination selected. Tracker status was not changed.','INVALID_INPUT');
    prepared = await intake.select(selected.id);
    if (prepared.alreadyDesired) return {...state,trackerStatus:intake.status,trackerTransitionNoop:true};
  }
  const service = createDeliveryService({store,executor:prepared.executor,providerId:provider.id,timeoutMs:120000,
    subjectId:'delivery-cli',expectedApproverId:'terminal-human',
    authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:writing?['provider.write']:[],ownedPaths:[],commands:[],
      providers:writing?[{id:provider.id,mode:provider.mode,capabilities:['tracker-transition']}]:[]}),
    approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
  if (reconciling) return service.reconcile({expectedVersion:state.version});
  state = await service.refresh({expectedVersion:state.version});
  const expiresAt = new Date(Date.now()+5*60*1000).toISOString();
  state = await service.propose({expectedVersion:state.version,action:'tracker-transition',payload:prepared.payload,expiresAt});
  dependencies.output.log(`${prepared.preview}\nConfirmed merge: ${mergeReceipt.commitSha}\nRivet delivery operation: ${state.proposal.digest}`);
  dependencies.output.log('Assurance: precheck and readback; the tracker provides no atomic revision condition. Confirmation observes the desired state and cannot prove that this operation alone caused it.');
  if (!(await confirm(state))) fail('Tracker transition was not approved. No status change was sent.','INVALID_INPUT');
  const freshProvider = selectProvider(await reloadConfig(),target,provider.id,true,'tracker-transition');
  if (hash(freshProvider) !== hash(provider) || hash(await loadTrackerTarget(state.candidate)) !== hash(target)) fail('Tracker source or provider configuration changed. Review a new proposal.');
  const approval = createApprovalReceipt({id:`tracker-transition-${randomUUID()}`,approverId:'terminal-human',approverPrincipal:'human',subjectId:'delivery-cli',
    action:'provider.write',resource:state.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt,singleUse:true});
  return service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval});
}
