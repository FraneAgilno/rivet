import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';
import { createGithubDeploymentExecutor } from '../../src/delivery/github-deployment.js';
const head='a'.repeat(40), merged='b'.repeat(40), blob='c'.repeat(40), digest='d'.repeat(64);
const at='2026-09-25T10:00:00.000Z';
const repository={provider:'github',host:'github.com',namespace:'team',name:'repo',fullName:'team/repo',url:'https://github.com/team/repo'};
const deployment={providerId:'github-primary',workflow:'deploy.yml',environment:'staging',productionEnvironment:false};
const mergeReceipt={status:'succeeded',operationDigest:'e'.repeat(64),headSha:head,evidenceDigest:digest,resourceUrl:repository.url+'/pull/7',commitSha:merged};
const target=candidate({runId:'run-one',repository,sourceBranch:'feature',targetBranch:'main',localVerification:{runId:'run-one',headSha:head,evidenceDigest:digest,verifiedAt:at,status:'passed'}});
function fixture(change=()=>{}) {
 const data={calls:[], now:at,
  pull:{number:7,state:'closed',merged:true,merge_commit_sha:merged,html_url:repository.url+'/pull/7',head:{sha:head,ref:'feature',repo:{full_name:'team/repo'}},base:{sha:merged,ref:'main',repo:{full_name:'team/repo'}}},
  workflow:{id:42,state:'active',path:'.github/workflows/deploy.yml'},
  file:{type:'file',path:'.github/workflows/deploy.yml',sha:blob},
  deployments:[{id:123,sha:merged,ref:merged,task:'rivet-deploy',environment:'staging',production_environment:false,transient_environment:false,repository_url:'https://api.github.com/repos/team/repo',payload:{rivetOperation:digest,workflow:'deploy.yml'}}],
  statuses:[{id:321,state:'success',environment:'staging',log_url:repository.url+'/actions/runs/456'}],
  run:{id:456,status:'completed',conclusion:'success',head_sha:merged,workflow_id:42,event:'deployment',repository:{full_name:'team/repo'},display_title:`rivet-deploy:${digest}`,html_url:repository.url+'/actions/runs/456'}};
 change(data);
 const transport=createTrustedProviderTransport({resolve:async()=>{await data.resolve?.();return ['93.184.216.34']},fetchPinned:async(url,options)=>{
  const parsed=new URL(url),path=parsed.pathname.replace('/repos/team/repo','');data.calls.push({path,url,...options});
  const override=await data.respond?.(path,options);if(override)return override;
  if(options.method==='POST')return Response.json(data.deployments[0],{status:201});
  const value=path==='/pulls/7'?data.pull:path==='/actions/workflows/deploy.yml'?data.workflow:path==='/contents/.github/workflows/deploy.yml'?data.file:path==='/deployments'?data.deployments:path==='/deployments/123/statuses'?data.statuses:path==='/actions/runs/456'?data.run:undefined;
  assert.notEqual(value,undefined,path);return Response.json(value);
 }});
 const executor=createGithubDeploymentExecutor({repository,deployment,mergeReceipt,transport,clock:()=>data.now,timeoutMs:100});
 return {data,executor};
}
async function operation(f){return {action:'deploy',digest,candidate:target,mergeReceipt,payload:{workflow:'deploy.yml',environment:'staging',productionEnvironment:false},factsDigest:factsDigest(await f.executor.observe(target))};}
const deadline={deadline:'2026-09-25T10:01:00.000Z'};
test('dispatch pins deployment to merged SHA and only succeeds with deployment status plus matching verified Actions run',async()=>{
 const f=fixture(),op=await operation(f),receipt=await f.executor.dispatch(op,deadline);
 assert.equal(receipt.commitSha,merged);assert.equal(receipt.headSha,head);assert.equal(receipt.resourceUrl,repository.url+'/actions/runs/456');
 const calls=f.data.calls.filter(c=>c.method==='POST');assert.equal(calls.length,1);
 assert.deepEqual(JSON.parse(calls[0].body),{ref:merged,auto_merge:false,task:'rivet-deploy',environment:'staging',production_environment:false,transient_environment:false,payload:{rivetOperation:digest,workflow:'deploy.yml'}});
 assert.ok(f.data.calls.some(c=>c.path.startsWith('/contents/')&&new URL(c.url).searchParams.get('ref')===merged));
});
test('reconciliation is read only and cannot infer not-applied from absence',async()=>{
 const f=fixture(),op=await operation(f);assert.equal((await f.executor.reconcile(op)).status,'succeeded');
 f.data.deployments=[];assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});assert.ok(f.data.calls.every(c=>c.method==='GET'));
});
test('missing or mismatching remote deployment and workflow evidence remains unknown',async()=>{
 for(const mutate of [d=>d.deployments.push({...d.deployments[0],id:124}),d=>d.deployments[0].sha=head,d=>d.deployments[0].ref='main',d=>d.deployments[0].environment='production',d=>d.deployments[0].production_environment=true,d=>d.deployments[0].payload.rivetOperation='f'.repeat(64),d=>d.deployments[0].payload.workflow='other.yml',d=>d.statuses[0].state='failure',d=>d.statuses[0].log_url='https://evil.example/actions/runs/456',d=>d.run.head_sha=head,d=>d.run.workflow_id=41,d=>d.run.display_title='Unrelated run',d=>d.run.event='push',d=>d.run.conclusion='failure',d=>d.run.status='in_progress',d=>d.run.repository.full_name='other/repo',d=>d.workflow.state='disabled_manually',d=>d.file.path='other']){
  const f=fixture(),op=await operation(f);mutate(f.data);assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
 }
});
test('201 acceptance alone is indeterminate and never retried by dispatch',async()=>{
 const f=fixture(),op=await operation(f);f.data.statuses=[];await assert.rejects(f.executor.dispatch(op,deadline));
 assert.equal(f.data.calls.filter(c=>c.method==='POST').length,1);assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
});
test('changed workflow blob, merge receipt, or payload prevents external dispatch',async()=>{
 for(const mutate of [(f,op)=>{f.data.file.sha=head},(f,op)=>{op.mergeReceipt={...mergeReceipt,commitSha:head}},(f,op)=>{op.payload.environment='production'}]){
  const f=fixture(),op=await operation(f);mutate(f,op);await assert.rejects(f.executor.dispatch(op,deadline));assert.equal(f.data.calls.filter(c=>c.method==='POST').length,0);
 }
});
test('expired deadline prevents POST and transport failures do not expose credentials',async()=>{
 const f=fixture(),op=await operation(f);await assert.rejects(f.executor.dispatch(op,{deadline:at}));
 f.data.respond=async(path,options)=>{if(options.method==='POST')throw new Error('secret-credential')};
 await assert.rejects(f.executor.dispatch(op,deadline),error=>!error.message.includes('secret-credential'));
 assert.equal(f.data.calls.filter(c=>c.method==='POST').length,1);
});

