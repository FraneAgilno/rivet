import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
import { reviewRequestPayload, reviewRequestContent } from '../../src/delivery/review-request.js';
const head='a'.repeat(40),base='b'.repeat(40),at='2026-09-26T10:00:00.000Z';
const uuid=n=>`{${String(n).padStart(8,'0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee}`;
async function fixture() {
  const repository={provider:'bitbucket',host:'bitbucket.org',namespace:'team',name:'repo',fullName:'team/repo',url:'https://bitbucket.org/team/repo'};
  const target=candidate({runId:'run-one',repository,sourceBranch:'feature/work',targetBranch:'main',localVerification:{runId:'run-one',headSha:head,evidenceDigest:'d'.repeat(64),verifiedAt:at,status:'passed'}});
  const data={head,base,uuid:uuid(1),workspace:uuid(2),reviews:[],calls:[],writes:0};
  const repo=()=>({uuid:data.uuid,full_name:repository.fullName,links:{html:{href:repository.url}},workspace:{uuid:data.workspace,slug:'team'}});
  const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,options)=>{
    const u=new URL(url),path=u.pathname.slice('/2.0/repositories/team/repo'.length);
    data.calls.push({url,method:options.method,body:options.body,headers:options.headers,path});
    const override=await data.respond?.(u,path,options);if(override)return override;
    if(options.method==='POST') {
      data.writes++;const body=JSON.parse(options.body),id=data.reviews.length+1;
      const condensed=repo();delete condensed.workspace;
      const row={id,state:'OPEN',draft:false,close_source_branch:false,title:body.title,description:body.description,links:{html:{href:`${repository.url}/pull-requests/${id}`}},
        source:{branch:{name:target.sourceBranch},commit:{hash:data.head},repository:condensed},
        destination:{branch:{name:target.targetBranch},commit:{hash:data.base},repository:structuredClone(condensed)}};
      data.reviews.push(row);await data.afterPost?.(row);return Response.json(row,{status:201});
    }
    if(path==='')return Response.json(repo());
    if(path.startsWith('/refs/branches/')){const name=decodeURIComponent(path.slice('/refs/branches/'.length));return Response.json({name,target:{hash:name===target.sourceBranch?data.head:data.base}});}
    if(path==='/pullrequests')return Response.json({pagelen:100,values:data.reviews.filter(row=>row.state===u.searchParams.get('state'))});
    if(path.startsWith('/pullrequests/'))return Response.json(data.reviews.find(row=>row.id===Number(path.split('/').at(-1))));
    assert.fail(path);
  }});
  const {createBitbucketReviewExecutor}=await import('../../src/delivery/bitbucket-review.js');
  const executor=createBitbucketReviewExecutor({repository,transport,clock:()=>at,timeoutMs:30});
  const operation=async()=>({action:'review-request',digest:'e'.repeat(64),candidate:target,payload:reviewRequestPayload(target),factsDigest:factsDigest(await executor.observe(target))});
  return {data,repository,target,executor,operation,transport,createBitbucketReviewExecutor};
}
const deadline={deadline:'2026-09-26T10:01:00.000Z'};
test('Bitbucket creates exact marked non-draft same-repo review after observing all states',async()=>{
  const f=await fixture(),op=await f.operation(),receipt=await f.executor.dispatch(op,deadline);
  assert.equal(receipt.resourceUrl,f.repository.url+'/pull-requests/1');assert.equal(receipt.commitSha,null);assert.equal(f.data.writes,1);
  const wire=JSON.parse(f.data.calls.find(c=>c.method==='POST').body);
  assert.deepEqual(wire,{title:op.payload.title,description:reviewRequestContent(op).body,source:{branch:{name:'feature/work'}},destination:{branch:{name:'main'}},draft:false,close_source_branch:false});
  assert.deepEqual(new Set(f.data.calls.filter(c=>c.path==='/pullrequests'&&c.method==='GET').map(c=>new URL(c.url).searchParams.get('state'))),new Set(['OPEN','MERGED','DECLINED','SUPERSEDED']));
  assert.equal((await f.executor.reconcile(op)).status,'succeeded');assert.equal(f.data.writes,1);
});
test('Bitbucket identity, fork, refs, commit, URL, draft and exact content substitutions stay unconfirmed',async()=>{
  for(const change of [
    f=>{f.data.uuid=uuid(9);}, f=>{f.data.workspace=uuid(9);},f=>{f.data.head='c'.repeat(40);},f=>{f.data.base='c'.repeat(40);},
    (_f,r)=>{r.source.repository.uuid=uuid(9);},(_f,r)=>{r.destination.repository.full_name='other/repo';},
    (_f,r)=>{r.source.branch.name='other';},(_f,r)=>{r.destination.commit.hash='c'.repeat(40);},
    (_f,r)=>{r.links.html.href+='?other=1';},(_f,r)=>{r.draft=true;},(_f,r)=>{r.title='changed';},(_f,r)=>{r.description='changed';},
  ]){const f=await fixture(),op=await f.operation();f.data.afterPost=r=>change(f,r);await assert.rejects(f.executor.dispatch(op,deadline));assert.equal((await f.executor.reconcile(op)).status,'unknown');assert.equal(f.data.writes,1);}
});
test('Bitbucket lost response reconciliation recognizes creation in closed states without merging or resending',async()=>{
  for(const state of ['OPEN','MERGED','DECLINED','SUPERSEDED']){
    const f=await fixture(),op=await f.operation();f.data.afterPost=r=>{r.state=state;throw new Error('lost response');};
    await assert.rejects(f.executor.dispatch(op,deadline));const outcome=await f.executor.reconcile(op);
    assert.equal(outcome.status,'succeeded');assert.equal(outcome.receipt.commitSha,null);assert.equal(f.data.writes,1);
    await assert.rejects(f.executor.dispatch(op,deadline));assert.equal(f.data.writes,1);
  }
});
test('Bitbucket absence, multiple operation markers and HTTP timeout remain unknown without retries',async()=>{
  const f=await fixture(),op=await f.operation();
  f.data.respond=async(_u,_p,o)=>o.method==='POST'?(f.data.writes++,new Promise(()=>{})):undefined;
  await assert.rejects(f.executor.dispatch(op,deadline));assert.equal((await f.executor.reconcile(op)).status,'unknown');assert.equal(f.data.writes,1);
  const g=await fixture(),next=await g.operation();await g.executor.dispatch(next,deadline);
  g.data.reviews.push({...g.data.reviews[0],id:2,links:{html:{href:g.repository.url+'/pull-requests/2'}}});
  assert.equal((await g.executor.reconcile(next)).status,'unknown');assert.equal(g.data.writes,1);
});
test('Bitbucket JSON pagination rejects hostile origin/path/filter/state/page-size, duplicate IDs and cycles',async()=>{
  for(const mutate of [
    u=>{u.hostname='evil.example';},u=>{u.pathname='/2.0/repositories/other/repo/pullrequests';},
    u=>{u.searchParams.set('q','state="OPEN"');},u=>{u.searchParams.set('state','MERGED');},
    u=>{u.searchParams.set('pagelen','1');},u=>{u.searchParams.append('q','extra');},
    u=>{u.hash='fragment';},u=>{u.searchParams.set('fields','values.id');},
  ]){
    const f=await fixture();f.data.respond=async(u,p)=>{if(p!=='/pullrequests')return;const next=new URL(u);next.searchParams.set('page','2');mutate(next);return Response.json({values:[{id:1,state:'OPEN'}],next:next.href});};
    await assert.rejects(f.executor.observe(f.target));assert.equal(f.data.writes,0);assert.equal(f.data.calls.some(c=>c.url.includes('evil.example')),false);assert.equal(f.data.calls.filter(c=>c.path==='/pullrequests').length,1);
  }
  const f=await fixture();f.data.respond=async(u,p)=>p==='/pullrequests'?Response.json({values:[],next:u.href}):undefined;
  await assert.rejects(f.executor.observe(f.target));assert.equal(f.data.writes,0);
});
test('Bitbucket missing source branch reports publication prerequisite without writing',async()=>{
  const f=await fixture();f.data.respond=async(_u,p)=>p.includes('/refs/branches/')?Response.json({}, {status:404}):undefined;
  await assert.rejects(f.executor.observe(f.target),{code:'ERR_DELIVERY_BRANCH_NOT_PUBLISHED'});assert.equal(f.data.writes,0);
});

