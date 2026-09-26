import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitPublicationTransport, publicationAuthorization } from '../../src/delivery/publication-transport.js';
import { createBranchPublicationExecutor } from '../../src/delivery/branch-publication.js';
import { runPublicationProcess } from '../../src/delivery/publication-process.js';
import { candidate, hash, observation, factsDigest } from '../../src/delivery/contract.js';
const repository={provider:'github',host:'github.com',namespace:'team',name:'repo',fullName:'team/repo',url:'https://github.com/team/repo'};
const git=(root,args)=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-publication-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),remote=join(root,'remote.git');await mkdir(source);
 git(root,['init','--bare','--initial-branch=main',remote]);git(source,['init','--initial-branch=main']);
 git(source,['config','user.name','Fixture']);git(source,['config','user.email','fixture@example.invalid']);
 await writeFile(join(source,'a.txt'),'base');git(source,['add','.']);git(source,['commit','-m','base']);
 const base=git(source,['rev-parse','HEAD']);git(source,['push',remote,'HEAD:refs/heads/main']);
 await writeFile(join(source,'b.txt'),'feature');git(source,['add','.']);git(source,['commit','-m','feature']);const head=git(source,['rev-parse','HEAD']);
 const target=candidate({runId:'run-one',repository,sourceBranch:'rivet/feature',targetBranch:'main',localVerification:{runId:'run-one',headSha:head,evidenceDigest:'a'.repeat(64),verifiedAt:new Date().toISOString(),status:'passed'}});
 const calls=[];
 const runner=async (executable,args,options)=>{calls.push({args,env:options.env});return runPublicationProcess(executable,args.map(a=>a===repository.url+'.git'?remote:a),{...options,env:{...options.env,GIT_ALLOW_PROTOCOL:'file'}});};
 const transport=await createGitPublicationTransport({gitExecutable:await realpath('/usr/bin/git'),sourceObjects:join(source,'.git','objects'),project:source,repository,token:'test-token',runner});
 return {root,source,remote,target,head,base,transport,calls};
}
test('publication creates only an absent exact ref from accepted SHA and ignores source hooks/config',async t=>{
 const f=await fixture(t);const marker=join(f.root,'bad-helper');
 git(f.source,['config','core.hooksPath',join(f.root,'hooks')]);await mkdir(join(f.root,'hooks'));await writeFile(join(f.root,'hooks','pre-push'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
 git(f.source,['config','credential.helper',`!touch '${marker}'`]);
 const before=await f.transport.readRefs(f.target);assert.equal(before.sourceSha,null);
 await f.transport.push(f.target,{deadline:new Date(Date.now()+10000).toISOString()});
 assert.equal((await f.transport.readRefs(f.target)).sourceSha,f.head);
 assert.equal(await readFile(marker).then(()=>true,()=>false),false);
 const push=f.calls.find(c=>c.args.includes('push'));
 assert(push.args.includes('--force-with-lease=refs/heads/rivet/feature:'));
 assert(push.args.includes(`${f.head}:refs/heads/rivet/feature`));
 assert(!JSON.stringify(push.args).includes('test-token'));
});
test('concurrent branch creation fails the empty expected lease and cannot overwrite',async t=>{
 const f=await fixture(t);git(f.source,['push',f.remote,`${f.base}:refs/heads/rivet/feature`]);
 await assert.rejects(()=>f.transport.push(f.target,{deadline:new Date(Date.now()+10000).toISOString()}));
 assert.equal((await f.transport.readRefs(f.target)).sourceSha,f.base);
});
test('publication executor confirms exact ref but missing uncertain outcome never authorizes resend',async()=>{
 let remoteSha=null,pushes=0;const target=candidate({runId:'run-one',repository,sourceBranch:'feature',targetBranch:'main',localVerification:{runId:'run-one',headSha:'a'.repeat(40),evidenceDigest:'b'.repeat(64),verifiedAt:new Date().toISOString(),status:'passed'}});
 const executor=createBranchPublicationExecutor({repository,transport:{readRefs:async()=>({sourceSha:remoteSha,baseSha:'c'.repeat(40)}),push:async()=>{pushes++;throw new Error('uncertain');}}});
 const facts=await executor.observe(target);assert.equal(observation(facts,target).publication.remoteSha,null);
 const operation={factsDigest:factsDigest(facts),action:'branch-publish',candidate:target,digest:'d'.repeat(64),payload:{destinationUrl:repository.url+'.git',ref:'refs/heads/feature',headSha:target.headSha}};
 await assert.rejects(()=>executor.dispatch(operation,{deadline:new Date(Date.now()+1000).toISOString()}));
 assert.deepEqual(await executor.reconcile(operation),{status:'unknown'});
 remoteSha=target.headSha;assert.equal((await executor.reconcile(operation)).receipt.commitSha,target.headSha);assert.equal(pushes,1);
});
test('Git authentication uses provider-specific Basic username and rejects invalid token inputs',()=>{
 for(const [provider,username] of [['github','x-access-token'],['gitlab','oauth2'],['bitbucket','x-token-auth']]) assert.equal(publicationAuthorization(provider,'token'),`Authorization: Basic ${Buffer.from(username+':token').toString('base64')}`);
 assert.throws(()=>publicationAuthorization('unknown','token'));assert.throws(()=>publicationAuthorization('github','token\nheader'));
});

test('ordinary Git commit graphs remain publishable while object alternates are rejected',async t=>{
 const f=await fixture(t);git(f.source,['commit-graph','write','--reachable']);
 await f.transport.push(f.target,{deadline:new Date(Date.now()+10000).toISOString()});
 assert.equal((await f.transport.readRefs(f.target)).sourceSha,f.head);
 await writeFile(join(f.source,'.git','objects','info','alternates'),f.remote+'/objects\n');
 await assert.rejects(()=>f.transport.readRefs(f.target));
});

async function deliveryFixture(t,{effect='success',approve=true,afterApproval}={}) {
 const f=await fixture(t);git(f.source,['remote','add','origin',repository.url+'.git']);
 const {resolveStatePaths}=await import('../../src/state/paths.js');const {createDeliveryStore}=await import('../../src/delivery/store.js');
 const {createDeliveryService}=await import('../../src/delivery/service.js');const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');const {createApprovalRegistry}=await import('../../src/policy/approvals.js');
 const store=createDeliveryStore(await resolveStatePaths(f.source,'publish-state'));
 let remoteSha=null,pushes=0,confirms=0,validations=0;
 const transport={readRefs:async()=>({sourceSha:remoteSha,baseSha:f.base}),push:async()=>{pushes++;if(effect==='success')remoteSha=f.head;else throw new Error('private-secret-do-not-persist');}};
 const executor=createBranchPublicationExecutor({repository,transport});
 const service=createDeliveryService({store,executor,providerId:'git-main',subjectId:'delivery-cli',expectedApproverId:'terminal-human',authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:[],ownedPaths:[],commands:[],providers:[]}),approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
 const {headSha,reviewNumber,...input}=f.target;await service.initialize(input);
 const config={project:{id:'demo'},providers:{providers:[{id:'git-main',kind:'git-ci',mode:'read-write-with-approval',transport:'direct-api',endpoint:'https://api.github.com',capabilities:['repository-read','branch-publish'],credentials:{tokenEnv:'PUBLICATION_TEST_TOKEN'}}]}};
 const {runRemoteDelivery}=await import('../../src/commands/delivery-remote.js');
 const output=[];
 const options={store,config,flags:{},publicationContext:{project:f.source,gitExecutable:await realpath('/usr/bin/git')},reloadConfig:async()=>config,validateLocal:async()=>{validations++;},dependencies:{env:{PUBLICATION_TEST_TOKEN:'fixture-token'},terminalIsInteractive:()=>true,confirmDelivery:async()=>{confirms++;await afterApproval?.({config,source:f.source});return approve;},output:{log:value=>output.push(value)},delivery:{publicationTransportFactory:async()=>transport}}};
 return {...f,store,config,options,output,run:action=>runRemoteDelivery({...options,action}),counts:()=>({pushes,confirms,validations}),remote:sha=>{remoteSha=sha;}};
}
test('interactive publication persists one receipt, refresh preserves stage and same SHA adds no operation',async t=>{
 const f=await deliveryFixture(t);const done=await f.run('publish');assert.equal(done.stage,'branch-published');assert.equal(done.operations[0].receipt.commitSha,f.head);assert.equal(f.counts().validations,2);
 const again=await f.run('publish');assert.equal(again.stage,'branch-published');assert.equal(again.operations.length,1);assert.equal(f.counts().pushes,1);assert.equal(f.counts().confirms,1);
});
test('decline, changed configuration, candidate and conflicting push URL cannot dispatch',async t=>{
 for(const kind of ['decline','config','candidate','push-url']) {
  const f=await deliveryFixture(t,{approve:kind!=='decline',afterApproval:async({config,source})=>{
    if(kind==='config')config.providers.providers[0].capabilities=[];
    if(kind==='push-url')git(source,['remote','set-url','--push','origin','https://github.com/other/repo.git']);
  }});
  if(kind==='candidate')f.options.validateLocal=async()=>{if(f.options.checked)throw new Error('changed');f.options.checked=true;};
  await assert.rejects(()=>f.run('publish'));assert.equal(f.counts().pushes,0);assert.equal((await f.store.read()).operations.length,0);
 }
});
test('indeterminate publication reopens read-only, absent stays pending and exact late effect reconciles once',async t=>{
 const f=await deliveryFixture(t,{effect:'unknown'});const pending=await f.run('publish');assert.equal(pending.operations[0].state,'indeterminate');
 assert.equal((await f.run('reconcile')).operations[0].state,'indeterminate');
 f.remote(f.head);const done=await f.run('reconcile');assert.equal(done.operations[0].state,'succeeded');assert.equal(done.stage,'branch-published');assert.equal(f.counts().pushes,1);
 assert(!JSON.stringify(done).includes('private-secret'));
});
test('existing identical branch succeeds without approval, write intent or fabricated receipt',async t=>{
 const f=await deliveryFixture(t);f.remote(f.head);const state=await f.run('publish');assert.equal(state.operations.length,0);assert.equal(state.observation.publication.remoteSha,f.head);assert.equal(f.counts().confirms,0);assert.equal(f.counts().pushes,0);
});
test('production publication rejects noncanonical URLs and unsafe branches before dispatch',async t=>{
 const f=await fixture(t);
 await assert.rejects(async()=>createGitPublicationTransport({gitExecutable:await realpath('/usr/bin/git'),sourceObjects:join(f.source,'.git','objects'),project:f.source,repository:{...repository,url:'http://github.com/team/repo'},token:'fixture'}));
 for(const branch of ['../evil','x.lock','x/.hidden','x/','x..y','main'])await assert.rejects(()=>f.transport.push({...f.target,sourceBranch:branch},{deadline:new Date(Date.now()+10000).toISOString()}));
});
test('publication scopes capabilities and token family without qualifying unsupported Bitbucket API tokens',async()=>{
 const {publicationProvider}=await import('../../src/commands/delivery-publish.js');
 const base={project:{id:'demo'},providers:{providers:[{id:'git-main',kind:'git-ci',endpoint:'https://api.github.com',mode:'read-write-with-approval',capabilities:['repository-read','branch-publish'],projectIds:['demo'],resourceIds:['team/repo']}]}};
 assert.equal(publicationProvider(base,repository,{},true).id,'git-main');
 for(const mutate of [c=>c.providers.providers[0].mode='read-only',c=>c.providers.providers[0].projectIds=['other'],c=>c.providers.providers[0].resourceIds=['other/repo'],c=>c.providers.providers[0].capabilities=['repository-read'],c=>c.providers.providers.push(c.providers.providers[0])]) {const changed=structuredClone(base);mutate(changed);assert.throws(()=>publicationProvider(changed,repository,{},true));}
});
test('after-approval project metadata and token changes cannot use captured approval',async t=>{
 for(const kind of ['project','token']) {
  const f=await deliveryFixture(t);f.options.dependencies.confirmDelivery=async()=>{if(kind==='project')f.config.project.id='changed';else f.options.dependencies.env.PUBLICATION_TEST_TOKEN='changed';return true;};
  await assert.rejects(()=>f.run('publish'));assert.equal(f.counts().pushes,0);
 }
});
test('Bitbucket publication requires its access-token convention rather than Atlassian API tokens',async()=>{
 const {publicationToken}=await import('../../src/commands/delivery-publish.js');
 assert.equal(publicationToken({credentials:{accessTokenEnv:'ACCESS_TOKEN'}},'bitbucket',{ACCESS_TOKEN:'fixture'}),'fixture');
 assert.throws(()=>publicationToken({credentials:{apiTokenEnv:'API_TOKEN'}},'bitbucket',{API_TOKEN:'fixture'}));
});
test('helper symlink replacement and object-store replacement are rejected before invoking Git',async t=>{
 const {symlink,unlink,rename}=await import('node:fs/promises');
 const f=await fixture(t);const execPath=git(f.source,['--exec-path']);const helpers=join(f.root,'helpers');await mkdir(helpers);
 for(const name of ['git','git-send-pack','git-pack-objects','git-remote-http','git-remote-https'])await symlink(await realpath(join(execPath,name)),join(helpers,name));
 let runs=0;
 const transport=await createGitPublicationTransport({gitExecutable:await realpath('/usr/bin/git'),sourceObjects:join(f.source,'.git','objects'),project:f.source,repository,token:'fixture',runner:async(_exe,args)=>{runs++;assert.deepEqual(args,['--exec-path']);return {code:0,stdout:helpers+'\n'};}});
 await unlink(join(helpers,'git-remote-https'));await symlink(await realpath('/usr/bin/false'),join(helpers,'git-remote-https'));
 await assert.rejects(()=>transport.readRefs(f.target));assert.equal(runs,1);
 const objects=join(f.source,'.git','objects');await rename(objects,objects+'-old');await mkdir(objects);
 await assert.rejects(()=>f.transport.readRefs(f.target));
});
test('historical observations still validate and malformed publication receipts cannot satisfy the stage',async t=>{
 const f=await deliveryFixture(t);const completed=await f.run('publish');
 const {validateRecord}=await import('../../src/delivery/contract.js');
 const {version,...record}=completed;
 assert.equal(validateRecord(record).stage,'branch-published');
 const historical=structuredClone(record);delete historical.observation.publication;assert.equal(validateRecord(historical).stage,'branch-published');
 for(const mutate of [r=>r.operations[0].receipt.commitSha='f'.repeat(40),r=>r.operations[0].payload.ref='refs/heads/other',r=>r.observation.publication.destinationUrl='https://github.com/other/repo.git']) {const bad=structuredClone(record);mutate(bad);assert.throws(()=>validateRecord(bad));}
});
test('publication CLI considers both a confirmed receipt and an existing exact branch successful',async t=>{
 const {deliveryOutcomeIncomplete}=await import('../../src/commands/delivery.js');
 const f=await deliveryFixture(t);const done=await f.run('publish');assert.equal(deliveryOutcomeIncomplete('publish',done),false);
 const existing=await deliveryFixture(t);existing.remote(existing.head);const noop=await existing.run('publish');assert.equal(deliveryOutcomeIncomplete('publish',noop),false);
 assert.equal(deliveryOutcomeIncomplete('publish',{...noop,observation:null}),true);
 assert.equal(deliveryOutcomeIncomplete('publish',{...noop,operations:[{action:'branch-publish',state:'indeterminate'}]}),true);
});
test('publication rejects unattended and JSON confirmation paths before dispatch',async t=>{
 for(const mode of ['json','noninteractive']) {
  const f=await deliveryFixture(t);if(mode==='json')f.options.flags.json=true;else f.options.dependencies.terminalIsInteractive=()=>false;
  await assert.rejects(()=>f.run('publish'));assert.equal(f.counts().pushes,0);assert.equal(f.counts().confirms,0);
 }
});
test('expired publication does not dispatch and old approval cannot target a changed base',async t=>{
 const f=await fixture(t);const before=f.calls.filter(c=>c.args.includes('push')).length;
 await assert.rejects(()=>f.transport.push(f.target,{deadline:new Date(Date.now()-1).toISOString()}));
 assert.equal(f.calls.filter(c=>c.args.includes('push')).length,before);
 let base=f.base,pushes=0;const executor=createBranchPublicationExecutor({repository,transport:{readRefs:async()=>({sourceSha:null,baseSha:base}),push:async()=>{pushes++;}}});
 const facts=await executor.observe(f.target);base='f'.repeat(40);
 await assert.rejects(()=>executor.dispatch({action:'branch-publish',candidate:f.target,digest:'a'.repeat(64),factsDigest:factsDigest(facts),payload:{destinationUrl:repository.url+'.git',ref:'refs/heads/rivet/feature',headSha:f.head}},{deadline:new Date(Date.now()+1000).toISOString()}));assert.equal(pushes,0);
});
test('a published branch remains eligible for independently approved review creation',async t=>{
 const f=await deliveryFixture(t);const done=await f.run('publish');
 const {createDeliveryService,createTrustedDeliveryExecutor}=await import('../../src/delivery/service.js');
 const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');const {createApprovalRegistry}=await import('../../src/policy/approvals.js');
 const executor=createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'review-request',conditionalHead:false,verifiesCreatedReview:true,reconcile:true}],observe:async()=>{const {publication,...facts}=done.observation;return {...facts,observedAt:new Date().toISOString()};},dispatch:async()=>{throw new Error('not approved');},reconcile:async()=>({status:'unknown'})});
 const service=createDeliveryService({store:f.store,executor,providerId:'git-main',subjectId:'delivery-cli',expectedApproverId:'terminal-human',authority:createAuthorityEnvelope({actorId:'delivery-cli',principal:'agent',actions:[],ownedPaths:[],commands:[],providers:[]}),approvalRegistry:createApprovalRegistry({approvers:[{id:'terminal-human',principal:'human'}]})});
 const refreshed=await service.refresh({expectedVersion:done.version});assert.equal(refreshed.stage,'branch-published');
 const proposed=await service.propose({expectedVersion:refreshed.version,action:'review-request',payload:{title:'Review',body:'Fixture'},expiresAt:new Date(Date.now()+10000).toISOString()});assert.equal(proposed.proposal.action,'review-request');assert.equal(proposed.operations[0].receipt.commitSha,f.head);
});
test('client timeout retains intent while a detached fixture server later creates the real remote ref',async t=>{
 const f=await deliveryFixture(t);const remote=join(f.root,'remote.git');
 // Seed the commit's objects on this disposable server, outside the publication ref.
 git(f.source,['push',remote,`${f.head}:refs/heads/fixture-staging`]);
 const pidPath=join(f.root,'server.pid'),donePath=join(f.root,'server.done');let serverPid;
 t.after(async()=>{if(!serverPid)serverPid=Number(await readFile(pidPath,'utf8').catch(()=>''));if(Number.isSafeInteger(serverPid)&&serverPid>1){try{process.kill(-serverPid,'SIGKILL');}catch{}}});
 const server=`setTimeout(()=>{require('node:child_process').execFileSync('/usr/bin/git',['--git-dir=${remote}','update-ref','refs/heads/rivet/feature','${f.head}','${'0'.repeat(40)}'],{timeout:1000});require('node:fs').writeFileSync(${JSON.stringify(donePath)},'done');},500);setTimeout(()=>{},4000);`;
 const client=`const s=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(s.pid));s.unref();setInterval(()=>{},1000);`;
 let pushes=0;
 f.options.dependencies.delivery.publicationTransportFactory=async()=>({readRefs:target=>f.transport.readRefs(target),push:async()=>{pushes++;const result=await runPublicationProcess(process.execPath,['-e',client],{cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:200});assert.equal(result.reason,'timeout');throw new Error('uncertain-client-result');}});
 const pending=await f.run('publish');assert.equal(pending.operations[0].state,'indeterminate');serverPid=Number(await readFile(pidPath,'utf8'));
 for(let attempt=0;attempt<100;attempt++){if(await readFile(donePath,'utf8').catch(()=>false))break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(await readFile(donePath,'utf8'),'done');
 const reconciled=await f.run('reconcile');assert.equal(reconciled.operations[0].state,'succeeded');assert.equal(reconciled.operations[0].receipt.commitSha,f.head);assert.equal(pushes,1);
});