test('latest deployment status controls outcome even if older status succeeded',async()=>{
 const f=fixture(),op=await operation(f);
 f.data.statuses.push({...f.data.statuses[0],id:322,state:'in_progress'});
 assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
});
test('deadline aborts DNS before POST and timeout never retries an uncertain write',async()=>{
 const f=fixture(),op=await operation(f);let resolves=0;
 f.data.resolve=async()=>{if(++resolves===4)await new Promise(resolve=>setTimeout(resolve,60))};
 await assert.rejects(f.executor.dispatch(op,{deadline:'2026-09-25T10:00:00.020Z'}));
 assert.equal(f.data.calls.filter(c=>c.method==='POST').length,0);
 const g=fixture(),other=await operation(g);
 g.data.respond=async(path,options)=>{if(options.method==='POST')await new Promise(resolve=>setTimeout(resolve,160))};
 await assert.rejects(g.executor.dispatch(other,deadline));
 assert.equal(g.data.calls.filter(c=>c.method==='POST').length,1);
});
test('deployment configuration rejects accessors and unsafe identifiers before network use',()=>{
 let invoked=false;
 for(const config of [{...deployment,workflow:'../deploy.yml'},{...deployment,environment:'staging?token=secret'},
  {...deployment,productionEnvironment:'false'},{...deployment,extra:true},
  {...deployment,get workflow(){invoked=true;return 'deploy.yml'}}]){
  assert.throws(()=>createGithubDeploymentExecutor({repository,deployment:config,mergeReceipt,transport:{}}));
 }
 assert.equal(invoked,false);
});
test('wire deployment payload rejects check bypass, moving refs, changed digest, and extra fields',async()=>{
 const {createProviderWireBody}=await import('../../src/adapters/contract.js');
 const base={provider:'github',action:'deploy',resourceId:'team/repo',expectedState:'merged',expectedVersion:merged,idempotencyKey:digest,
  payload:{ref:merged,auto_merge:false,task:'rivet-deploy',environment:'staging',production_environment:false,transient_environment:false,payload:{rivetOperation:digest,workflow:'deploy.yml'}}};
 assert.ok(createProviderWireBody(base));
 for(const mutate of [v=>v.payload.ref='main',v=>v.payload.required_contexts=[],v=>v.payload.auto_merge=true,v=>v.payload.task='deploy',
  v=>v.payload.payload.rivetOperation='f'.repeat(64),v=>v.payload.payload.extra=true,v=>v.payload.payload.workflow='../evil.yml',v=>v.expectedState='open']){
  const value=structuredClone(base);mutate(value);assert.throws(()=>createProviderWireBody(value));
 }
});