async function commandFixture(t){
  const f=await fixture();const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
  const {resolveStatePaths}=await import('../../src/state/paths.js');const {createDeliveryStore}=await import('../../src/delivery/store.js');const {createDeliveryService}=await import('../../src/delivery/service.js');
  const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');const {createApprovalRegistry}=await import('../../src/policy/approvals.js');
  const root=await mkdtemp(join(tmpdir(),'rivet-bitbucket-command-'));t.after(()=>rm(root,{recursive:true,force:true}));execFileSync('git',['init','-q',root]);
  const paths=await resolveStatePaths(root,'review-one'),store=createDeliveryStore(paths),{headSha,reviewNumber,...initial}=f.target;
  await createDeliveryService({store,executor:f.executor,providerId:'repository',subjectId:'delivery-cli',expectedApproverId:'terminal-human',
    authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:[],providers:[],ownedPaths:[],commands:[]}),approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})}).initialize({...initial,localVerification:{...initial.localVerification,verifiedAt:new Date(Date.now()-1000).toISOString()}});
  const config={project:{id:'demo'},providers:{providers:[{id:'repository',kind:'git-ci',mode:'read-write-with-approval',transport:'direct-api',capabilities:['repository-read','review-request'],projectIds:['demo'],resourceIds:['team/repo'],endpoint:'https://api.bitbucket.org/2.0',credentials:{accessTokenEnv:'RIVET_TEST_TOKEN'}}]}};
  const calls={local:0,confirm:0};
  const input={action:'review',store,config,flags:{},validateLocal:async()=>{calls.local++;},dependencies:{env:{RIVET_TEST_TOKEN:'dummy-fixture-value'},terminalIsInteractive:()=>true,output:{log(){}},confirmDelivery:async()=>{calls.confirm++;return true;},delivery:{transport:f.transport,executorFactory:()=>assert.fail('must not route to merge executor')}}};
  return {...f,input,calls,store,paths,createDeliveryStore};
}
test('Bitbucket CLI creates review with bearer access token and supports durable read-only reconciliation',async t=>{
  const {runRemoteDelivery}=await import('../../src/commands/delivery-remote.js');const f=await commandFixture(t);
  f.data.afterPost=()=>{throw new Error('lost response');};
  let saved=await runRemoteDelivery(f.input);assert.equal(saved.operations[0].state,'indeterminate');assert.equal(f.data.writes,1);
  await assert.rejects(runRemoteDelivery(f.input));assert.equal(f.data.writes,1);
  f.input.store=f.createDeliveryStore(f.paths);f.input.config.providers.providers[0].mode='read-only';
  saved=await runRemoteDelivery({...f.input,action:'reconcile'});
  assert.equal(saved.stage,'review-requested');assert.equal(saved.operations[0].receipt.commitSha,null);assert.equal(f.data.writes,1);assert.equal(f.calls.confirm,1);
  assert.equal(f.calls.local,3);
  assert.equal(f.data.calls.every(call=>call.headers.authorization==='Bearer dummy-fixture-value'),true);
  const writeIndex=f.data.calls.findIndex(call=>call.method==='POST');assert.equal(f.data.calls.slice(writeIndex+1).every(call=>call.method==='GET'),true);
});
test('Bitbucket CLI rejects unsupported auth families, scopes, configuration drift, unattended writes and native merge/deploy',async t=>{
  const {runRemoteDelivery}=await import('../../src/commands/delivery-remote.js');
  for(const change of [
    f=>{f.input.config.providers.providers[0].credentials={apiTokenEnv:'RIVET_TEST_TOKEN'};},f=>{f.input.config.providers.providers[0].credentials={tokenEnv:'RIVET_TEST_TOKEN'};},
    f=>{f.input.config.providers.providers[0].capabilities=['repository-read'];},f=>{f.input.config.providers.providers[0].resourceIds=['other/repo'];},
    f=>{f.input.dependencies.terminalIsInteractive=()=>false;},f=>{f.input.dependencies.confirmDelivery=async()=>false;},
    f=>{f.input.action='merge';},f=>{f.input.action='deploy';},
    f=>{f.input.reloadConfig=async()=>{const c=structuredClone(f.input.config);c.providers.providers[0].mode='read-only';return c;};},
  ]){const f=await commandFixture(t);change(f);await assert.rejects(runRemoteDelivery(f.input));assert.equal(f.data.writes,0);}
});

