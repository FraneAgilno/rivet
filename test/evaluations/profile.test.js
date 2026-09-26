import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLiveProfile, liveProfileDigest } from '../../src/evaluations/profile.js';
const policy={kind:'account-policy',accountPolicy:'evaluation-account',estimatedCostUsd:3};
test('harness profiles expose actual planning and Worker selections without claiming monetary enforcement',()=>{
 const claude=resolveLiveProfile({id:'claude',costPolicy:policy});
 assert.deepEqual(claude.models,{planning:'sonnet',worker:'sonnet'});
 assert.deepEqual(claude.cost.providerAdvertisedBudgetsUsd,{planning:1,worker:2});
 assert.equal(claude.cost.hardDollarCapEnforced,false);
 const codex=resolveLiveProfile({id:'codex',workerModel:'example-model',costPolicy:policy});
 assert.deepEqual(codex.models,{planning:'harness-default',worker:'example-model'});
 assert.equal(codex.cost.providerAdvertisedBudgetsUsd,null);
 assert.notEqual(liveProfileDigest(codex),liveProfileDigest(resolveLiveProfile({id:'codex',costPolicy:policy})));
});
test('profiles reject implicit spending, hard caps, unsupported overrides and executable configuration',()=>{
 for(const input of [{id:'codex'},{id:'codex',costPolicy:{...policy,hardCapUsd:3}},{id:'claude',workerModel:'other',costPolicy:policy},{id:'codex',command:'echo',costPolicy:policy},{id:'codex',planningModel:'other',costPolicy:policy}])assert.throws(()=>resolveLiveProfile(input));
 let accessed=false;assert.throws(()=>resolveLiveProfile({get id(){accessed=true;return 'codex';},costPolicy:policy}));assert.equal(accessed,false);
});
test('text profiles validate explicit model, endpoint and credential reference and omit unsupported maxCostUsd',()=>{
 const profile=resolveLiveProfile({id:'openai',model:'example-model',credentialEnv:'EVAL_MODEL_KEY',costPolicy:policy});
 assert.equal(profile.kind,'text');assert.equal(profile.modelProfile.maxCostUsd,undefined);
 assert.equal(profile.destination,'https://api.openai.com/v1/responses');
 assert.throws(()=>resolveLiveProfile({id:'openai',model:'example',credentialEnv:'EVAL_MODEL_KEY',endpoint:'https://other.example',costPolicy:policy}));
 assert.throws(()=>resolveLiveProfile({id:'ollama',model:'example',endpoint:'http://not-local.example',costPolicy:policy}));
 assert.throws(()=>resolveLiveProfile({id:'openai',model:'example',credential:'secret',costPolicy:policy}));
});
test('explicit account policy can omit estimates and local compute admission does not invent a charge',()=>{
 const remote=resolveLiveProfile({id:'codex',costPolicy:{kind:'account-policy',accountPolicy:'approved-account'}});
 assert.equal(remote.cost.estimatedCostUsd,null);
 const local=resolveLiveProfile({id:'ollama',model:'example',endpoint:'http://127.0.0.1:11434',costPolicy:{kind:'local-compute',accountPolicy:'approved-workstation'}});
 assert.equal(local.cost.estimatedCostUsd,null);assert.equal(local.cost.actualCostUsd,null);assert.equal(local.cost.kind,'local-compute');
 assert.throws(()=>resolveLiveProfile({id:'openai',model:'example',credentialEnv:'EVAL_KEY',costPolicy:{kind:'local-compute',accountPolicy:'workstation'}}));
});
