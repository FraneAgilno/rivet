import { fileURLToPath } from 'node:url';
import { loadLiveScenario } from '../../evals/live-catalog.mjs';
import { resolveLiveProfile,liveProfileDigest } from './profile.js';
import { capture,ensure,LiveEvaluationError } from './cost-policy.js';
import { evaluationReport,reportDigest } from './report.js';
import { waitForApproval } from './approval.js';
import { runTextAttempt } from './text-attempt.js';
import { runPublicationProcess } from '../delivery/publication-process.js';
async function sourceIdentity() {
 const cwd=fileURLToPath(new URL('../../',import.meta.url));
 const options={cwd,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeoutMs:3000};
 const commit=await runPublicationProcess('/usr/bin/git',['rev-parse','HEAD'],options);
 const status=await runPublicationProcess('/usr/bin/git',['-c','core.fsmonitor=false','status','--porcelain','--untracked-files=all'],options);
 ensure(commit.code===0&&status.code===0,'source-unavailable');
 return Object.freeze({commit:commit.stdout.trim(),dirty:status.stdout.length>0,sourceScope:'current-working-tree',observedAt:'start'});
}
export async function runLiveEvaluation(input,dependencies={}) {
 const args=capture(input,['scenario','profile']);
 const deps=capture(dependencies,['interactive','confirm','confirmActivation','environment','signal','transport','clients']);
 ensure(deps.interactive===true&&typeof deps.confirm==='function','interactive-approval-required');
 const profile=resolveLiveProfile(args.profile),scenario=await loadLiveScenario(args.scenario);
 ensure(profile.kind===scenario.kind,'scenario-profile-mismatch');
 const checkCancelled=()=>ensure(!deps.signal?.aborted,'cancelled');checkCancelled();
 const source=await sourceIdentity();
 const proposal=Object.freeze({schemaVersion:1,scenario:scenario.id,fixtureDigest:scenario.digest,profileDigest:liveProfileDigest(profile),models:profile.models,destination:profile.destination,limits:profile.limits,cost:profile.cost,source,providerWrites:false,workspace:profile.kind==='harness'?'new disposable local repository and bare local remote; no external push; retained for inspection':null,notice:'This fixed-fixture trial calls the selected installed harness or model endpoint. Calls may incur account charges or local compute costs under your explicit policy. There is no enforced dollar cap. Human pilot and live delivery qualification remain separate.'});
 const digest=reportDigest(proposal);
 const controller=new AbortController();const abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});
 if(deps.signal?.aborted)controller.abort();
 const started=Date.now(),startedAt=new Date(started).toISOString();let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort()},profile.limits.timeoutMs);
 try {
  try {
   ensure(await waitForApproval(deps.confirm,Object.freeze({...proposal,digest}),controller.signal)===true,'approval-declined');
   ensure(!controller.signal.aborted,timedOut?'timeout':'cancelled');
   ensure((await sourceIdentity()).commit===source.commit,'source-revision-changed');
   ensure(!controller.signal.aborted,timedOut?'timeout':'cancelled');
   ensure(liveProfileDigest(resolveLiveProfile(args.profile))===proposal.profileDigest,'profile-changed');
   ensure((await loadLiveScenario(args.scenario)).digest===scenario.digest,'fixture-changed');
   ensure(!controller.signal.aborted,timedOut?'timeout':'cancelled');
  } catch(error) {
   if(controller.signal.aborted)throw new LiveEvaluationError(timedOut?'timeout':'cancelled');
   throw error;
  }
 let result;
 try {
  if(profile.kind==='text')result=await runTextAttempt({profile,scenario,environment:deps.environment??{},signal:controller.signal,transport:deps.transport});
  else {
   const {runHarnessAttempt}=await import('./harness-attempt.js');
   result=await runHarnessAttempt({profile,scenario,environment:deps.environment??process.env,signal:controller.signal,confirmActivation:deps.confirmActivation,clients:deps.clients,assertCurrent:()=>ensure(liveProfileDigest(resolveLiveProfile(args.profile))===proposal.profileDigest,'profile-changed')});
  }
  if(controller.signal.aborted)result={...result,outcome:'cancelled',reason:timedOut?'timeout':'cancelled'};
 } catch(error) {result={outcome:controller.signal.aborted?'cancelled':'failed',reason:timedOut?'timeout':controller.signal.aborted?'cancelled':error instanceof LiveEvaluationError?error.reason:typeof error.code==='string'?error.code:'attempt-failed'};}
 return evaluationReport({profile,scenario,source,startedAt,elapsedMs:Date.now()-started,result,injected:deps.transport!==undefined||deps.clients!==undefined});
 } finally {clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);}
}