test('Bitbucket walks JSON next pages for marked reviews but rejects duplicate IDs and global page overflow',async()=>{
  const f=await fixture(),op=await f.operation();await f.executor.dispatch(op,deadline);
  f.data.respond=async(u,p)=>{
    if(p!=='/pullrequests'||u.searchParams.get('state')!=='OPEN')return;
    if(u.searchParams.get('page')==='2')return Response.json({values:f.data.reviews});
    const next=new URL(u);next.searchParams.set('page','2');return Response.json({values:[{...f.data.reviews[0],id:2,description:'An older unmarked review'}],next:next.href});
  };
  assert.equal((await f.executor.reconcile(op)).status,'succeeded');assert.equal(f.data.writes,1);
  f.data.respond=async(u,p)=>{
    if(p!=='/pullrequests')return;const next=new URL(u);next.searchParams.set('page',String(Number(u.searchParams.get('page')??'1')+1));
    return Response.json({values:u.searchParams.get('state')==='OPEN'?f.data.reviews:[],next:next.href});
  };
  assert.equal((await f.executor.reconcile(op)).status,'unknown');
  const g=await fixture();g.data.respond=async(u,p)=>{
    if(p!=='/pullrequests')return;const next=new URL(u);next.searchParams.set('page',String(Number(u.searchParams.get('page')??'1')+1));return Response.json({values:[{id:Number(u.searchParams.get('page')??'1'),state:'OPEN'}],next:next.href});
  };
  await assert.rejects(g.executor.observe(g.target));assert.equal(g.data.calls.filter(c=>c.path==='/pullrequests').length,20);
});
test('Bitbucket readback verifies source deletion remains disabled',async()=>{
  const f=await fixture(),op=await f.operation();f.data.afterPost=row=>{row.close_source_branch=true;};
  await assert.rejects(f.executor.dispatch(op,deadline));assert.equal((await f.executor.reconcile(op)).status,'unknown');assert.equal(f.data.writes,1);
});

