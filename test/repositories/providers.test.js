import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import * as api from '../../src/repositories/index.js';
const SHA='a'.repeat(40), OTHER='b'.repeat(40), NOW='2026-09-25T10:00:00.000Z';
function fixture(provider) {
  const host={github:'github.com',bitbucket:'bitbucket.org',gitlab:'gitlab.com'}[provider];
  const name=provider==='gitlab'?'team/sub/repo':'team/repo';
  const repository=api.parseRepositoryRemote(`https://${host}/${name}`);
  const root={github:`/repos/${name}`,bitbucket:`/2.0/repositories/${name}`,gitlab:`/api/v4/projects/${encodeURIComponent(name)}`}[provider];
  const reviewPath={github:`${root}/pulls/7`,bitbucket:`${root}/pullrequests/7`,gitlab:`${root}/merge_requests/7`}[provider];
  const review={github:{number:7,state:'open',merged:false,title:'Task',head:{sha:SHA,ref:'feature'},base:{ref:'main',sha:OTHER},html_url:`${repository.url}/pull/7`},bitbucket:{id:7,state:'OPEN',title:'Task',source:{commit:{hash:SHA},branch:{name:'feature'}},destination:{branch:{name:'main'},repository:{full_name:name}},links:{html:{href:`${repository.url}/pull-requests/7`}},participants:[{user:{uuid:'reviewer'},approved:true,state:'approved'}]},gitlab:{iid:7,state:'opened',title:'Task',sha:SHA,source_branch:'feature',target_branch:'main',web_url:`${repository.url}/-/merge_requests/7`}}[provider];
  const repo={github:{id:1,full_name:name,default_branch:'main',private:true,html_url:repository.url},bitbucket:{uuid:'{repo-id}',full_name:name,mainbranch:{name:'main'},is_private:true,links:{html:{href:repository.url}}},gitlab:{id:1,path_with_namespace:name,default_branch:'main',visibility:'private',web_url:repository.url}}[provider];
  const checksPath={github:`${root}/commits/${SHA}/check-runs`,bitbucket:`${root}/commit/${SHA}/statuses`,gitlab:`${root}/repository/commits/${SHA}/statuses`}[provider];
  const checks={github:{total_count:1,check_runs:[{id:1,name:'test',head_sha:SHA,status:'completed',conclusion:'success'}]},bitbucket:{values:[{key:'test',name:'test',state:'SUCCESSFUL',links:{commit:{href:`https://api.bitbucket.org/2.0/repositories/${name}/commit/${SHA}`}}}]},gitlab:[{id:1,name:'test',sha:SHA,status:'success'}]}[provider];
  const responses=new Map([[root,repo],[reviewPath,review],[checksPath,checks]]);
  if(provider==='github') {
    responses.set(`${root}/pulls/7/reviews`,[{id:1,state:'APPROVED',user:{login:'reviewer'},commit_id:OTHER}]);
    responses.set(`${root}/commits/${SHA}/statuses`,[{id:2,context:'legacy',state:'success',sha:SHA}]);
    responses.set(`${root}/branches/feature`,{name:'feature',commit:{sha:SHA},protected:false});
  } else if(provider==='gitlab') {
    responses.set(`${root}/merge_requests/7/approvals`,{id:100,iid:7,approved_by:[{user:{id:1,username:'reviewer'}}]});
    responses.set(`${root}/repository/branches/feature`,{name:'feature',commit:{id:SHA},protected:false});
  } else responses.set(`${root}/refs/branches/feature`,{name:'feature',target:{hash:SHA}});
  const calls=[];
  let handler=url=>({data:responses.get(new URL(url).pathname)});
  function create(options={}) {
    assert.equal(typeof api.createRepositoryProvider,'function');
    return api.createRepositoryProvider({repository,clock:()=>NOW,...options,transport:createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{calls.push({url,init});const value=handler(url,init);assert.notEqual(value.data,undefined,new URL(url).pathname);return new Response(JSON.stringify(value.data),{status:value.status??200,headers:value.headers});}})});
  }
  return {repository,root,reviewPath,checksPath,responses,calls,review,checks,create,setHandler(value){handler=value;}};
}
for(const provider of ['github','bitbucket','gitlab']) {
  test(`${provider}: common read contract and honest read-only capabilities`,async()=>{
    const f=fixture(provider), p=f.create();
    const info=await p.read({kind:'repository'});
    assert.equal(info.repository.fullName,f.repository.fullName);
    assert.equal(info.repository.defaultBranch,'main');
    assert.equal(info.observedAt,NOW);
    assert.deepEqual(p.capabilities.write,[]);
    assert.throws(()=>p.write({}),{code:'ERR_PROVIDER_READ_ONLY'});
    const branch=await p.read({kind:'branch',branch:'feature'});
    assert.equal(branch.branch.commitSha,SHA);
    const result=await p.inspect({number:7});
    assert.equal(result.reviewRequest.headSha,SHA);
    assert.equal(result.reviewRequest.state,'open');
    assert.equal(result.checks.commitSha,SHA);
    assert.equal(result.checks.items[0].state,'success');
    assert.equal(result.checks.requiredPolicy,'unknown');
    assert.equal(result.reviews.policy,'unknown');
    assert.equal(result.reviews.items[0].commitSha,provider==='github'?OTHER:null);
    assert.equal(result.consistency,'head-rechecked');
    assert.ok(f.calls.every(call=>call.init.method==='GET'));
  });
  test(`${provider}: rejects stale check evidence for another SHA`,async()=>{
    const f=fixture(provider);
    if(provider==='github') f.checks.check_runs[0].head_sha=OTHER;
    if(provider==='gitlab') f.checks[0].sha=OTHER;
    if(provider==='bitbucket') f.checks.values[0].links.commit.href=f.checks.values[0].links.commit.href.replace(SHA,OTHER);
    await assert.rejects(f.create().read({kind:'checks',commitSha:SHA}),{code:'ERR_PROVIDER_STATE_CONFLICT'});
  });
  for(const status of [401,403,404,429,503]) test(`${provider}: HTTP ${status} fails safely without retries or raw error content`,async()=>{
    const f=fixture(provider); f.setHandler(()=>({data:{message:'secret-token'},status}));
    await assert.rejects(f.create().read({kind:'repository'}),e=>e.status===status&&!e.message.includes('secret-token')&&e.retryClassification===(status===429||status===503?'transient':'permanent'));
    assert.equal(f.calls.length,1);
  });
  test(`${provider}: detects review head changes during inspection`,async()=>{
    const f=fixture(provider);let reads=0;
    f.setHandler(url=>{const path=new URL(url).pathname;const data=structuredClone(f.responses.get(path));if(path===f.reviewPath&&++reads>1){if(provider==='github')data.head.sha=OTHER;else if(provider==='bitbucket')data.source.commit.hash=OTHER;else data.sha=OTHER;}return {data};});
    await assert.rejects(f.create().inspect({number:7}),{code:'ERR_PROVIDER_STATE_CONFLICT'});
  });
  test(`${provider}: deleted branch is a typed failure, not an empty success`,async()=>{
    const f=fixture(provider);f.setHandler(()=>({data:{},status:404}));
    await assert.rejects(f.create().read({kind:'branch',branch:'deleted'}),e=>e.status===404);
  });
}
test('Bitbucket pagination cannot change origin, endpoint or SHA',async()=>{
  for(const next of ['https://evil.example/x','https://api.bitbucket.org/2.0/repositories/team/other/commit/'+SHA+'/statuses?page=2&pagelen=100','https://api.bitbucket.org/2.0/repositories/team/repo/commit/'+OTHER+'/statuses?page=2&pagelen=100']) {
    const f=fixture('bitbucket');f.checks.next=next;
    await assert.rejects(f.create().read({kind:'checks',commitSha:SHA}));
    assert.equal(f.calls.length,1);
  }
});
test('Bitbucket paginates bounded commit statuses and detects page exhaustion',async()=>{
  const f=fixture('bitbucket'); f.checks.next=`https://api.bitbucket.org${f.checksPath}?pagelen=100&page=2`;
  f.setHandler(url=>({data:new URL(url).searchParams.get('page')==='2'?{values:[{key:'other',state:'FAILED'}]}:f.checks}));
  assert.equal((await f.create().read({kind:'checks',commitSha:SHA})).checks.items.length,2);
  await assert.rejects(f.create({maxPages:1}).read({kind:'checks',commitSha:SHA}),{code:'ERR_PROVIDER_PAGINATION_LIMIT'});
});
test('GitLab follows bounded same-endpoint Link pagination',async()=>{
  const f=fixture('gitlab');f.setHandler(url=>({data:new URL(url).searchParams.get('page')==='2'?[{id:2,name:'other',sha:SHA,status:'failed'}]:f.checks,headers:new URL(url).searchParams.get('page')==='2'?{}:{link:`<https://gitlab.com${f.checksPath}?per_page=100&page=2>; rel="next"`}}));
  const result=await f.create().read({kind:'checks',commitSha:SHA});assert.equal(result.checks.items.length,2);
});
test('rejects forged identity, unrecognized options, and MCP transport',()=>{
  const f=fixture('gitlab');assert.throws(()=>f.create({repository:{...f.repository,provider:'github'}}));
  assert.throws(()=>f.create({baseUrl:'https://other.example'}));
  assert.throws(()=>f.create({mode:'harness-mcp'}));
});
for(const provider of ['github','bitbucket','gitlab']) test(`${provider}: reads branch names containing slash without permitting traversal`,async()=>{
  const f=fixture(provider);f.setHandler(url=>({data:provider==='github'?{name:'feature/task',commit:{sha:SHA},protected:false}:provider==='gitlab'?{name:'feature/task',commit:{id:SHA},protected:false}:{name:'feature/task',target:{hash:SHA}}}));
  assert.equal((await f.create().read({kind:'branch',branch:'feature/task'})).branch.commitSha,SHA);
  assert.ok(f.calls[0].url.includes('feature%2Ftask'));
  await assert.rejects(f.create().read({kind:'branch',branch:'feature/../task'}));
});
test('Bitbucket pagination rejects inconsistent declared size, skipped pages and duplicate statuses',async()=>{
  for(const change of [data=>{data.size=3;},data=>{data.next=`https://api.bitbucket.org/2.0/repositories/team/repo/commit/${SHA}/statuses?pagelen=100&page=3`;},data=>{data.values.push({...data.values[0]});}]) {
    const f=fixture('bitbucket');change(f.checks);await assert.rejects(f.create().read({kind:'checks',commitSha:SHA}));
  }
});
for(const provider of ['github','bitbucket','gitlab']) test(`${provider}: malformed check/review rows return typed remote errors`,async()=>{
  const f=fixture(provider);
  if(provider==='github')f.checks.check_runs=[null];
  else if(provider==='bitbucket')f.checks.values=[null];
  else f.responses.set(f.checksPath,[null]);
  await assert.rejects(f.create().read({kind:'checks',commitSha:SHA}),{code:'ERR_PROVIDER_REMOTE'});
  if(provider==='github') f.responses.set(`${f.root}/pulls/7/reviews`,[null]);
  else if(provider==='bitbucket')f.review.participants=[null];
  else f.responses.set(`${f.root}/merge_requests/7/approvals`,{iid:7,approved_by:[null]});
  await assert.rejects(f.create().read({kind:'reviews',number:7}),{code:'ERR_PROVIDER_REMOTE'});
});
