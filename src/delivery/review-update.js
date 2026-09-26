import { captureRecord, createProviderWireBody } from '../adapters/contract.js';
import { createProviderHttpClient } from '../adapters/http.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { digest, ensure, exact, factsDigest, hash, plain, sha, timestamp, validateCandidate } from './contract.js';

const ENDPOINTS={github:'https://api.github.com',gitlab:'https://gitlab.com/api/v4',bitbucket:'https://api.bitbucket.org/2.0'};
const UUID=/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i;
export function reviewUpdateContent(input, provider) {
 const value=plain(input);exact(value,['title','body']);
 ensure(typeof value.title==='string'&&value.title.trim()===value.title&&value.title.length>0&&Buffer.byteLength(value.title)<=256&&!/[\u0000-\u001f\u007f]/.test(value.title));
 ensure(typeof value.body==='string'&&Buffer.byteLength(value.body)<=32000&&!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.body));
 // GitLab interprets these title prefixes and standalone slash commands as
 // mutations when metadata is saved. Precheck them before any write; readback
 // cannot undo a draft/closure/reviewer change caused by executable text.
 if (provider === 'gitlab') {
  ensure(!/^(?:(?:draft|wip):|\[(?:draft|wip)\]|\((?:draft|wip)\))/i.test(value.title),'unsupported-action');
  ensure(!/^[ \t]*\/[a-z][a-z0-9_]*(?=[ \t]|$)/im.test(value.body),'unsupported-action');
 }
 return value;
}
function markers(body){return body.match(/<!-- rivet-review-operation:[a-f0-9]{64} -->/g)??[];}
/** Desired-state confirmation, not an atomic metadata compare-and-swap. */
export function createReviewUpdateExecutor(inputConfig){
 const input=captureRecord(inputConfig,new Set(['repository','reviewNumber','transport','headers','clock','timeoutMs']),['repository','reviewNumber','transport'],'invalid-config');
 const repository=parseRepositoryRemote(input.repository.url);ensure(hash(repository)===hash(plain(input.repository)));
 const kind=repository.provider,github=kind==='github',bitbucket=kind==='bitbucket';
 ensure(Number.isSafeInteger(input.reviewNumber)&&input.reviewNumber>0&&input.reviewNumber<=1_000_000_000);
 const selected=input.reviewNumber,clock=input.clock??(()=>new Date().toISOString());ensure(typeof clock==='function');
 const root=github?`/repos/${repository.fullName}`:bitbucket?`/repositories/${repository.fullName}`:`/projects/${encodeURIComponent(repository.fullName)}`;
 const path=`${root}/${github?'pulls':bitbucket?'pullrequests':'merge_requests'}/${selected}`;
 const reviewUrl=`${repository.url}/${github?'pull':bitbucket?'pull-requests':'-/merge_requests'}/${selected}`;
 const http=createProviderHttpClient({provider:kind,baseUrl:ENDPOINTS[kind],transport:input.transport,allowEncodedSlash:true,...(input.headers===undefined?{}:{headers:input.headers}),...(input.timeoutMs===undefined?{}:{timeoutMs:input.timeoutMs})});
 const get=async path=>(await http.request({method:'GET',path})).data;
 function target(value){validateCandidate(value);ensure(hash(value.repository)===hash(repository)&&(value.reviewNumber===null||value.reviewNumber===selected),'changed-facts');}
 function identity(value){
  if(bitbucket){ensure(typeof value?.uuid==='string'&&UUID.test(value.uuid)&&value.full_name===repository.fullName&&value.links?.html?.href===repository.url&&typeof value.workspace?.uuid==='string'&&UUID.test(value.workspace.uuid)&&value.workspace.slug===repository.namespace,'changed-facts');return {id:value.uuid,workspace:value.workspace.uuid};}
  ensure(Number.isSafeInteger(value?.id)&&value.id>0&&(github?value.full_name:value.path_with_namespace)===repository.fullName&&(github?value.html_url:value.web_url)===repository.url&&value.archived===false,'changed-facts');return {id:value.id};
 }
 async function branches(candidate){
  const project=identity(await get(root));
  const branch=async name=>{const raw=await get(`${root}${github?'':bitbucket?'/refs':'/repository'}/branches/${encodeURIComponent(name)}`);ensure(raw?.name===name,'changed-facts');return sha(bitbucket?raw.target?.hash:github?raw.commit?.sha:raw.commit?.id);};
  const headSha=await branch(candidate.sourceBranch),baseSha=await branch(candidate.targetBranch);ensure(headSha===candidate.headSha,'changed-facts');return {project,headSha,baseSha};
 }
 function normalize(raw,candidate,before){
  ensure((github?raw.number:bitbucket?raw.id:raw.iid)===selected&&raw.draft===false&&(github?raw.state==='open'&&raw.merged===false:raw.state===(bitbucket?'OPEN':'opened')),'changed-facts');
  ensure((github?raw.html_url:bitbucket?raw.links?.html?.href:raw.web_url)===reviewUrl,'changed-facts');
  if(github){for(const [side,ref,commit] of [['head',candidate.sourceBranch,candidate.headSha],['base',candidate.targetBranch,before.baseSha]])ensure(raw[side]?.repo?.id===before.project.id&&raw[side].repo.full_name===repository.fullName&&raw[side].ref===ref&&raw[side].sha===commit,'changed-facts');}
  else if(bitbucket){for(const [side,ref,commit] of [['source',candidate.sourceBranch,candidate.headSha],['destination',candidate.targetBranch,before.baseSha]]){const part=raw[side],repo=part?.repository;ensure(repo?.uuid===before.project.id&&repo.full_name===repository.fullName&&repo.links?.html?.href===repository.url&&part.branch?.name===ref&&part.commit?.hash===commit,'changed-facts');if(repo.workspace!==undefined)ensure(repo.workspace.uuid===before.project.workspace&&repo.workspace.slug===repository.namespace,'changed-facts');}}
  else ensure(raw.project_id===before.project.id&&raw.source_project_id===before.project.id&&raw.target_project_id===before.project.id&&raw.source_branch===candidate.sourceBranch&&raw.target_branch===candidate.targetBranch&&raw.sha===candidate.headSha,'changed-facts');
  const bodies=bitbucket?[raw.description,raw.summary?.raw,raw.rendered?.description?.raw].filter(x=>x!==undefined):[github?raw.body:raw.description];
  ensure(bodies.length>0&&bodies.every(x=>x===bodies[0]),'invalid-provider-evidence');
  const content=reviewUpdateContent({title:raw.title,body:bodies[0]??''});
  return {number:selected,url:reviewUrl,state:'open',draft:false,...content};
 }
 async function snapshot(candidate){target(candidate);const before=await branches(candidate),review=normalize(await get(path),candidate,before);ensure(hash(await branches(candidate))===hash(before),'changed-facts');return plain({...before,review});}
 function facts(candidate,current){const unknown={headSha:candidate.headSha,policy:'unknown',satisfied:null,evidenceDigest:hash(current)};return plain({repositoryUrl:repository.url,sourceBranch:candidate.sourceBranch,targetBranch:candidate.targetBranch,headSha:candidate.headSha,baseSha:current.baseSha,review:{number:selected,state:'open',url:reviewUrl,headSha:candidate.headSha},checks:unknown,reviews:unknown,observedAt:timestamp(clock())});}
 async function observe(candidate){return facts(candidate,await snapshot(candidate));}
 async function prepare(candidate,desired){let content=reviewUpdateContent(desired,kind);const before=await snapshot(candidate),existing=markers(before.review.body);if(!markers(content.body).length&&existing.length)content=reviewUpdateContent({...content,body:content.body+'\n\n'+existing.join('\n')},kind);ensure(hash(markers(content.body))===hash(existing),'changed-facts');return plain({assurance:'precheck-readback',before,desired:content});}
 function operation(value){const op=plain(value);target(op.candidate);digest(op.digest);digest(op.factsDigest);ensure(op.action==='review-update','unsupported-action');exact(op.payload,['assurance','before','desired']);ensure(op.payload.assurance==='precheck-readback');exact(op.payload.before,['project','headSha','baseSha','review']);ensure(op.payload.before.headSha===op.candidate.headSha);sha(op.payload.before.baseSha);const review=op.payload.before.review;exact(review,['number','url','state','draft','title','body']);ensure(review.number===selected&&review.url===reviewUrl&&review.state==='open'&&review.draft===false);reviewUpdateContent({title:review.title,body:review.body});reviewUpdateContent(op.payload.desired,kind);ensure(hash(markers(review.body))===hash(markers(op.payload.desired.body)),'changed-facts');ensure(factsDigest(facts(op.candidate,op.payload.before))===op.factsDigest,'changed-facts');return op;}
 function verified(current,op){const expected={...op.payload.before,review:{...op.payload.before.review,...op.payload.desired}};ensure(hash(current)===hash(expected),'unverified-effect');return current;}
 function receipt(op,current){return plain({status:'succeeded',operationDigest:op.digest,headSha:op.candidate.headSha,evidenceDigest:hash({assurance:'precheck-readback',current}),resourceUrl:reviewUrl,commitSha:null});}
 async function dispatch(value,context){const op=operation(value);exact(plain(context),['deadline']);const deadline=Date.parse(timestamp(context.deadline));const timely=()=>ensure(Date.parse(timestamp(clock()))<deadline,'dispatch-expired');timely();const before=await snapshot(op.candidate);ensure(hash(before)===hash(op.payload.before),'changed-facts');
  const payload=github?op.payload.desired:{title:op.payload.desired.title,description:op.payload.desired.body};
  const wireBody=createProviderWireBody({provider:kind,action:'review-update',resourceId:`${repository.fullName}#${selected}`,expectedState:'open',expectedVersion:op.candidate.headSha,idempotencyKey:op.digest,payload});
  timely();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadline-Date.parse(timestamp(clock())));let response;
  try{response=await http.request({method:github?'PATCH':'PUT',path,wireBody,signal:controller.signal});}finally{clearTimeout(timer);}
  ensure(response.status===200,'unverified-effect');normalize(response.data,op.candidate,before);const current=verified(await snapshot(op.candidate),op);return receipt(op,current);
 }
 async function reconcile(value){try{const op=operation(value),current=verified(await snapshot(op.candidate),op);return {status:'succeeded',receipt:receipt(op,current)};}catch{return {status:'unknown'};}}
 const executor=createTrustedDeliveryExecutor({provider:kind,capabilities:[{action:'review-update',conditionalHead:false,verifiesDesiredState:true,reconcile:true}],observe,dispatch,reconcile});
 // Preserve the trusted executor identity while exposing a separate read-only preview builder.
 return Object.freeze({executor,prepare,observe:executor.observe,dispatch:executor.dispatch,reconcile:executor.reconcile,capabilities:executor.capabilities});
}
