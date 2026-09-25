import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
import { createTrackerDelivery } from '../../src/delivery/tracker.js';
const head='a'.repeat(40), merged='b'.repeat(40), digest='d'.repeat(64), at='2026-09-25T10:00:00.000Z';
const repository={provider:'github',host:'github.com',namespace:'team',name:'repo',fullName:'team/repo',url:'https://github.com/team/repo'};
const mergeReceipt={status:'succeeded',operationDigest:'e'.repeat(64),headSha:head,evidenceDigest:digest,resourceUrl:repository.url+'/pull/7',commitSha:merged};
const candidateValue=candidate({runId:'run-one',repository,sourceBranch:'feature',targetBranch:'main',reviewNumber:7,localVerification:{runId:'run-one',status:'passed',headSha:head,evidenceDigest:digest,verifiedAt:at}});
const uuid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
async function fixture(kind='jira',change=()=>{}) {
 const issueInternalId=kind==='jira'?'123':uuid;
 const baseUrl=kind==='jira'?'https://team.atlassian.net':'https://api.linear.app';
 const target={kind,issueKey:'TEAM-7',issueUrl:kind==='jira'?baseUrl+'/browse/TEAM-7':'https://linear.app/team/issue/TEAM-7/task',requestDigest:digest};
 const data={calls:[],comments:[],now:at,issue:kind==='jira'?{id:'123',key:'TEAM-7',fields:{updated:at,project:{id:'9',key:'TEAM'}}}:{id:uuid,identifier:'TEAM-7',url:target.issueUrl,updatedAt:at,team:{id:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',key:'TEAM'}}};
 change(data);
 const transport=createTrustedProviderTransport({resolve:async()=>{await data.resolve?.();return ['93.184.216.34']},fetchPinned:async(url,options)=>{
  data.calls.push({url,...options});const overridden=await data.respond?.(url,options);if(overridden)return overridden;
  if(kind==='jira'){
   if(options.method==='POST'){const body=JSON.parse(options.body).body;data.comments.push({id:'17',body});return Response.json({id:'17'},{status:201});}
   if(new URL(url).pathname.endsWith('/comment'))return Response.json({comments:data.comments,startAt:0,maxResults:100,total:data.comments.length});
   return Response.json(data.issue);
  }
  const body=JSON.parse(options.body);
  if(body.query.startsWith('mutation')){data.comments.push({id:'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',body:body.variables.input.body});return Response.json({data:{commentCreate:{success:true,comment:{id:data.comments[0].id}}}});}
  if(body.query.includes('comments('))return Response.json({data:{issue:{id:issueInternalId,comments:{nodes:data.comments,pageInfo:{hasNextPage:false,endCursor:null}}}}});
  return Response.json({data:{issue:data.issue}});
 }});
 const config={repository,target,mergeReceipt,deploymentReceipt:null,providerId:kind+'-primary',baseUrl,transport,clock:()=>data.now,timeoutMs:100};
 const result=await createTrackerDelivery(config);
 return {...result,data,config};
}
async function op(f){return {action:'tracker-update',digest,candidate:candidateValue,mergeReceipt,payload:f.payload,factsDigest:factsDigest(await f.executor.observe(candidateValue))};}
const deadline={deadline:'2026-09-25T10:01:00.000Z'};
for(const kind of ['jira','linear']){
 test(`${kind}: appends exact merged delivery summary and verifies remote comment on immutable issue`,async()=>{
  const f=await fixture(kind),operation=await op(f),receipt=await f.executor.dispatch(operation,deadline);
  assert.equal(receipt.commitSha,merged);assert.equal(receipt.resourceUrl,f.config.target.issueUrl);assert.equal(f.payload.issueInternalId,kind==='jira'?'123':uuid);
  assert.ok(f.preview.includes(merged));assert.ok(!f.preview.includes('completed'));
  const writes=f.data.calls.filter(c=>c.method==='POST'&&(kind==='jira'||JSON.parse(c.body).query.startsWith('mutation')));
  assert.equal(writes.length,1);assert.ok(writes[0].body.includes(digest));
  if(kind==='jira')assert.ok(writes[0].url.endsWith('/issue/123/comment'));else assert.equal(JSON.parse(writes[0].body).variables.input.issueId,uuid);
  const before=writes.length;assert.equal((await f.executor.reconcile(operation)).status,'succeeded');
  assert.equal(f.data.calls.filter(c=>c.method==='POST'&&(kind==='jira'||JSON.parse(c.body).query.startsWith('mutation'))).length,before);
 });
 test(`${kind}: absence, duplicates and moved immutable issue cannot claim tracker updated`,async()=>{
  const f=await fixture(kind),operation=await op(f);assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
  await f.executor.dispatch(operation,deadline);f.data.comments.push({...f.data.comments[0],id:kind==='jira'?'18':'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee'});
  assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
  f.data.comments.pop();f.data.issue.id=kind==='jira'?'124':'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
 });
 test(`${kind}: changed revision or expired approval prevents mutation`,async()=>{
  const f=await fixture(kind),operation=await op(f);if(kind==='jira')f.data.issue.fields.updated='2026-09-25T10:00:01.000Z';else f.data.issue.updatedAt='2026-09-25T10:00:01.000Z';
  await assert.rejects(f.executor.dispatch(operation,deadline));await assert.rejects(f.executor.dispatch(operation,{deadline:at}));assert.equal(f.data.comments.length,0);
 });
 test(`${kind}: reopening uses persisted immutable binding and rejects tampered payload`,async()=>{
  const f=await fixture(kind);const reopened=await createTrackerDelivery({...f.config,persistedPayload:f.payload});assert.deepEqual(reopened.payload,f.payload);
  await assert.rejects(createTrackerDelivery({...f.config,persistedPayload:{...f.payload,mergeCommit:head}}));
 });
}
for(const kind of ['jira','linear']){
 test(`${kind}: complete pagination is required and changed operation-marker body stays unknown`,async()=>{
  const f=await fixture(kind),operation=await op(f);await f.executor.dispatch(operation,deadline);
  const exact=f.data.comments[0],other={id:kind==='jira'?'16':'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',body:kind==='jira'?{type:'doc',version:1,content:[]}:''};
  let pages=0;
  f.data.respond=async(url,options)=>{
   if(kind==='jira'&&options.method==='GET'&&new URL(url).pathname.endsWith('/comment')){
    pages++;const startAt=Number(new URL(url).searchParams.get('startAt'));
    return Response.json({comments:[startAt===0?other:exact],startAt,maxResults:1,total:2});
   }
   if(kind==='linear'&&JSON.parse(options.body).query.includes('comments(')){
    pages++;const cursor=JSON.parse(options.body).variables.cursor;
    return Response.json({data:{issue:{id:uuid,comments:{nodes:[cursor===null?other:exact],pageInfo:{hasNextPage:cursor===null,endCursor:cursor===null?'next':null}}}}});
   }
  };
  assert.equal((await f.executor.reconcile(operation)).status,'succeeded');assert.equal(pages,2);
  f.data.respond=undefined;
  const changed=structuredClone(exact);changed.id=other.id;
  if(kind==='jira')changed.body.content[0].content[0].text='Changed summary';else changed.body='Changed summary\n'+changed.body;
  f.data.comments=[changed];assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
  f.data.comments=[exact,changed];assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
 });
 test(`${kind}: inaccessible or malformed comment tail cannot claim success`,async()=>{
  const f=await fixture(kind),operation=await op(f);await f.executor.dispatch(operation,deadline);
  f.data.comments.push({id:kind==='jira'?'18':'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',body:123});
  assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
  f.data.respond=async()=>{throw new Error('private-credential')};
  assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
 });
 test(`${kind}: lost response stays uncertain and reconciliation does not repeat writes`,async()=>{
  const f=await fixture(kind),operation=await op(f);let attempts=0;
  f.data.respond=async(url,options)=>{
   if(options.method==='POST'&&(kind==='jira'||JSON.parse(options.body).query.startsWith('mutation'))){attempts++;throw new Error('private-credential')}
  };
  await assert.rejects(f.executor.dispatch(operation,deadline),error=>!error.message.includes('private-credential'));
  assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});assert.equal(attempts,1);
 });
}
test('GraphQL errors with partial data never authorize tracker completion',async()=>{
 const f=await fixture('linear'),operation=await op(f);await f.executor.dispatch(operation,deadline);
 f.data.respond=async()=>Response.json({errors:[{message:'private-credential'}],data:{issue:f.data.issue}});
 assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
 await assert.rejects(createTrackerDelivery(f.config),error=>!error.message.includes('private-credential'));
});
test('strict Linear wire format prevents arbitrary mutations, messages or stale SHA markers',async()=>{
 const {createProviderWireBody}=await import('../../src/adapters/contract.js');
 const body=`Rivet delivery update\nMerged commit: ${merged}\nReview: ${repository.url}/pull/7\n\nRivet delivery operation: ${digest}`;
 const request={provider:'linear',action:'delivery-comment',resourceId:uuid,expectedState:'merged',expectedVersion:merged,idempotencyKey:digest,payload:{issueId:uuid,body}};
 assert.ok(createProviderWireBody(request));
 for(const change of [v=>v.payload.query='mutation DeleteIssue',v=>v.payload.body='@team hello',v=>v.payload.body=v.payload.body.replace(merged,head),v=>v.payload.issueId='other',v=>v.payload.body+='\nExtra',v=>v.payload.body=v.payload.body.replace(digest,'f'.repeat(64))]){
  const value=structuredClone(request);change(value);assert.throws(()=>createProviderWireBody(value));
 }
});
for(const kind of ['jira','linear']){
 test(`${kind}: DNS resolution cannot outlive mutation approval deadline`,async()=>{
  const f=await fixture(kind),operation=await op(f);let resolutions=0;
  f.data.resolve=async()=>{if(++resolutions===2)await new Promise(resolve=>setTimeout(resolve,60))};
  await assert.rejects(f.executor.dispatch(operation,{deadline:'2026-09-25T10:00:00.020Z'}));
  assert.equal(f.data.comments.length,0);
 });
 test(`${kind}: unsupported tenant/source, tampered deployment and hostile getters fail closed`,async()=>{
  const f=await fixture(kind);let invoked=false;
  for(const change of [v=>v.baseUrl='https://evil.example',v=>v.target={...v.target,issueUrl:'https://evil.example/TEAM-7'},
   v=>v.deploymentReceipt={...mergeReceipt,resourceUrl:'https://deploy.example/result',commitSha:head},
   v=>Object.defineProperty(v,'target',{enumerable:true,get(){invoked=true;return f.config.target}})]){
    const value={...f.config};change(value);await assert.rejects(createTrackerDelivery(value));
  }
  assert.equal(invoked,false);
  const receipt={...mergeReceipt,operationDigest:'f'.repeat(64),resourceUrl:'https://deploy.example/result'};
  const result=await createTrackerDelivery({...f.config,deploymentReceipt:receipt});
  assert.ok(result.preview.includes('Verified deployment: https://deploy.example/result'));
 });
}
test('Linear looping pagination and any GraphQL error on mutation are indeterminate',async()=>{
 const f=await fixture('linear'),operation=await op(f);
 f.data.respond=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(body.query.startsWith('mutation'))return Response.json({data:{commentCreate:{success:true}},errors:[{message:'private-credential'}]});
 };
 await assert.rejects(f.executor.dispatch(operation,deadline),error=>!error.message.includes('private-credential'));
 f.data.respond=async(url,options)=>{
  if(JSON.parse(options.body).query.includes('comments('))return Response.json({data:{issue:{id:uuid,comments:{nodes:[{id:'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',body:''}],pageInfo:{hasNextPage:true,endCursor:'repeat'}}}}});
 };
 assert.deepEqual(await f.executor.reconcile(operation),{status:'unknown'});
});
test('Linear exact source URL may omit a slug; unrelated metadata does not change approval facts',async()=>{
 const f=await fixture('linear');
 const issueUrl='https://linear.app/team/issue/TEAM-7';f.data.issue.url=issueUrl;
 const result=await createTrackerDelivery({...f.config,target:{...f.config.target,issueUrl}});
 const before=factsDigest(await result.executor.observe(candidateValue));
 f.data.issue.team.name='Renamed team';f.data.issue.team.description='Unrelated display metadata';
 assert.equal(factsDigest(await result.executor.observe(candidateValue)),before);
 f.data.issue.team.key='OTHER';await assert.rejects(result.executor.observe(candidateValue));
});
test('Jira project display metadata is excluded from approval evidence',async()=>{
 const f=await fixture('jira'),before=factsDigest(await f.executor.observe(candidateValue));
 f.data.issue.fields.project.name='Renamed project';f.data.issue.fields.project.avatarUrls={'16x16':'https://assets.example/avatar'};
 assert.equal(factsDigest(await f.executor.observe(candidateValue)),before);
 f.data.issue.fields.project.key='OTHER';await assert.rejects(f.executor.observe(candidateValue));
});
