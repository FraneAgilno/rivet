import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { runLiveEvaluation } from '../../src/evaluations/live-runner.js';
const profile={id:'openai',model:'fixture-model',credentialEnv:'EVAL_KEY',costPolicy:{kind:'account-policy',accountPolicy:'test-only',estimatedCostUsd:1}};
function transport(text) {
 let calls=0;return {get calls(){return calls},value:createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async()=>{calls++;return Response.json({status:'completed',model:'fixture-model-observed',output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:30,output_tokens:20}})}})};
}
const review=JSON.stringify({findings:[{id:'inclusive-boundaries',line:2,explanation:'The strict comparisons exclude either boundary.'},{id:'numeric-validation',line:2,explanation:'Numeric strings are coerced instead of ignored.'}],executedTests:false});
test('text evaluation is callable, uses one real delegation contract, and distinguishes provider usage from billing',async()=>{
 const client=transport(review);let approvals=0;
 const report=await runLiveEvaluation({scenario:'text-review',profile},{interactive:true,confirm:async proposal=>{approvals++;assert.equal(proposal.destination,'https://api.openai.com/v1/responses');assert.equal(proposal.cost.hardDollarCapEnforced,false);return true;},transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}});
 assert.equal(approvals,1);assert.equal(client.calls,1);assert.equal(report.outcome,'passed');assert.equal(report.measurement,'injected-client-rehearsal');
 assert.equal(report.usage.provenance,'provider-response');assert.equal(report.actualCostUsd,null);assert.equal(report.model.observed,'fixture-model-observed');
 assert.equal(report.acceptance.passed,2);assert.equal(report.metrics.unsupportedClaims,null);assert.equal(report.metrics.humanInterventions,null);assert.equal(report.retryCount,0);
 assert.equal(report.source.sourceScope,'current-working-tree');assert.equal(report.source.observedAt,'start');
 assert.equal(report.evidence.review.trust,'untrusted-model-output');assert.match(report.evidence.review.findings[0].explanation,/strict comparisons/);
});
test('missing, noninteractive or declined approval never dispatches',async()=>{
 const client=transport(review);
 for(const deps of [{},{interactive:false,confirm:async()=>true},{interactive:true,confirm:async()=>false}]) {
  await assert.rejects(()=>runLiveEvaluation({scenario:'text-review',profile},{...deps,transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}}));
 }
 assert.equal(client.calls,0);
});
test('profile drift during approval and cancellation before dispatch fail closed',async()=>{
 const client=transport(review),mutable=structuredClone(profile);
 await assert.rejects(()=>runLiveEvaluation({scenario:'text-review',profile:mutable},{interactive:true,confirm:async()=>{mutable.model='changed';return true},transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}}));
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>runLiveEvaluation({scenario:'text-review',profile},{interactive:true,confirm:async()=>true,signal:controller.signal,transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}}));assert.equal(client.calls,0);
});
test('unsupported test-execution claims are scored only in the explicit fixed rubric',async()=>{
 const client=transport(JSON.stringify({...JSON.parse(review),executedTests:true}));
 const report=await runLiveEvaluation({scenario:'text-review',profile},{interactive:true,confirm:async()=>true,transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}});
 assert.equal(report.outcome,'failed');assert.equal(report.metrics.unsupportedTestExecutionClaims,1);assert.equal(report.metrics.unsupportedClaims,null);
});
test('cancellation during provider resolution prevents dispatch and never retries',async()=>{
 const controller=new AbortController();let calls=0;
 const injected=createTrustedProviderTransport({resolve:async()=>{controller.abort();return ['93.184.216.34']},fetchPinned:async()=>{calls++;throw Error('unexpected dispatch')}});
 const report=await runLiveEvaluation({scenario:'text-review',profile},{interactive:true,confirm:async()=>true,signal:controller.signal,transport:injected,environment:{EVAL_KEY:'fixture-only-key'}});
 assert.equal(report.outcome,'cancelled');assert.equal(calls,0);assert.equal(report.retryCount,0);assert.equal(report.actualCostUsd,null);
});
test('an unanswered initial approval is bounded by the evaluation deadline and late approval cannot dispatch',async()=>{
 const client=transport(review);let approve,approvalSignal;
 const pending=runLiveEvaluation({scenario:'text-review',profile:{...profile,timeoutMs:1000}},{interactive:true,confirm:(_proposal,options)=>{approvalSignal=options?.signal;return new Promise(resolve=>{approve=resolve})},transport:client.value,environment:{EVAL_KEY:'fixture-only-key'}}).then(value=>({value}),error=>({error}));
 let guard;const outcome=await Promise.race([pending,new Promise(resolve=>{guard=setTimeout(()=>resolve('stalled'),2200)})]);clearTimeout(guard);
 assert.notEqual(outcome,'stalled');assert.equal(outcome.error?.reason,'timeout');assert.equal(approvalSignal.aborted,true);
 approve(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(client.calls,0);
});