test('Bitbucket review creation preserves an earlier confirmed branch publication',async t=>{
  const f=await commandFixture(t),{createDeliveryService,createTrustedDeliveryExecutor}=await import('../../src/delivery/service.js');
  const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');
  const {createApprovalRegistry,createApprovalReceipt}=await import('../../src/policy/approvals.js');
  const before=await f.store.read(),publication={destinationUrl:f.repository.url+'.git',ref:'refs/heads/feature/work',remoteSha:null};
  const executor=createTrustedDeliveryExecutor({provider:'bitbucket',capabilities:[{action:'branch-publish',conditionalHead:true,reconcile:true}],
    observe:async c=>({...await f.executor.observe(c),publication,observedAt:new Date().toISOString()}),
    dispatch:async op=>({status:'succeeded',operationDigest:op.digest,headSha:head,evidenceDigest:'d'.repeat(64),resourceUrl:f.repository.url,commitSha:head}),reconcile:async()=>({status:'unknown'})});
  const service=createDeliveryService({store:f.store,executor,providerId:'repository',subjectId:'delivery-cli',expectedApproverId:'terminal-human',
    authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:['provider.write'],ownedPaths:[],commands:[],providers:[{id:'repository',mode:'read-write-with-approval',capabilities:['branch-publish']}]}),
    approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
  let state=await service.refresh({expectedVersion:before.version});const expiresAt=new Date(Date.now()+60000).toISOString();
  state=await service.propose({expectedVersion:state.version,action:'branch-publish',payload:{destinationUrl:publication.destinationUrl,ref:publication.ref,headSha:head},expiresAt});
  const approval=createApprovalReceipt({id:'publish-approval',approverId:'terminal-human',approverPrincipal:'human',subjectId:'delivery-cli',action:'provider.write',resource:state.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt,singleUse:true});
  state=await service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval});assert.equal(state.stage,'branch-published');
  const published=state.operations[0];const {runRemoteDelivery}=await import('../../src/commands/delivery-remote.js');
  state=await runRemoteDelivery(f.input);assert.equal(state.stage,'review-requested');assert.deepEqual(state.operations[0],published);
  assert.equal(state.operations[1].action,'review-request');assert.equal(f.data.writes,1);
});

