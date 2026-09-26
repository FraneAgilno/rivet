import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApprovalReceipt, createApprovalRegistry } from '../policy/approvals.js';
import { createAuthorityEnvelope } from '../policy/authority.js';
import { createDeliveryService } from '../delivery/service.js';
import { createBranchPublicationExecutor, publicationPayload } from '../delivery/branch-publication.js';
import { createGitPublicationTransport, validatePublicationExecutable } from '../delivery/publication-transport.js';
import { runPublicationProcess } from '../delivery/publication-process.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { ensure, hash } from '../delivery/contract.js';
const ENDPOINTS={github:'https://api.github.com',gitlab:'https://gitlab.com/api/v4',bitbucket:'https://api.bitbucket.org/2.0'};
export function publicationProvider(config,repository,flags,writing) {
  const candidates=config.providers.providers.filter(p=>p.kind==='git-ci'&&p.mode!=='disabled'&&(!writing||p.mode==='read-write-with-approval')&&(p.transport??'direct-api')==='direct-api'&&p.endpoint?.replace(/\/$/,'')===ENDPOINTS[repository.provider]&&['repository-read','branch-publish'].every(c=>p.capabilities.includes(c))&&(!p.projectIds?.length||p.projectIds.includes(config.project.id))&&(!p.resourceIds?.length||p.resourceIds.includes(repository.fullName))&&(flags.provider===undefined||flags.provider===p.id));
  ensure(candidates.length===1,'publication-provider-required');return candidates[0];
}
export function publicationToken(provider,kind,environment) {
  const keys=Object.keys(provider.credentials??{});ensure(keys.length===1&&['tokenEnv','accessTokenEnv','apiTokenEnv'].includes(keys[0]),'invalid-credentials');
  if(kind==='bitbucket')ensure(keys[0]==='accessTokenEnv','bitbucket-access-token-required');
  const name=provider.credentials[keys[0]];ensure(typeof name==='string'&&/^[A-Z][A-Z0-9_]{1,127}$/.test(name),'invalid-credentials');
  return environment[name];
}
export async function inspectPublicationSource({project,gitExecutable,repository,runner=runPublicationProcess}) {
  await validatePublicationExecutable(gitExecutable,project);
  const run=async args=>{
    const result=await runner(gitExecutable,args,{cwd:project,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},timeoutMs:3000,maxOutputBytes:32768});
    ensure(result.code===0&&!result.reason,'publication-source-unavailable');return result.stdout.trim();
  };
  const remoteOutput=await run(['remote','-v']);const matching=new Set();const pushes=[];
  for(const line of remoteOutput.split('\n').filter(Boolean)) {
    const match=/^(\S+)\s+(\S+) \((fetch|push)\)$/.exec(line);ensure(match,'invalid-remote');
    if(match[3]==='fetch') {try {if(hash(parseRepositoryRemote(match[2]))===hash(repository))matching.add(match[1]);}catch{}}
    else pushes.push({name:match[1],url:match[2]});
  }
  ensure(matching.size>0,'publication-remote-missing');
  for(const name of matching) {
    const selected=pushes.filter(p=>p.name===name);ensure(selected.length===1,'conflicting-push-url');
    ensure(hash(parseRepositoryRemote(selected[0].url))===hash(repository),'conflicting-push-url');
  }
  const objects=await run(['rev-parse','--git-path','objects']);ensure(objects&&!/[\u0000\r\n]/.test(objects),'unsafe-object-store');
  const sourceObjects=resolve(project,objects);ensure(await realpath(sourceObjects)===sourceObjects,'unsafe-object-store');
  return {sourceObjects,remoteDigest:hash(pushes.filter(p=>matching.has(p.name)).sort((a,b)=>a.name.localeCompare(b.name)))};
}
async function publicationDelivery({action,store,config,flags,dependencies,validateLocal,reloadConfig,publicationContext,confirm}) {
  let state=await store.read();const writing=action==='publish';
  const provider=structuredClone(publicationProvider(config,state.candidate.repository,flags,writing));
  const projectDigest=hash(config.project);
  const source=await inspectPublicationSource({...publicationContext,repository:state.candidate.repository,runner:dependencies.delivery?.publicationSourceRunner});
  const factory=dependencies.delivery?.publicationTransportFactory??createGitPublicationTransport;
  const token=publicationToken(provider,state.candidate.repository.provider,dependencies.env);
  const transport=await factory({...publicationContext,repository:state.candidate.repository,sourceObjects:source.sourceObjects,token, signal: dependencies.publicationSignal});
  const executor=createBranchPublicationExecutor({repository:state.candidate.repository,transport});
  const service=createDeliveryService({store,executor,timeoutMs:120000,providerId:provider.id,subjectId:'delivery-cli',expectedApproverId:'terminal-human',approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]}),authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:writing?['provider.write']:[],ownedPaths:[],commands:[],providers:writing?[{id:provider.id,mode:provider.mode,capabilities:['branch-publish']}]:[]})});
  if(action==='reconcile')return service.reconcile({expectedVersion:state.version});
  await validateLocal(state.candidate);
  state=await service.refresh({expectedVersion:state.version});
  const publication=state.observation.publication;
  if(publication.remoteSha===state.candidate.headSha) {dependencies.output.log('The exact verified commit is already available at the destination branch. No publication was dispatched.');return state;}
  ensure(publication.remoteSha===null,'branch-exists');
  const expiresAt=new Date(Date.now()+300000).toISOString();
  state=await service.propose({expectedVersion:state.version,action:'branch-publish',payload:publicationPayload(state.candidate),expiresAt});
  dependencies.output.log(`Publish ${state.candidate.headSha} to ${publication.destinationUrl}`);
  dependencies.output.log(`Create only: ${publication.ref}. An existing branch will never be overwritten. This uploads the commit and its reachable history; it does not create or merge a review.`);
  ensure(await confirm(state),'approval-required');
  const currentConfig=await reloadConfig();const currentProvider=publicationProvider(currentConfig,state.candidate.repository,flags,true);
  ensure(hash(currentProvider)===hash(provider)&&hash(currentConfig.project)===projectDigest,'changed-configuration');
  ensure(publicationToken(currentProvider,state.candidate.repository.provider,dependencies.env)===token,'changed-credentials');
  await validateLocal(state.candidate);
  const currentSource=await inspectPublicationSource({...publicationContext,repository:state.candidate.repository,runner:dependencies.delivery?.publicationSourceRunner});
  ensure(hash(currentSource)===hash(source),'changed-publication-source');
  const approval=createApprovalReceipt({id:`publish-${randomUUID()}`,approverId:'terminal-human',approverPrincipal:'human',subjectId:'delivery-cli',action:'provider.write',resource:state.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt,singleUse:true});
  return service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval});
}

export async function runPublicationDelivery(input) {
  const controller=new AbortController();const abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try {return await publicationDelivery({...input,dependencies:{...input.dependencies,publicationSignal:controller.signal}});}
  finally {process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
