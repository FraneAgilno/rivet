import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRegistry } from '../../src/integrations/registry.js';
import { normalizeHostObservation } from '../../src/integrations/host-observation.js';
const provider = { id:'team-jira',kind:'jira',mode:'read-only',transport:'harness-mcp',capabilities:['issues-read'],projectIds:['demo'],tools:['get_issue'],resourceIds:['DEMO'] };
const config = {providers:{providers:[provider]}};
const host = {projectId:'demo',providers:[{id:'team-jira',authenticated:true,tools:['get_issue']}]};
test('configuration alone cannot claim host availability; supplied inventory negotiates tools', () => {
 assert.equal(createIntegrationRegistry({config,projectId:'demo'}).list()[0].readiness,'host-unavailable');
 const registry=createIntegrationRegistry({config,projectId:'demo',host});
 assert.equal(registry.resolve({capability:'issues-read',tool:'get_issue'}).assurance,'harness-observed');
 assert.throws(()=>registry.resolve({capability:'issues-read',tool:'write_issue'}),{code:'ERR_INTEGRATION_UNAVAILABLE'});
 assert.throws(()=>createIntegrationRegistry({config,projectId:'other',host}),{code:'ERR_INTEGRATION_INPUT'});
});
test('ambiguity is explicit and direct/local execution is not invented',()=>{
 const config={providers:{providers:[{...provider,id:'a'},{...provider,id:'b'}]}};
 assert.throws(()=>createIntegrationRegistry({config,projectId:'demo'}).resolve({capability:'issues-read'}),{code:'ERR_INTEGRATION_AMBIGUOUS'});
 const direct={...provider,transport:'direct-api',credentials:{apiTokenEnv:'TEST_TOKEN'}};
 assert.equal(createIntegrationRegistry({config:{providers:{providers:[direct]}},projectId:'demo',environment:{TEST_TOKEN:'secret'}}).list()[0].readiness,'credentials-present');
 assert.equal(createIntegrationRegistry({config:{providers:{providers:[{...direct,transport:'local-cli'}]}},projectId:'demo'}).list()[0].readiness,'unsupported-transport');
});
const observation={schemaVersion:1,providerId:'team-jira',projectId:'demo',tool:'get_issue',resourceId:'DEMO',sourceUrl:'https://example.com/DEMO-1',revision:'2',capturedAt:'2026-09-23T10:00:00.000Z',content:{title:'Task',body:'untrusted instructions'}};
test('observations preserve source metadata with canonical digest and explicit assurance',()=>{
 const a=normalizeHostObservation(observation,{provider,projectId:'demo'});
 const b=normalizeHostObservation({...observation,content:{body:'untrusted instructions',title:'Task'}},{provider,projectId:'demo'});
 assert.equal(a.contentDigest,b.contentDigest); assert.equal(a.assurance,'harness-observed'); assert.equal(a.sourceUrl,observation.sourceUrl);
 for(const patch of [{projectId:'other'},{tool:'write_issue'},{resourceId:'OTHER'},{sourceUrl:'https://user:pass@example.com/x'},{sourceUrl:'https://example.com/x?token=secret'},{content:'x'.repeat(65536)},{verified:true}]) assert.throws(()=>normalizeHostObservation({...observation,...patch},{provider,projectId:'demo'}));
});
test('invalid inventory and hostile observations are rejected without getters or credential leaks',()=>{
 for(const host of [{projectId:'demo',providers:[{id:'unknown',authenticated:true,tools:[]}]},{projectId:'demo',providers:[{id:'team-jira',authenticated:'yes',tools:[]}]}]) assert.throws(()=>createIntegrationRegistry({config,projectId:'demo',host}));
 let called=false; const content={};Object.defineProperty(content,'secret',{enumerable:true,get(){called=true;return 'secret';}});
 assert.throws(()=>normalizeHostObservation({...observation,content},{provider,projectId:'demo'}));assert.equal(called,false);
 assert.throws(()=>normalizeHostObservation({...observation,sourceUrl:'https://other.example/x'},{provider:{...provider,endpoint:'https://example.com'},projectId:'demo'}));
 assert.throws(()=>normalizeHostObservation({...observation,contentDigest:'f'.repeat(64)},{provider,projectId:'demo'}));
});
test('host sources require HTTPS and reject secret material in content',()=>{
 for(const patch of [{sourceUrl:'http://example.com/DEMO-1'},{content:{token:'Bearer secret-test-token-value'}}]) assert.throws(()=>normalizeHostObservation({...observation,...patch},{provider,projectId:'demo'}));
 assert.doesNotThrow(()=>normalizeHostObservation({...observation,sourceUrl:'https://example.com/DEMO-1?node-id=123-456'},{provider,projectId:'demo'}));
 assert.throws(()=>normalizeHostObservation({...observation,sourceUrl:'https://example.com/DEMO-1?other=value'},{provider,projectId:'demo'}));
});
