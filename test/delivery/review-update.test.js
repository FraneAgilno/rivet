import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
const at='2026-09-26T10:00:00.000Z',head='a'.repeat(40),base='b'.repeat(40);
async function fixture(kind){
 const repository={provider:kind,host:kind==='bitbucket'?'bitbucket.org':`${kind}.com`,namespace:'team',name:'repo',fullName:'team/repo',url:`https://${kind==='bitbucket'?'bitbucket.org':kind+'.com'}/team/repo`};
 const target=candidate({runId:'run-one',repository,sourceBranch:'feature/work',targetBranch:'main',reviewNumber:7,localVerification:{runId:'run-one',headSha:head,evidenceDigest:'d'.repeat(64),verifiedAt:at,status:'passed'}});
 const repo=kind==='github'?{id:10,full_name:'team/repo',html_url:repository.url,archived:false}:kind==='gitlab'?{id:10,path_with_namespace:'team/repo',web_url:repository.url,archived:false}:{uuid:'{00000000-0000-4000-8000-000000000001}',full_name:'team/repo',links:{html:{href:repository.url}},workspace:{uuid:'{00000000-0000-4000-8000-000000000002}',slug:'team'}};
 const review=kind==='github'?{number:7,state:'open',draft:false,merged:false,title:'Old',body:'Old body',html_url:repository.url+'/pull/7',head:{sha:head,ref:target.sourceBranch,repo},base:{sha:base,ref:'main',repo}}:kind==='gitlab'?{iid:7,id:17,project_id:10,source_project_id:10,target_project_id:10,source_branch:target.sourceBranch,target_branch:'main',sha:head,state:'opened',draft:false,title:'Old',description:'Old body',web_url:repository.url+'/-/merge_requests/7'}:{id:7,state:'OPEN',draft:false,title:'Old',description:'Old body',links:{html:{href:repository.url+'/pull-requests/7'}},source:{branch:{name:target.sourceBranch},commit:{hash:head},repository:repo},destination:{branch:{name:'main'},commit:{hash:base},repository:repo}};
 const data={repo,review,head,base,writes:[],reads:0};
 const root=kind==='github'?'/repos/team/repo':kind==='gitlab'?'/api/v4/projects/team%2Frepo':'/2.0/repositories/team/repo';
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,options)=>{
  const path=new URL(url).pathname.slice(root.length);
  if(options.method!=='GET'){data.writes.push({method:options.method,body:JSON.parse(options.body)});Object.assign(review,JSON.parse(options.body));await data.afterWrite?.();return Response.json(review);}
  data.reads++;await data.beforeRead?.(path);
  if(!path)return Response.json(repo);
  if(path.includes('/branches/')){const name=decodeURIComponent(path.split('/branches/')[1]),sha=name==='main'?data.base:data.head;return Response.json(kind==='bitbucket'?{name,target:{hash:sha}}:{name,commit:{sha,id:sha}});}
  return Response.json(review);
 }});
 const {createReviewUpdateExecutor}=await import('../../src/delivery/review-update.js');
 const executor=createReviewUpdateExecutor({repository,reviewNumber:7,transport,clock:()=>at});
 const operation=async()=>{const payload=await executor.prepare(target,{title:'New',body:'New body'});return {action:'review-update',candidate:target,payload,digest:'e'.repeat(64),factsDigest:factsDigest(await executor.observe(target))};};
 return {data,target,executor,operation,transport,repository};
}
for(const kind of ['github','gitlab','bitbucket']){
 test(`${kind} review metadata update sends only approved title/body and confirms desired state`,async()=>{
  const f=await fixture(kind),op=await f.operation();const receipt=await f.executor.dispatch(op,{deadline:'2026-09-26T10:01:00.000Z'});
  assert.equal(receipt.resourceUrl,f.data.review.html_url??f.data.review.web_url??f.data.review.links.html.href);assert.equal(f.data.writes.length,1);
  assert.deepEqual(f.data.writes[0],{method:kind==='github'?'PATCH':'PUT',body:kind==='github'?{title:'New',body:'New body'}:{title:'New',description:'New body'}});
  assert.equal(op.payload.assurance,'precheck-readback');assert.equal((await f.executor.reconcile(op)).status,'succeeded');assert.equal(f.data.writes.length,1);
 });
 test(`${kind} metadata drift before dispatch rejects without a write`,async()=>{const f=await fixture(kind),op=await f.operation();f.data.review.title='Another edit';await assert.rejects(f.executor.dispatch(op,{deadline:'2026-09-26T10:01:00.000Z'}));assert.equal(f.data.writes.length,0);});
 test(`${kind} post-write head or metadata drift remains unknown and does not repeat mutation`,async()=>{for(const change of ['head','body','base']){const f=await fixture(kind),op=await f.operation();f.data.afterWrite=()=>{if(change==='body')f.data.review[kind==='github'?'body':'description']='Another edit';else f.data[change]='c'.repeat(40);};await assert.rejects(f.executor.dispatch(op,{deadline:'2026-09-26T10:01:00.000Z'}));assert.equal((await f.executor.reconcile(op)).status,'unknown');assert.equal(f.data.writes.length,1);}});
 test(`${kind} rejects closed drafts malformed text and scope expansion`,async()=>{const f=await fixture(kind);await assert.rejects(f.executor.prepare(f.target,{title:'New',body:'Body',state:'closed'}));await assert.rejects(f.executor.prepare(f.target,{title:'Bad\u0001',body:'Body'}));f.data.review.draft=true;await assert.rejects(f.operation());assert.equal(f.data.writes.length,0);});
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveStatePaths } from '../../src/state/paths.js';
import { createDeliveryStore } from '../../src/delivery/store.js';
import { createDeliveryService } from '../../src/delivery/service.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { createApprovalRegistry } from '../../src/policy/approvals.js';
import { runRemoteDelivery } from '../../src/commands/delivery-remote.js';
async function commandFixture(t,kind){
 const f=await fixture(kind),root=await mkdtemp(join(tmpdir(),'rivet-review-update-'));t.after(()=>rm(root,{recursive:true,force:true}));execFileSync('git',['init','-q',root]);
 const paths=await resolveStatePaths(root,'delivery-one'),store=createDeliveryStore(paths);
 await createDeliveryService({store,executor:f.executor.executor,providerId:'team-api',subjectId:'delivery-cli',expectedApproverId:'terminal-human',authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:[],ownedPaths:[],providers:[],commands:[]}),approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})}).initialize((({headSha,...input})=>input)(f.target));
 const endpoint={github:'https://api.github.com',gitlab:'https://gitlab.com/api/v4',bitbucket:'https://api.bitbucket.org/2.0'}[kind];
 const config={project:{id:'demo'},providers:{providers:[{id:'team-api',kind:'git-ci',mode:'read-write-with-approval',transport:'direct-api',capabilities:['repository-read','review-update'],projectIds:['demo'],resourceIds:['team/repo'],endpoint,credentials:{accessTokenEnv:'TEST_TOKEN'}}]}};
 const logs=[],calls={approval:0,local:0};const dependencies={env:{TEST_TOKEN:'fixture-token'},terminalIsInteractive:()=>true,output:{log:value=>logs.push(value)},confirmDelivery:async()=>{calls.approval++;return true;},delivery:{transport:f.transport}};
 const invoke=overrides=>runRemoteDelivery({action:'review-update',store,config,flags:{title:'New',body:'New body'},dependencies,validateLocal:async()=>{calls.local++;},...overrides});
 return {...f,store,paths,config,dependencies,calls,logs,invoke};
}
for(const kind of ['github','gitlab','bitbucket']){
 test(`${kind} CLI binds approval, persists receipt, allows later approved updates and keeps old history`,async t=>{
  const f=await commandFixture(t,kind);let state=await f.invoke();assert.equal(state.stage,'review-requested');assert.equal(state.operations[0].state,'succeeded');assert.equal(f.calls.approval,1);assert.equal(f.calls.local,2);assert(f.logs.some(x=>x.includes('Previous title: Old')));assert(f.logs.some(x=>x.includes('Concurrent edits may be overwritten')));
  state=await f.invoke({flags:{title:'Second',body:'Second body'}});assert.equal(state.operations.length,2);assert.equal(f.data.writes.length,2);assert.equal(state.operations[0].payload.desired.title,'New');
  const reopened=createDeliveryStore(f.paths);assert.equal((await reopened.read()).operations.length,2);const noop=await f.invoke({flags:{title:'Second',body:'Second body'}});assert.equal(noop.reviewUpdateNoop,true);assert.equal(f.data.writes.length,2);
 });
 test(`${kind} uncertain write reconciles after reopening without mutation replay`,async t=>{
  const f=await commandFixture(t,kind);f.data.afterWrite=()=>{throw new Error('response lost');};let state=await f.invoke();assert.equal(state.operations[0].state,'indeterminate');assert.equal(f.data.writes.length,1);
  state=await f.invoke({action:'reconcile',flags:{},store:createDeliveryStore(f.paths)});assert.equal(state.operations[0].state,'succeeded');assert.equal(f.data.writes.length,1);
 });
 test(`${kind} declined approval and drift send no metadata write`,async t=>{
  const f=await commandFixture(t,kind);f.dependencies.confirmDelivery=async()=>false;await assert.rejects(f.invoke());assert.equal(f.data.writes.length,0);
  f.dependencies.confirmDelivery=async()=>{f.data.review.title='Concurrent title';return true;};await assert.rejects(f.invoke());assert.equal(f.data.writes.length,0);
 });
}
test('review update preserves creation markers and rejects unapproved fields before network',async()=>{
 const f=await fixture('github'),marker='<!-- rivet-review-operation:'+ 'f'.repeat(64)+' -->';f.data.review.body='Old\n\n'+marker;
 const preserved=await f.executor.prepare(f.target,{title:'New',body:'No marker'});assert.equal(preserved.desired.body,'No marker\n\n'+marker);await assert.rejects(f.executor.prepare(f.target,{title:'New',body:'<!-- rivet-review-operation:'+ 'c'.repeat(64)+' -->'}));const payload=await f.executor.prepare(f.target,{title:'New',body:'New\n\n'+marker});assert.equal(payload.desired.body,'New\n\n'+marker);
 const g=await fixture('gitlab'),reads=g.data.reads;await assert.rejects(g.executor.prepare(g.target,{title:'Draft: Changed',body:'Body'}));assert.equal(g.data.reads,reads);
});
import { parseArgs } from '../../src/cli/parse-args.js';
test('review update parser supports an explicitly empty body without loosening other empty flags',()=>{
 assert.equal(parseArgs(['delivery','review-update','--title=Title','--body=']).flags.body,'');
 assert.throws(()=>parseArgs(['delivery','review-update','--title=','--body=Body']));
 assert.throws(()=>parseArgs(['delivery','merge','--body=']));
});
for(const kind of ['github','gitlab','bitbucket']){
 test(`${kind} repository identity, closed review, draft, or expired deadline cannot dispatch`,async()=>{
  for(const change of ['repository','closed','draft','deadline']){const f=await fixture(kind),op=await f.operation();if(change==='repository'){if(kind==='bitbucket')f.data.repo.uuid='{00000000-0000-4000-8000-000000000003}';else f.data.repo.id=20;}if(change==='closed')f.data.review.state='closed';if(change==='draft')f.data.review.draft=true;await assert.rejects(f.executor.dispatch(op,{deadline:change==='deadline'?at:'2026-09-26T10:01:00.000Z'}));assert.equal(f.data.writes.length,0);}
 });
 test(`${kind} CLI rechecks configuration and refuses noninteractive or unscoped update`,async t=>{
  const f=await commandFixture(t,kind);f.dependencies.terminalIsInteractive=()=>false;await assert.rejects(f.invoke());assert.equal(f.data.reads,0);f.dependencies.terminalIsInteractive=()=>true;
  await assert.rejects(f.invoke({reloadConfig:async()=>({...f.config,project:{id:'other'}})}));assert.equal(f.data.writes.length,0);
  f.config.providers.providers[0].resourceIds=['other/repo'];await assert.rejects(f.invoke());assert.equal(f.data.writes.length,0);
 });
}
test('GitLab rejects title-driven draft changes and active description commands before reads or writes',async()=>{
 for(const title of ['(Draft) Changed','[Draft] Changed','Draft: Changed','(WIP) Changed','[WIP] Changed','WIP: Changed']){
  const f=await fixture('gitlab');await assert.rejects(f.executor.prepare(f.target,{title,body:'Ordinary metadata'}));assert.equal(f.data.reads,0);assert.equal(f.data.writes.length,0);
 }
 for(const body of ['/close','Description\n/close','/draft','  /assign @someone','\t/label ~private','Text\n/target_branch other','/rebase','/merge','/approve','/new_action value']){
  const f=await fixture('gitlab');await assert.rejects(f.executor.prepare(f.target,{title:'Changed',body}));assert.equal(f.data.reads,0);assert.equal(f.data.writes.length,0);
 }
});
test('ordinary slash prose and paths remain metadata; provider-specific text restrictions do not apply to GitHub',async()=>{
 const f=await fixture('gitlab'),body='Use /close only after review.\n/docs/getting-started\nhttps://example.com/a/b\nThe path is /tmp/work.';const payload=await f.executor.prepare(f.target,{title:'Discuss draft behavior',body});assert.equal(payload.desired.body,body);
 const g=await fixture('github');const other=await g.executor.prepare(g.target,{title:'(Draft) behavior documentation',body:'/close'});assert.equal(other.desired.body,'/close');
});
test('GitLab CLI and direct dispatch reject executable metadata without mutation',async t=>{
 const f=await commandFixture(t,'gitlab');await assert.rejects(f.invoke({flags:{title:'Changed',body:'/close'}}));assert.equal(f.data.reads,0);assert.equal(f.data.writes.length,0);
 const op=await f.operation();op.payload={...op.payload,desired:{title:'Changed',body:'/close'}};await assert.rejects(f.executor.dispatch(op,{deadline:'2026-09-26T10:01:00.000Z'}));assert.equal(f.data.writes.length,0);
});
