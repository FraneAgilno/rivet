import { createProviderHttpClient } from '../adapters/http.js';
import { captureRecord, createProviderReadBody, createProviderWireBody } from '../adapters/contract.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { createTrustedDeliveryExecutor } from './service.js';
import { digest, ensure, exact, factsDigest, hash, id, plain, sha, timestamp, validateCandidate, validateReceipt } from './contract.js';
const KEY = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^[1-9][0-9]{0,19}$/;
const ISSUE_QUERY = 'query RivetDeliveryIssue($id: String!) { issue(id: $id) { id identifier url updatedAt team { id key } } }';
const COMMENTS_QUERY = 'query RivetDeliveryComments($id: String!, $cursor: String) { issue(id: $id) { id comments(first: 100, after: $cursor) { nodes { id body } pageInfo { hasNextPage endCursor } } } }';
function safeUrl(value) {
  ensure(typeof value === 'string' && value.length <= 2048 && !/[\s<>`\[\]()]/.test(value));
  let url;
  try { url = new URL(value); } catch { ensure(false); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value);
  return url;
}
function revision(value) {
  ensure(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)), 'invalid-provider-evidence');
  return value;
}
function document(body) {
  return { type: 'doc', version: 1, content: body.split('\n').filter(Boolean).map(text => ({type:'paragraph',content:[{type:'text',text}]})) };
}

export async function createTrackerDelivery(inputConfig) {
  ensure(inputConfig && typeof inputConfig === 'object' && !Array.isArray(inputConfig));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(inputConfig))) ensure(Object.hasOwn(descriptor, 'value'));
  const input = captureRecord(inputConfig,
    new Set(['repository','target','mergeReceipt','deploymentReceipt','providerId','baseUrl','headers','transport','clock','timeoutMs','persistedPayload']),
    ['repository','target','mergeReceipt','deploymentReceipt','providerId','baseUrl','transport'], 'invalid-config');
  const supplied = plain(input.repository), repository = parseRepositoryRemote(supplied.url);
  ensure(hash(repository) === hash(supplied));
  const target = plain(input.target);
  exact(target,['kind','issueKey','issueUrl','requestDigest']);
  ensure(['jira','linear'].includes(target.kind) && typeof target.issueKey === 'string' && KEY.test(target.issueKey));
  digest(target.requestDigest); id(input.providerId);
  ensure(typeof input.baseUrl === 'string');
  const issueUrl = safeUrl(target.issueUrl), endpoint = safeUrl(input.baseUrl.endsWith('/') ? input.baseUrl : input.baseUrl + '/');
  // Keep credentials scoped to the known tenant/API; no arbitrary custom hosts.
  ensure(target.kind === 'jira'
    ? /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/$/.test(endpoint.href)
      && target.issueUrl === `${endpoint.origin}/browse/${target.issueKey}`
    : endpoint.origin === 'https://api.linear.app' && endpoint.pathname === '/'
      && issueUrl.origin === 'https://linear.app'
      && new RegExp(`^/[^/]+/issue/${target.issueKey}(?:/[^/]+)?/?$`).test(issueUrl.pathname));
  const baseUrl = endpoint.origin;
  const merged = plain(input.mergeReceipt);
  validateReceipt(merged,{action:'merge',digest:digest(merged.operationDigest),candidate:{headSha:sha(merged.headSha)}});
  safeUrl(merged.resourceUrl);
  const reviewPrefix = `${repository.url}${repository.provider === 'github' ? '/pull/' : repository.provider === 'gitlab' ? '/-/merge_requests/' : '/pull-requests/'}`;
  const reviewNumber = Number(merged.resourceUrl.slice(reviewPrefix.length));
  ensure(Number.isSafeInteger(reviewNumber) && reviewNumber > 0 && merged.resourceUrl === reviewPrefix + reviewNumber);
  let deploymentUrl = null;
  if (input.deploymentReceipt !== null) {
    const deployed = plain(input.deploymentReceipt);
    validateReceipt(deployed,{action:'deploy',digest:digest(deployed.operationDigest),candidate:{headSha:merged.headSha}});
    ensure(deployed.commitSha === merged.commitSha); safeUrl(deployed.resourceUrl); deploymentUrl = deployed.resourceUrl;
  }
  const clock = input.clock ?? (()=>new Date().toISOString()); ensure(typeof clock === 'function');
  const http = createProviderHttpClient({provider:target.kind,baseUrl,transport:input.transport,maxItems:1000,maxPages:10,
    ...(input.headers === undefined ? {} : {headers:input.headers}), ...(input.timeoutMs === undefined ? {} : {timeoutMs:input.timeoutMs})});
  async function graphql(query,variables) {
    const response = (await http.request({method:'POST',path:'/graphql',wireBody:createProviderReadBody({provider:'linear',payload:{query,variables}})})).data;
    ensure(response && !Object.hasOwn(response,'errors') && response.data && typeof response.data === 'object','invalid-provider-evidence');
    return response.data;
  }
  const internal = value => { ensure(typeof value === 'string' && (target.kind === 'jira' ? NUMBER : UUID).test(value), 'invalid-provider-evidence'); return value; };
  async function issue(selected, expected) {
    if (target.kind === 'jira') {
      const value = (await http.request({method:'GET',path:`/rest/api/3/issue/${encodeURIComponent(selected)}?fields=updated,project`})).data;
      internal(value?.id);
      ensure(value.key === target.issueKey && (!expected || value.id === expected)
        && typeof value.fields?.project?.id === 'string' && NUMBER.test(value.fields.project.id)
        && value.fields.project.key === target.issueKey.split('-')[0], 'changed-facts');
      return plain({id:value.id,key:value.key,project:{id:value.fields.project.id,key:value.fields.project.key},revision:revision(value.fields.updated)});
    }
    const value = (await graphql(ISSUE_QUERY,{id:selected})).issue;
    internal(value?.id);
    ensure(value.identifier === target.issueKey && value.url === target.issueUrl && (!expected || value.id === expected)
      && typeof value.team?.id === 'string' && UUID.test(value.team.id)
      && value.team.key === target.issueKey.split('-')[0], 'changed-facts');
    return plain({id:value.id,key:value.identifier,team:{id:value.team.id,key:value.team.key},revision:revision(value.updatedAt)});
  }
  const binding = {...target,providerId:input.providerId,endpoint:baseUrl,mergeCommit:merged.commitSha,reviewUrl:merged.resourceUrl,deploymentUrl};
  let payload;
  if (input.persistedPayload !== undefined) {
    const stored = plain(input.persistedPayload);
    exact(stored,[...Object.keys(binding),'issueInternalId']);
    const {issueInternalId,...priorBinding} = stored;
    internal(issueInternalId); ensure(hash(binding) === hash(priorBinding),'changed-facts');
    await issue(issueInternalId,issueInternalId); payload = stored;
  } else {
    const source = await issue(target.issueKey);
    payload = plain({...binding,issueInternalId:source.id});
  }
  const preview = `Rivet delivery update\nMerged commit: ${merged.commitSha}\nReview: ${merged.resourceUrl}${deploymentUrl ? `\nVerified deployment: ${deploymentUrl}` : ''}`;
  function candidate(value) {
    validateCandidate(value);
    ensure(hash(value.repository) === hash(repository) && value.headSha === merged.headSha
      && (value.reviewNumber === null || value.reviewNumber === reviewNumber),'changed-facts');
  }
  async function observe(value) {
    candidate(value);
    const current = await issue(payload.issueInternalId,payload.issueInternalId), evidenceDigest = hash({current,target,payload});
    return plain({repositoryUrl:repository.url,sourceBranch:value.sourceBranch,targetBranch:value.targetBranch,headSha:value.headSha,baseSha:merged.commitSha,
      review:{number:reviewNumber,state:'merged',url:merged.resourceUrl,headSha:value.headSha},
      checks:{headSha:value.headSha,policy:'unknown',satisfied:null,evidenceDigest},
      reviews:{headSha:value.headSha,policy:'unknown',satisfied:null,evidenceDigest},observedAt:timestamp(clock())});
  }
  function operation(input) {
    const op=plain(input);candidate(op.candidate);digest(op.digest);
    ensure(op.action === 'tracker-update' && hash(op.payload) === hash(payload) && hash(op.mergeReceipt) === hash(merged),'changed-facts');
    return op;
  }
  const bodyFor = op => `${preview}\n\nRivet delivery operation: ${op.digest}`;
  async function comments() {
    if (target.kind === 'jira') return http.paginate({path:`/rest/api/3/issue/${payload.issueInternalId}/comment?startAt=0&maxResults=100`,mode:'jira-offset',itemsKey:'comments',identityKey:'id',totalKey:'total'});
    const output=[],seen=new Set(),ids=new Set();let cursor=null;
    for(let page=0;page<10;page++) {
      const value=(await graphql(COMMENTS_QUERY,{id:payload.issueInternalId,cursor})).issue;
      ensure(value?.id === payload.issueInternalId && Array.isArray(value.comments?.nodes),'invalid-provider-evidence');
      const {nodes,pageInfo}=value.comments;
      ensure(nodes.length <= 100 && pageInfo && typeof pageInfo.hasNextPage === 'boolean','invalid-provider-evidence');
      for(const item of nodes) {ensure(typeof item?.id === 'string' && UUID.test(item.id) && !ids.has(item.id),'invalid-provider-evidence');ids.add(item.id);output.push(item);}
      if(pageInfo.hasNextPage === false)return output;
      ensure(nodes.length > 0 && typeof pageInfo.endCursor === 'string' && /^[A-Za-z0-9._~+=/-]{1,512}$/.test(pageInfo.endCursor) && !seen.has(pageInfo.endCursor),'invalid-provider-evidence');
      cursor=pageInfo.endCursor;seen.add(cursor);
    }
    ensure(false,'invalid-provider-evidence');
  }
  async function reconcile(input) {
    try {
      const op=operation(input),current=await issue(payload.issueInternalId,payload.issueInternalId),all=await comments();
      const expected=target.kind === 'jira' ? document(bodyFor(op)) : bodyFor(op);
      for(const item of all) ensure(typeof item?.id === 'string' && (target.kind==='jira'?NUMBER:UUID).test(item.id)
        && (target.kind==='jira' ? item.body?.type==='doc' && item.body.version===1 && Array.isArray(item.body.content) : typeof item.body==='string'),'invalid-provider-evidence');
      const marker = `Rivet delivery operation: ${op.digest}`;
      const matches=all.filter(item=>JSON.stringify(item.body).includes(marker));
      ensure(matches.length===1 && hash(matches[0].body)===hash(expected),'unverified-effect');
      return {status:'succeeded',receipt:plain({status:'succeeded',operationDigest:op.digest,headSha:op.candidate.headSha,commitSha:merged.commitSha,
        resourceUrl:target.issueUrl,evidenceDigest:hash({issue:current,comment:matches[0],payload})})};
    }catch{return {status:'unknown'}}
  }
  async function dispatch(input,context) {
    const op=operation(input),ctx=plain(context);exact(ctx,['deadline']);const deadline=Date.parse(timestamp(ctx.deadline));
    const timely=()=>ensure(Date.parse(timestamp(clock()))<deadline,'dispatch-expired');timely();
    ensure(factsDigest(await observe(op.candidate))===op.factsDigest,'changed-facts');
    const wireBody=createProviderWireBody({provider:target.kind,action:target.kind==='jira'?'comment':'delivery-comment',resourceId:payload.issueInternalId,
      expectedState:'merged',expectedVersion:merged.commitSha,idempotencyKey:op.digest,
      payload:target.kind==='jira'?{body:document(bodyFor(op))}:{issueId:payload.issueInternalId,body:bodyFor(op)}});
    timely();const remaining=deadline-Date.parse(timestamp(clock()));ensure(remaining>0,'dispatch-expired');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
    try {
      const response=(await http.request({method:'POST',path:target.kind==='jira'?`/rest/api/3/issue/${payload.issueInternalId}/comment`:'/graphql',wireBody,signal:controller.signal})).data;
      if(target.kind==='linear')ensure(response && !Object.hasOwn(response,'errors') && response.data?.commentCreate?.success===true,'unverified-effect');
    } finally {clearTimeout(timer)}
    const result=await reconcile(op);ensure(result.status==='succeeded','unverified-effect');return result.receipt;
  }
  // conditionalHead binds comment content to the confirmed merge commit; it does
  // not claim atomic issue version checks or native comment idempotency.
  const executor=createTrustedDeliveryExecutor({provider:repository.provider,capabilities:[{action:'tracker-update',conditionalHead:true,reconcile:true}],observe,dispatch,reconcile});
  return Object.freeze({executor,payload,preview});
}
