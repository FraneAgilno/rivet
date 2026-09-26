import { captureRecord, createProviderWireBody } from '../adapters/contract.js';
import { createProviderHttpClient } from '../adapters/http.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { reviewRequestContent } from './review-request.js';
import { digest, ensure, exact, factsDigest, hash, plain, sha, timestamp, validateCandidate } from './contract.js';

const API='https://api.bitbucket.org/2.0';
const STATES=['OPEN','MERGED','DECLINED','SUPERSEDED'];
const UUID=/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i;
// Bitbucket accepts refs rather than an expected commit condition. Creation is
// confirmed only after exact readback and stable repository/branch observations.
export function createBitbucketReviewExecutor(inputConfig) {
  const input=captureRecord(inputConfig,new Set(['repository','transport','headers','clock','timeoutMs']),['repository','transport'],'invalid-config');
  const supplied=plain(input.repository),repository=parseRepositoryRemote(supplied.url);
  ensure(repository.provider==='bitbucket'&&hash(repository)===hash(supplied));
  const clock=input.clock??(()=>new Date().toISOString());ensure(typeof clock==='function');
  const http=createProviderHttpClient({provider:'bitbucket',baseUrl:API,transport:input.transport,allowEncodedSlash:true,
    ...(input.headers===undefined?{}:{headers:input.headers}),...(input.timeoutMs===undefined?{}:{timeoutMs:input.timeoutMs})});
  const root=`/repositories/${repository.fullName}`,listPath=root+'/pullrequests';
  const get=async path=>(await http.request({method:'GET',path:root+path})).data;
  function number(value){ensure(Number.isSafeInteger(value)&&value>0,'invalid-provider-evidence');return value;}
  function target(value){validateCandidate(value);ensure(hash(value.repository)===hash(repository),'provider-mismatch');}
  function identity(value,embedded=false){
    ensure(typeof value?.uuid==='string'&&UUID.test(value.uuid)&&value.full_name===repository.fullName&&value.links?.html?.href===repository.url,'changed-facts');
    let workspace=null;
    if(!embedded||value.workspace!==undefined){ensure(typeof value.workspace?.uuid==='string'&&UUID.test(value.workspace.uuid)&&value.workspace.slug===repository.namespace,'changed-facts');workspace={uuid:value.workspace.uuid,slug:value.workspace.slug};}
    return {uuid:value.uuid,fullName:repository.fullName,url:repository.url,workspace};
  }
  async function branches(candidate){
    const project=identity(await get(''));
    const branch=async name=>{
      let result;try{result=await get(`/refs/branches/${encodeURIComponent(name)}`);}catch(error){
        if(error?.status===404){const failure=new Error('Publish the verified source branch and ensure the target branch exists before requesting review.');failure.code='ERR_DELIVERY_BRANCH_NOT_PUBLISHED';failure.safeMessage=failure.message;throw failure;}throw error;
      }
      ensure(result?.name===name,'changed-facts');return sha(result.target?.hash);
    };
    const headSha=await branch(candidate.sourceBranch),baseSha=await branch(candidate.targetBranch);
    ensure(headSha===candidate.headSha,'changed-facts');return {project,headSha,baseSha};
  }
  function rawBody(value){
    const fields=[value.description,value.summary?.raw,value.rendered?.description?.raw].filter(field=>field!==undefined);
    ensure(fields.length>0&&fields.every(field=>typeof field==='string'&&field===fields[0]),'invalid-provider-evidence');
    return fields[0];
  }
  function review(value,candidate,before){
    const id=number(value?.id);
    ensure(STATES.includes(value.state)&&typeof value.draft==='boolean'&&value.links?.html?.href===`${repository.url}/pull-requests/${id}`,'changed-facts');
    for(const [side,name,commit] of [['source',candidate.sourceBranch,candidate.headSha],['destination',candidate.targetBranch,before.baseSha]]){
      const part=value[side],repo=identity(part?.repository,true);
      ensure(repo.uuid===before.project.uuid&&(repo.workspace===null||hash(repo.workspace)===hash(before.project.workspace))
        &&part.branch?.name===name&&part.commit?.hash===commit,'changed-facts');
    }
    ensure(typeof value.title==='string','changed-facts');const body=rawBody(value);
    return plain({number:id,state:value.state==='OPEN'?'open':value.state==='MERGED'?'merged':'closed',draft:value.draft,url:value.links.html.href,
      headSha:candidate.headSha,baseSha:before.baseSha,title:value.title,body});
  }
  // JSON next links are API input: pin all selectors and reject hidden partial
  // responses. Bounds and duplicate IDs apply across all four state queries.
  async function listed(candidate){
    const result=[],ids=new Set(),visited=new Set();let pages=0;
    const q=`source.branch.name=${JSON.stringify(candidate.sourceBranch)} AND destination.branch.name=${JSON.stringify(candidate.targetBranch)}`;
    for(const state of STATES){
      let declaredSize=null,received=0;
      let next=new URL(API+listPath);next.search=new URLSearchParams({q,state,pagelen:'100'}).toString();
      while(next){
        ensure(++pages<=20&&next.origin==='https://api.bitbucket.org'&&next.pathname==='/2.0'+listPath&&!next.username&&!next.password&&!next.hash,'invalid-pagination');
        const params=next.searchParams,keys=[...params.keys()];
        ensure(new Set(keys).size===keys.length&&keys.every(key=>['q','state','pagelen','page'].includes(key))
          &&params.get('q')===q&&params.get('state')===state&&params.get('pagelen')==='100'
          &&(!params.has('page')||/^[1-9][0-9]{0,5}$/.test(params.get('page'))),'invalid-pagination');
        const canonical=new URL(next);canonical.searchParams.sort();ensure(!visited.has(canonical.href),'invalid-pagination');visited.add(canonical.href);
        const requestedPage=Number(params.get('page')??'1');
        const page=(await http.request({method:'GET',path:next.pathname.slice('/2.0'.length)+next.search})).data;
        ensure(Array.isArray(page?.values)&&page.values.length<=100,'invalid-pagination');
        if(page.page!==undefined)ensure(page.page===requestedPage,'invalid-pagination');
        if(page.pagelen!==undefined)ensure(page.pagelen===100,'invalid-pagination');
        if(page.size!==undefined){ensure(Number.isSafeInteger(page.size)&&page.size>=0&&page.size<=1000&&(declaredSize===null||declaredSize===page.size),'invalid-pagination');declaredSize=page.size;}
        received+=page.values.length;ensure(declaredSize===null||received<=declaredSize,'invalid-pagination');
        for(const row of page.values){const id=number(row?.id);ensure(!ids.has(id)&&row.state===state,'invalid-pagination');ids.add(id);result.push(row);ensure(result.length<=1000,'invalid-pagination');}
        if(page.next===undefined||page.next===null){ensure(declaredSize===null||received===declaredSize,'invalid-pagination');break;}
        ensure(page.values.length>0&&typeof page.next==='string'&&page.next.length<=8192,'invalid-pagination');
        try{next=new URL(page.next);}catch{ensure(false,'invalid-pagination');}
        ensure(next.searchParams.get('page')===String(requestedPage+1),'invalid-pagination');
      }
    }
    return result;
  }
  function facts(candidate,before,existing){
    const unknown={headSha:candidate.headSha,policy:'unknown',satisfied:null,evidenceDigest:hash({before,existing})};
    return plain({repositoryUrl:repository.url,sourceBranch:candidate.sourceBranch,targetBranch:candidate.targetBranch,headSha:candidate.headSha,baseSha:before.baseSha,
      review:existing?{number:existing.number,state:existing.state,url:existing.url,headSha:candidate.headSha}:null,checks:unknown,reviews:unknown,observedAt:timestamp(clock())});
  }
  async function observe(candidate){
    target(candidate);const before=await branches(candidate),rows=await listed(candidate);ensure(rows.length<=1,'ambiguous-review');let existing=null;
    if(rows.length){const selected=number(rows[0].id);existing=review(await get(`/pullrequests/${selected}`),candidate,before);ensure(existing.number===selected&&(candidate.reviewNumber===null||candidate.reviewNumber===selected),'changed-facts');}
    else ensure(candidate.reviewNumber===null,'changed-facts');
    ensure(hash(await branches(candidate))===hash(before),'changed-facts');return facts(candidate,before,existing);
  }
  function operation(value){const op=plain(value);target(op.candidate);digest(op.digest);digest(op.factsDigest);ensure(op.action==='review-request'&&op.candidate.reviewNumber===null,'unsupported-action');reviewRequestContent(op);return op;}
  function verified(value,op,before){const result=review(value,op.candidate,before),content=reviewRequestContent(op);ensure(!result.draft&&value.close_source_branch===false&&result.title===content.title&&result.body===content.body,'unverified-effect');return result;}
  function receipt(op,result){return plain({status:'succeeded',operationDigest:op.digest,headSha:op.candidate.headSha,evidenceDigest:hash(result),resourceUrl:result.url,commitSha:null});}
  async function marked(op,before){
    const marker=`<!-- rivet-review-operation:${op.digest} -->`,rows=await listed(op.candidate);
    const matches=rows.filter(row=>rawBody(row).includes(marker));ensure(matches.length===1,'ambiguous-review');
    const selected=number(matches[0].id),result=verified(await get(`/pullrequests/${selected}`),op,before);ensure(result.number===selected,'changed-facts');return result;
  }
  async function dispatch(value,context){
    const op=operation(value),limits=plain(context);exact(limits,['deadline']);const deadline=Date.parse(timestamp(limits.deadline));
    const timely=()=>ensure(Date.parse(timestamp(clock()))<deadline,'dispatch-expired');timely();
    const observed=await observe(op.candidate);ensure(observed.review===null&&factsDigest(observed)===op.factsDigest,'changed-facts');
    const content=reviewRequestContent(op),wireBody=createProviderWireBody({provider:'bitbucket',action:'review-request',resourceId:repository.fullName,expectedState:'absent',expectedVersion:op.candidate.headSha,idempotencyKey:op.digest,
      payload:{title:content.title,description:content.body,source:{branch:{name:op.candidate.sourceBranch}},destination:{branch:{name:op.candidate.targetBranch}},draft:false,close_source_branch:false}});
    timely();const controller=new AbortController(),remaining=deadline-Date.parse(timestamp(clock()));ensure(remaining>0,'dispatch-expired');const timer=setTimeout(()=>controller.abort(),remaining);
    let response;try{response=await http.request({method:'POST',path:listPath,wireBody,signal:controller.signal});}finally{clearTimeout(timer);}
    ensure(response.status===201,'unverified-effect');const after=await branches(op.candidate);
    ensure(hash({before:after,existing:null})===observed.checks.evidenceDigest,'changed-facts');
    const sent=verified(response.data,op,after);ensure(sent.state==='open','unverified-effect');
    const result=await marked(op,after);ensure(hash(sent)===hash(result)&&hash(await branches(op.candidate))===hash(after),'changed-facts');return receipt(op,result);
  }
  async function reconcile(value){try{const op=operation(value),before=await branches(op.candidate);ensure(factsDigest(facts(op.candidate,before,null))===op.factsDigest,'changed-facts');const result=await marked(op,before);ensure(hash(await branches(op.candidate))===hash(before),'changed-facts');return {status:'succeeded',receipt:receipt(op,result)};}catch{return {status:'unknown'};}}
  return createTrustedDeliveryExecutor({provider:'bitbucket',capabilities:[{action:'review-request',conditionalHead:false,verifiesCreatedReview:true,reconcile:true}],observe,dispatch,reconcile});
}
