import { mkdtemp,mkdir,writeFile,realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname,join,isAbsolute,delimiter } from 'node:path';
import YAML from 'yaml';
import { createGitClient } from '../git/client.js';
import { createFeatureWorkflow } from '../feature/workflow.js';
import { createFeatureExecutor } from '../feature/runtime-bridge.js';
import { createAcceptedIntegrationStore } from '../feature/accepted-integration.js';
import { createVerificationReportStore } from '../feature/verification-report.js';
import { resolveFeatureRunPaths,acceptedIntegrationPaths,verificationReportPaths } from '../state/paths.js';
import { discoverHarnesses } from '../runtime/harness-discovery.js';
import { createClaudeClient,createClaudePlanningClient,CLAUDE_ADAPTER_SYNTAX } from '../clients/claude.js';
import { createCodexClient,createCodexPlanningClient,CODEX_ADAPTER_SYNTAX } from '../clients/codex.js';
import { runPublicationProcess } from '../delivery/publication-process.js';
import { ensure,LiveEvaluationError } from './cost-policy.js';
import { waitForApproval } from './approval.js';

async function command(executable,args,cwd,env,signal,timeoutMs=15000) {
 const result=await runPublicationProcess(executable,args,{cwd,env,signal,timeoutMs,maxOutputBytes:262144});
 ensure(result.code===0&&!result.reason,'fixture-command-failed');return result.stdout.trim();
}
async function createFixture(scenario,profile,signal) {
 const workspace=await realpath(await mkdtemp(join(tmpdir(),'rivet-live-eval-')));
 const root=join(workspace,'project'),remote=join(workspace,'origin.git'),empty=join(workspace,'empty-template');
 const env={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:workspace,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',NPM_CONFIG_USERCONFIG:join(workspace,'user.npmrc'),NPM_CONFIG_GLOBALCONFIG:join(workspace,'global.npmrc'),NPM_CONFIG_CACHE:join(workspace,'cache'),NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true'};
 await mkdir(root);await mkdir(empty);await mkdir(join(root,'.rivet'));
 for(const [path,content]of Object.entries(scenario.files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content,{flag:'wx'});}
 await writeFile(join(root,'package.json'),JSON.stringify({name:'rivet-evaluation-fixture',private:true,type:'module',scripts:{build:'node --check src/solution.js',test:'node public-check.mjs'}}));
 const config={};
 for(const name of ['project','providers','orchestration','quality'])config[name]=YAML.parse(scenario.configurationTemplates[name]);
 config.project.id='live-evaluation';config.project.name='Live evaluation';config.project.stack={framework:'node',language:'javascript',packageManager:'npm'};
 config.project.repository.defaultBranch='main';config.project.repository.sensitivePaths=['package.json','public-check.mjs','request.md'];config.project.commands={build:['npm','run','build'],test:['npm','run','test']};
 config.orchestration.roles.forEach(role=>{role.budget={timeMinutes:5,tokenLimit:20000,costUsd:3,taskLimit:1};role.capacity=1});
 for(const [name,value]of Object.entries(config))await writeFile(join(root,'.rivet',`${name}.yaml`),YAML.stringify(value));
 const git=(...args)=>command('/usr/bin/git',args,root,env,signal);
 await git('init','--quiet',`--template=${empty}`,'--initial-branch=main');await git('config','user.name','Rivet evaluation');await git('config','user.email','evaluation@example.invalid');
 await git('add','.');await git('commit','--quiet','-m','Fixed evaluation baseline');
 await git('init','--quiet','--bare',`--template=${empty}`,remote);await git('remote','add','origin',remote);await git('push','--quiet','-u','origin','main');
 const baseline=await git('rev-parse','HEAD'),remoteBefore=await git('ls-remote','--refs','origin');
 return {workspace,root,remote,env,git,baseline,remoteBefore};
}
async function installedClients(profile,root,environment,signal) {
 const selected=(await discoverHarnesses({env:environment,projectRoot:root,signal})).find(item=>item.kind===profile.id&&item.executable);
 ensure(selected,'harness-unavailable');
 const clientEnvironment=Object.fromEntries(['PATH','LANG','LC_ALL','TZ','TERM','TMPDIR','HOME','USER','LOGNAME','SHELL'].filter(key=>typeof environment[key]==='string').map(key=>[key,environment[key]]));
 const settings={executable:selected.executable,...(selected.interpreter?{interpreter:selected.interpreter}:{}),expectedVersion:selected.version,environment:clientEnvironment,maxOutputBytes:profile.limits.maxOutputBytes};
 const planning=(profile.id==='claude'?createClaudePlanningClient:createCodexPlanningClient)({...settings,worktree:root,timeoutMs:Math.min(profile.limits.timeoutMs,profile.limits.planningTimeoutMs)});
 const args=profile.id==='claude'?[...CLAUDE_ADAPTER_SYNTAX.args.slice(0,-1),'--model','sonnet','--effort','low','--permission-mode','acceptEdits','{stdin}']:[...CODEX_ADAPTER_SYNTAX.args.slice(0,-1),'--sandbox','workspace-write',...(profile.models.worker==='harness-default'?[]:['--model',profile.models.worker]),'{stdin}'];
 const worker=(profile.id==='claude'?createClaudeClient:createCodexClient)({...settings,args,timeoutMs:profile.limits.timeoutMs});
 return {planning,worker,version:selected.version};
}
function acceptanceProgram(scenario,path) {
 const checks=scenario.id==='feature'?[
  `["normalization",()=>assert.deepEqual(solution.normalizeTags([' Foo ','BAR']),['foo','bar'])]`,
  `["stable-deduplication",()=>assert.deepEqual(solution.normalizeTags([' B ','a','b','',' A ','  ']),['b','a'])]`,
  `["empty-input",()=>assert.deepEqual(solution.normalizeTags([]),[])]`,
  `["input-preservation",()=>{const input=[' A ','a'];solution.normalizeTags(input);assert.deepEqual(input,[' A ','a'])}]`,
 ]:[
  `["inclusive-boundaries",()=>{assert.equal(solution.countInRange([1,3],1,3),2);assert.equal(solution.countInRange([2,2,3],2,2),2)}]`,
  `["duplicate-matches",()=>assert.equal(solution.countInRange([0,1,1,2,3,4],1,3),4)]`,
  `["finite-numbers",()=>assert.equal(solution.countInRange(['2',NaN,Infinity,-Infinity,2],-Infinity,Infinity),1)]`,
  `["input-preservation",()=>{const input=[3,1,2];assert.equal(solution.countInRange([],1,3),0);solution.countInRange(input,1,3);assert.deepEqual(input,[3,1,2])}]`,
 ];
 return `const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');(async()=>{const solution=await import(pathToFileURL(${JSON.stringify(join(path,'src/solution.js'))}).href);const checks=[${checks.join(',')}].map(([id,check])=>{try{check();return{id,passed:true}}catch{return{id,passed:false}}});process.stdout.write(JSON.stringify(checks))})().catch(()=>process.exitCode=1);`;
}
export async function runHarnessAttempt({profile,scenario,environment,signal,confirmActivation,clients,assertCurrent=()=>{}}) {
 ensure(typeof confirmActivation==='function','activation-approval-required');
 const fixture=await createFixture(scenario,profile,signal);
 const evidence={workspace:fixture.workspace,baselineCommit:fixture.baseline,sourcePreserved:null,remotePreserved:null,changedPaths:[],modelCalls:{planning:0,worker:0}};
 let usage=null,harness=null,gates=[],acceptance={total:scenario.acceptanceIds.length,passed:null,checks:[]};
 const check=()=>{ensure(!signal.aborted,'cancelled');assertCurrent()};
 try {
  check();const selected=clients??await installedClients(profile,fixture.root,environment,signal);
  ensure(selected.planning&&typeof selected.planning.propose==='function'&&selected.worker&&selected.worker.provider===profile.id&&typeof selected.worker.launch==='function','invalid-clients');
  harness={name:profile.id,version:selected.version??null};
  let gitClient;
  for(const directory of String(environment.PATH??'').split(delimiter).filter(isAbsolute)) {
   try{gitClient=await createGitClient({gitExecutable:await realpath(join(directory,'git'))});break}catch{}
  }
  ensure(gitClient,'git-unavailable');
  const npm=await realpath(join(dirname(process.execPath),'npm'));
  const executor=createFeatureExecutor({gitClient,now:()=>new Date().toISOString(),environment:fixture.env,resolveCommandExecutable:async runner=>{ensure(runner==='npm');return npm},clientFor:async()=>({provider:profile.id,async launch(contract,options){check();ensure(evidence.modelCalls.worker===0,'automatic-retry-blocked');evidence.modelCalls.worker++;
   const result=await selected.worker.launch(contract,options);usage=result.usage??null;return result;
  }})});
  const workflow=createFeatureWorkflow({gitClient,protocolsFor:async()=>[],planningClientFor:async()=>({async propose(contract,options){check();ensure(evidence.modelCalls.planning===0,'automatic-retry-blocked');evidence.modelCalls.planning++;return selected.planning.propose(contract,options)}}),executeFeature:executor});
  const proposed=await workflow.propose({project:fixture.root,source:{kind:'file',value:join(fixture.root,'request.md')},client:profile.id},{signal});
  check();const workers=proposed.featurePlan.nodes.filter(node=>node.role==='worker');
  ensure(workers.length===1&&workers[0].ownedPaths.length===1&&workers[0].ownedPaths[0]==='src/solution.js','proposal-outside-fixture-scope');
  ensure(await waitForApproval(confirmActivation,Object.freeze({scenario:scenario.id,runId:proposed.runId,proposalDigest:proposed.proposalDigest,plan:proposed.featurePlan,workspace:fixture.workspace}),signal)===true,'activation-declined');check();
  const approved=await workflow.start({project:fixture.root,runId:proposed.runId,expectedVersion:proposed.version,proposalDigest:proposed.proposalDigest});
  const outcome=await workflow.resume({project:fixture.root,runId:proposed.runId,expectedVersion:approved.version},{signal,confirmDependencyInstall:async()=>false});
  evidence.runId=proposed.runId;evidence.workflowStatus=outcome.status;
  const paths=await resolveFeatureRunPaths(fixture.root,proposed.runId);
  const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
  const report=await createVerificationReportStore(await verificationReportPaths(paths)).readOnly();
  if(report)evidence.verificationFailure=report.failure;
  if(report)gates=report.checks.map(({id,status,executionStatus,exitCode})=>({id,status,executionStatus,exitCode}));
  if(accepted){evidence.acceptedCommit=accepted.commitSha;evidence.integrationPath=accepted.path;evidence.changedPaths=await gitClient.changedPaths(accepted.path,fixture.baseline,accepted.commitSha);
   evidence.diffSha256=createHash('sha256').update(await fixture.git('diff','--no-ext-diff','--no-textconv',fixture.baseline,accepted.commitSha,'--')).digest('hex');
   check();const result=await runPublicationProcess(process.execPath,['-e',acceptanceProgram(scenario,accepted.path)],{cwd:accepted.path,env:fixture.env,signal,timeoutMs:5000,maxOutputBytes:16384});
   if(result.code===0&&!result.reason){let checks;try{checks=JSON.parse(result.stdout)}catch{};
    if(Array.isArray(checks)&&checks.length===scenario.acceptanceIds.length&&checks.every((item,index)=>item.id===scenario.acceptanceIds[index]&&typeof item.passed==='boolean'))acceptance={total:checks.length,passed:checks.filter(item=>item.passed).length,checks};
   }
   evidence.acceptanceCleanup=result.cleanup;
   const after=await gitClient.inspectRepository(accepted.path);ensure(!after.dirty&&after.headSha===accepted.commitSha,'integration-changed-during-acceptance');
  }
  evidence.sourcePreserved=(await fixture.git('rev-parse','HEAD'))===fixture.baseline&&(await fixture.git('status','--porcelain'))==='';
  evidence.remotePreserved=(await fixture.git('ls-remote','--refs','origin'))===fixture.remoteBefore;
  const passed=outcome.status==='awaiting-final-approval'&&gates.length===2&&gates.every(item=>item.status==='passed')&&acceptance.passed===acceptance.total&&evidence.sourcePreserved&&evidence.remotePreserved&&JSON.stringify(evidence.changedPaths)==='["src/solution.js"]';
  return {outcome:passed?'passed':'failed',harness,usage:{provenance:usage?'agent-result-self-report':'not-observed',value:usage},gates,acceptance,evidence};
 }catch(error){return {outcome:signal.aborted?'cancelled':'failed',reason:error instanceof LiveEvaluationError?error.reason:typeof error.code==='string'?error.code:'harness-attempt-failed',harness,usage:{provenance:usage?'agent-result-self-report':'not-observed',value:usage},gates,acceptance,evidence};}
}
