import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runLiveEvaluation } from '../../src/evaluations/live-runner.js';
const costPolicy={kind:'account-policy',accountPolicy:'fixture-account',estimatedCostUsd:3};
function clients(scenario,{wrong=false,cancel,changeScope=false}={}) {
 const calls={planning:0,worker:0};
 return {calls,version:'injected-fixture',planning:{async propose(contract){calls.planning++;return {schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:contract.workRequest.description,ownedPaths:[changeScope?'package.json':'src/solution.js'],acceptanceCriterionIndexes:contract.workRequest.acceptanceCriteria.map((_,index)=>index+1)}]}}},worker:{provider:'codex',async launch(contract){calls.worker++;if(cancel){cancel.abort();return {version:1,status:'cancelled',output:{summary:'cancelled',evidence:[]},usage:{tokens:0,costUsd:0}}}
 await writeFile(join(contract.worktree.path,'src/solution.js'),scenario==='feature'?`export function normalizeTags(tags){return ${wrong?'[]':'[...new Set(tags.map(tag=>tag.trim().toLowerCase()).filter(Boolean))]'};}\n`:`export function countInRange(values,min,max){return values.filter(value=>Number.isFinite(value)&&value>=min&&value<=max).length;}\n`);
 return {version:1,status:'success',output:{summary:'Implemented fixture.',evidence:[...contract.evidence]},usage:{tokens:10,costUsd:0.01}};
 }}};
}
for(const provider of ['claude','codex'])for(const scenario of ['feature','bugfix'])test(`${provider} ${scenario} uses normal proposal, Worker, gates, accepted integration and withheld acceptance`,async t=>{
 const client=clients(scenario);client.worker.provider=provider;const result=await runLiveEvaluation({scenario,profile:{id:provider,costPolicy}},{interactive:true,confirm:async()=>true,confirmActivation:async()=>true,clients:client});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));
 assert.equal(result.outcome,'passed',JSON.stringify(result));assert.equal(client.calls.planning,1);assert.equal(client.calls.worker,1);
 assert.equal(result.acceptance.passed,4);assert.equal(result.gates.length,2);assert.ok(result.gates.every(item=>item.status==='passed'));assert.equal(result.evidence.sourcePreserved,true);assert.equal(result.evidence.remotePreserved,true);
 assert.deepEqual(result.evidence.changedPaths,['src/solution.js']);assert.equal(result.usage.provenance,'agent-result-self-report');assert.equal(result.actualCostUsd,null);
});
test('passing public gates cannot substitute for withheld acceptance',async t=>{
 const client=clients('feature',{wrong:true});const result=await runLiveEvaluation({scenario:'feature',profile:{id:'codex',costPolicy}},{interactive:true,confirm:async()=>true,confirmActivation:async()=>true,clients:client});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));
 assert.equal(result.outcome,'failed',JSON.stringify(result));assert.equal(result.gates.length,2);assert.ok(result.gates.every(item=>item.status==='passed'));assert.ok(result.acceptance.passed<4);
});
test('declined activation and cancelled planning cannot dispatch the Worker',async t=>{
 for(const mode of ['decline','cancel']) {
 const controller=new AbortController(),client=clients('feature');if(mode==='cancel'){const plan=client.planning.propose;client.planning.propose=async contract=>{const result=await plan(contract);controller.abort();return result}};
 const result=await runLiveEvaluation({scenario:'feature',profile:{id:'codex',costPolicy}},{interactive:true,confirm:async()=>true,confirmActivation:async()=>false,clients:client,signal:controller.signal});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));assert.equal(client.calls.worker,0);assert.notEqual(result.outcome,'passed');
 }
});
test('profile changes during activation cannot reach Worker dispatch',async t=>{
 const client=clients('feature'),profile={id:'codex',costPolicy:structuredClone(costPolicy)};
 const result=await runLiveEvaluation({scenario:'feature',profile},{interactive:true,confirm:async()=>true,confirmActivation:async()=>{profile.workerModel='changed';return true},clients:client});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));assert.equal(result.reason,'profile-changed');assert.equal(client.calls.worker,0);
});
test('unsafe planner ownership and repair attempts do not trigger further model calls',async t=>{
 const client=clients('feature',{changeScope:true});
 const result=await runLiveEvaluation({scenario:'feature',profile:{id:'codex',costPolicy}},{interactive:true,confirm:async()=>true,confirmActivation:async()=>true,clients:client});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));assert.equal(client.calls.planning,1);assert.equal(client.calls.worker,0);assert.equal(result.outcome,'failed');
});
test('cancelling an active Worker records cancellation and dispatches no retry',async t=>{
 const controller=new AbortController(),client=clients('feature',{cancel:controller});
 const result=await runLiveEvaluation({scenario:'feature',profile:{id:'codex',costPolicy}},{interactive:true,confirm:async()=>true,confirmActivation:async()=>true,clients:client,signal:controller.signal});
 if(result.evidence.workspace)t.after(()=>rm(result.evidence.workspace,{recursive:true,force:true}));assert.equal(result.outcome,'cancelled');assert.equal(client.calls.worker,1);assert.equal(result.retryCount,0);
});
test('an unanswered activation is bounded by the same deadline and late approval never dispatches a Worker',async t=>{
 const client=clients('feature');let approve,approvalSignal,workspace;
 const pending=runLiveEvaluation({scenario:'feature',profile:{id:'codex',costPolicy,timeoutMs:3000}},{interactive:true,confirm:async()=>true,confirmActivation:(proposal,options)=>{workspace=proposal.workspace;approvalSignal=options?.signal;return new Promise(resolve=>{approve=resolve})},clients:client});
 t.after(async()=>{if(workspace)await rm(workspace,{recursive:true,force:true})});
 let guard;const result=await Promise.race([pending,new Promise(resolve=>{guard=setTimeout(()=>resolve('stalled'),4500)})]);clearTimeout(guard);
 assert.notEqual(result,'stalled');assert.equal(typeof approve,'function');assert.equal(result.outcome,'cancelled');assert.equal(result.reason,'timeout');assert.equal(approvalSignal.aborted,true);
 approve(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(client.calls.worker,0);assert.equal(client.calls.planning,1);
});
