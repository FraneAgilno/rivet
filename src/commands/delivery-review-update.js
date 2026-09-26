import { randomUUID } from 'node:crypto';
import { CliError } from '../cli/output.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createDeliveryService } from '../delivery/service.js';
import { createReviewUpdateExecutor, reviewUpdateContent } from '../delivery/review-update.js';
import { hash } from '../delivery/contract.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { providerFor, headers } from './delivery-remote.js';
function fail(message,code='REPOSITORY_CONFLICT'){throw new CliError(message,code);}
export async function runReviewUpdate({action,state,store,config,flags,dependencies,reloadConfig,validateLocal,confirm}){
 const writing=action==='review-update',pending=state.operations.find(op=>['dispatching','indeterminate'].includes(op.state));
 if(writing&&pending)fail('Reconcile the pending delivery operation before updating review metadata.');
 if(state.operations.some(op=>op.action==='merge'&&op.state==='succeeded'))fail('Review metadata updates require an open unmerged candidate.');
 let desired;if(writing){try{desired=reviewUpdateContent({title:flags.title,body:flags.body},state.candidate.repository.provider);}catch{fail('Review update requires an exact --title and --body. Only bounded title/body text can be changed.','INVALID_INPUT');}}
 let number=state.candidate.reviewNumber??state.observation?.review?.number;
 if(!number){const receipt=state.operations.find(op=>op.action==='review-request'&&op.state==='succeeded')?.receipt;const prefix=`${state.candidate.repository.url}/${{github:'pull',gitlab:'-/merge_requests',bitbucket:'pull-requests'}[state.candidate.repository.provider]}/`;if(receipt?.resourceUrl?.startsWith(prefix))number=Number(receipt.resourceUrl.slice(prefix.length));}
 let selectedId=flags.provider;
 if(!writing){if(pending?.action!=='review-update'||state.proposal?.digest!==pending.digest)fail('No pending review metadata update was found.');number=pending.payload.before.review.number;if(selectedId!==undefined&&selectedId!==state.proposal.providerId)fail('Reconciliation requires the originally approved provider.');selectedId=state.proposal.providerId;}
 if(!Number.isSafeInteger(number)||number<=0)fail('Prepare or create the exact review request before updating it.');
 const provider=providerFor(config,state.candidate.repository,{...flags,provider:selectedId},writing,'review-update');
 const prepared=(dependencies.delivery?.reviewUpdateFactory??createReviewUpdateExecutor)({repository:state.candidate.repository,reviewNumber:number,headers:headers(provider,dependencies.env,state.candidate.repository.provider),transport:dependencies.delivery?.transport??createNodeProviderTransport()});
 const service=createDeliveryService({store,executor:prepared.executor,providerId:provider.id,timeoutMs:120000,subjectId:'delivery-cli',expectedApproverId:'terminal-human',authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:writing?['provider.write']:[],ownedPaths:[],commands:[],providers:writing?[{id:provider.id,mode:provider.mode,capabilities:['review-update']}]:[]}),approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
 if(!writing)return service.reconcile({expectedVersion:state.version});
 await validateLocal(state.candidate);
 const payload=await prepared.prepare(state.candidate,desired);
 if(hash(payload.desired)===hash({title:payload.before.review.title,body:payload.before.review.body}))return {...state,reviewUpdateNoop:true};
 state=await service.refresh({expectedVersion:state.version});
 const expiresAt=new Date(Date.now()+5*60*1000).toISOString();state=await service.propose({expectedVersion:state.version,action:'review-update',payload,expiresAt});
 dependencies.output.log(`Update review: ${payload.before.review.url}\n${state.candidate.sourceBranch} (${state.candidate.headSha}) -> ${state.candidate.targetBranch} (${payload.before.baseSha})`);
 dependencies.output.log(`Previous title: ${payload.before.review.title}\nPrevious body:\n${payload.before.review.body}\nNew title: ${payload.desired.title}\nNew body:\n${payload.desired.body}`);
 dependencies.output.log('Assurance: precheck and readback, without atomic metadata or commit conditions. Concurrent edits may be overwritten. Confirmation observes the desired state and does not prove exclusive causation.');
 if(!(await confirm(state)))fail('Review metadata update was not approved. No write was sent.','INVALID_INPUT');
 const currentConfig=await reloadConfig(),currentProvider=providerFor(currentConfig,state.candidate.repository,{provider:provider.id},true,'review-update');
 if(hash(currentProvider)!==hash(provider)||hash(currentConfig.project)!==hash(config.project))fail('Review configuration changed. Review a new proposal.');
 await validateLocal(state.candidate);
 const approval=createApprovalReceipt({id:`review-update-${randomUUID()}`,approverId:'terminal-human',approverPrincipal:'human',subjectId:'delivery-cli',action:'provider.write',resource:state.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt,singleUse:true});
 return service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval});
}
