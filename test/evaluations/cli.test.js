import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments,runEvaluations } from '../../scripts/run-evals.mjs';
test('live CLI accepts builtin profiles and explicit admission fields but never command or module settings',()=>{
 const parsed=parseArguments(['--mode=live','--profile=codex','--scenario=feature','--account-policy=approved-trial','--timeout-ms=30000']);
 assert.equal(parsed.profile.id,'codex');assert.equal(parsed.profile.costPolicy.accountPolicy,'approved-trial');assert.equal(parsed.profile.timeoutMs,30000);
 for(const flags of [['--mode=live','--profile=./provider.mjs'],['--mode=fixture','--profile=codex'],['--mode=live','--command=echo'],['--mode=live','--scenario=../../escape'],['--mode=live','--approve']])assert.throws(()=>parseArguments(flags));
});
test('live CLI without explicit profile is blocked before any dispatch',async()=>{
 const result=await runEvaluations({mode:'live'});assert.equal(result.exitCode,2);assert.equal(result.report.outcome,'blocked');
});