test('Bitbucket accepts documented raw summary/rendered body and rejects conflicting or HTML-only representations',async()=>{
  for(const representation of ['summary','rendered']){
    const f=await fixture(),op=await f.operation();f.data.afterPost=row=>{if(representation==='summary')row.summary={raw:row.description};else row.rendered={description:{raw:row.description}};delete row.description;};
    assert.equal((await f.executor.dispatch(op,deadline)).status,'succeeded');assert.equal((await f.executor.reconcile(op)).status,'succeeded');
  }
  for(const change of [row=>{row.summary={raw:'different'};},row=>{row.summary={html:row.description};delete row.description;},row=>{row.rendered={description:{raw:'different'}};}]){
    const f=await fixture(),op=await f.operation();f.data.afterPost=change;await assert.rejects(f.executor.dispatch(op,deadline));assert.equal((await f.executor.reconcile(op)).status,'unknown');
  }
});

test('Bitbucket rejects inconsistent JSON pagination totals and page-size evidence',async()=>{
  for(const result of [{values:[],size:1},{values:[],size:1001},{values:[],size:-1},{values:[],size:'0'},{values:[],pagelen:1}]){
    const f=await fixture();f.data.respond=async(_u,p)=>p==='/pullrequests'?Response.json(result):undefined;
    await assert.rejects(f.executor.observe(f.target));assert.equal(f.data.writes,0);
  }
  const f=await fixture();f.data.respond=async(u,p)=>{
    if(p!=='/pullrequests')return;
    if(u.searchParams.get('page'))return Response.json({values:[{id:2,state:'OPEN'}],size:2});
    const next=new URL(u);next.searchParams.set('page','2');return Response.json({values:[{id:1,state:'OPEN'}],size:1,next:next.href});
  };
  await assert.rejects(f.executor.observe(f.target));assert.equal(f.data.writes,0);
});

test('Bitbucket rejects skipped or inconsistent pages and empty pages advertising further results',async()=>{
  for(const mode of ['skip','missing-page','response-page','empty-next']){
    const f=await fixture();f.data.respond=async(u,p)=>{
      if(p!=='/pullrequests')return;
      const next=new URL(u);if(mode!=='missing-page')next.searchParams.set('page',mode==='skip'?'3':'2');
      return Response.json({values:mode==='empty-next'?[]:[{id:1,state:'OPEN'}],next:next.href,...(mode==='response-page'?{page:3}:{})});
    };
    await assert.rejects(f.executor.observe(f.target));assert.equal(f.data.calls.filter(c=>c.path==='/pullrequests').length,1,mode);
    assert.equal(f.data.writes,0);
  }
});
