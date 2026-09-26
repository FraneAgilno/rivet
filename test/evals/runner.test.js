import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, validateManifest, summarizeScenario, runBounded, runEvaluations } from '../../scripts/run-evals.mjs';
import { readFile } from 'node:fs/promises';
const manifest = () => readFile(new URL('../../evals/scenarios.json', import.meta.url), 'utf8').then(JSON.parse);

test('evaluation CLI rejects unknown selectors and executable profile arguments', async () => {
  assert.throws(() => parseArguments(['--scenario=../../private']));
  assert.throws(() => parseArguments(['--command=echo']));
  assert.throws(() => parseArguments(['--mode=fixture','--mode=live']));
  assert.throws(() => parseArguments(['--profile=evil.mjs']));
});
test('manifest cannot change fixed suites, criteria, or deferred memory status', async () => {
  const clean = await manifest();
  assert.equal(validateManifest(clean), clean);
  for (const mutate of [m => {m.scenarios[0].file='arbitrary.js';},m=>{m.scenarios[0].criteria[0].test='invented';},m=>{m.scenarios.push(m.scenarios[0]);},m=>{m.deferred=[];}]) {
    const changed=structuredClone(clean); mutate(changed); assert.throws(()=>validateManifest(changed));
  }
});
test('scenario reports require observed named passes and propagate failed or missing evidence', async () => {
  const scenario=(await manifest()).scenarios[0];
  const records=scenario.criteria.map(c=>({name:c.test,status:'passed'}));
  const passed=summarizeScenario(scenario,{exitCode:0,records,durationMs:1});
  assert.equal(passed.outcome,'passed');
  assert.equal(passed.metrics.unsupportedClaims,null);
  assert.equal(passed.metrics.humanInterventions,null);
  assert.equal(passed.metrics.acceptanceCoverage,null);
  assert.equal(summarizeScenario(scenario,{exitCode:0,records:[],durationMs:1}).outcome,'failed');
  assert.equal(summarizeScenario(scenario,{exitCode:1,records,durationMs:1}).outcome,'failed');
  assert.equal(summarizeScenario(scenario,{exitCode:0,records:[...records,records[0]],durationMs:1}).outcome,'failed');
});
test('bounded subprocess stops a hung child and discards private output on failure', async () => {
  const result=await runBounded(process.execPath,['-e','console.log("private-canary");setInterval(()=>{},1000)'],{timeoutMs:100});
  assert.equal(result.reason,'timeout');
  assert.equal(JSON.stringify(result).includes('private-canary'),false);
});
test('live evaluation remains blocked without dispatching any executable', async () => {
  const result=await runEvaluations({mode:'live',json:true},{execute(){throw new Error('must not execute');}});
  assert.equal(result.exitCode,2);
  assert.equal(result.report.outcome,'blocked');
  assert.equal(result.report.liveModelQualityEvaluated,false);
});
test('fixture dispatch is fixed, credentials are stripped, and failed execution fails the report', async () => {
  const scenario=(await manifest()).scenarios[0];
  const calls=[];
  const result=await runEvaluations({mode:'fixture',scenario:'intake'}, { async execute(command,args,options) {
    calls.push({command,args,options});
    if(command==='git') return {exitCode:0,stdout:'a'.repeat(40),durationMs:1};
    return {exitCode:1,stdout:scenario.criteria.map(c=>JSON.stringify({name:c.test,status:'passed'})).join('\n'),durationMs:1};
  }});
  assert.equal(result.exitCode,1);
  assert.equal(result.report.scenarios[0].outcome,'failed');
  assert.equal(calls[1].command,process.execPath);
  assert.equal(calls[1].args.at(-1),'test/integrations/context-intake.test.js');
  assert.equal(calls[1].options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(calls[1].options.env.NODE_OPTIONS,undefined);
  assert.equal(result.report.deferred[0].status,'not-implemented');
});
test('timeout and malformed reporter output fail without leaking raw child output', async () => {
  for(const child of [{exitCode:null,reason:'timeout',durationMs:1},{exitCode:0,stdout:'private-canary',durationMs:1}]) {
    const result=await runEvaluations({mode:'fixture',scenario:'intake'}, { async execute(command) {
      return command==='git'?{exitCode:0,stdout:'a'.repeat(40)}:child;
    }});
    assert.equal(result.exitCode,1);
    assert.equal(JSON.stringify(result).includes('private-canary'),false);
  }
});
test('skipped criteria never count as passes and cancellation prevents child dispatch', async () => {
  const scenario=(await manifest()).scenarios[0];
  const records=scenario.criteria.map(c=>({name:c.test,status:'skipped'}));
  const report=summarizeScenario(scenario,{exitCode:0,records,durationMs:0});
  assert.equal(report.outcome,'failed');
  assert.equal(report.testCounts.skipped,2);
  const controller=new AbortController();controller.abort();
  const result=await runBounded('/nonexistent-should-not-launch',[],{signal:controller.signal});
  assert.equal(result.reason,'cancelled');
});
test('escaped descendants holding pipes cannot extend failure finalization indefinitely', { skip: process.platform === 'win32' }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const mode of ['timeout', 'cancelled', 'output-limit', 'leader-exit']) {
    const scratch=await mkdtemp(join(tmpdir(),'rivet-eval-pipe-test-'));
    const pidPath=join(scratch,'descendant.pid');
    let descendant;
    let cancelTimer;
    const controller=new AbortController();
    try {
      const script=`const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{detached:true,stdio:'inherit'});
        require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); child.unref();
        ${mode==='output-limit' ? "process.stdout.write('x'.repeat(2*1024*1024));" : ''}
        ${mode==='leader-exit' ? 'process.exit(0);' : 'setInterval(()=>{},1000);'}`;
      const pending=runBounded(process.execPath,['-e',script],{timeoutMs:500,signal:controller.signal});
      if(mode==='cancelled') cancelTimer=setTimeout(()=>controller.abort(),350);
      const result=await pending;
      descendant=Number(await readFile(pidPath,'utf8'));
      assert.equal(result.reason,mode==='leader-exit'?'timeout':mode);
      assert.equal(result.cleanup,'uncertain');
      assert(result.durationMs<2000,`${mode} exceeded bounded finalization: ${result.durationMs} ms`);
    } finally {
      clearTimeout(cancelTimer);
      if(!descendant) descendant=Number(await readFile(pidPath,'utf8').catch(()=>''));
      if(Number.isSafeInteger(descendant)&&descendant>1) {try{process.kill(-descendant,'SIGKILL');}catch{}}
      await rm(scratch,{recursive:true,force:true});
    }
  }
});
