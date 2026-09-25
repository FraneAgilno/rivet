import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { delegateText } from '../../src/models/delegate.js';
const profile={provider:'openai',model:'test-model',credentialEnv:'MODEL_KEY',timeoutMs:500,maxOutputTokens:100};
const response={id:'resp_1',status:'completed',model:'test-model',output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'Model draft'}]}],usage:{input_tokens:5,output_tokens:3}};
function hosted(change=()=>{}) {
 const data={calls:[],resolves:0,response,addresses:['93.184.216.34']};change(data);
 const transport=createTrustedProviderTransport({resolve:async()=>{data.resolves++;await data.resolve?.();return data.addresses},fetchPinned:async(url,options,pins)=>{
  data.calls.push({url,...options,pins});if(data.request)return data.request(url,options,pins);return Response.json(data.response);
 }});return {data,transport};
}
const input={profile,prompt:'Write a short draft.',environment:{MODEL_KEY:'fixture-key-not-real'}};
test('delegation makes one pinned hosted request and returns explicitly unverified output',async()=>{
 const f=hosted(),result=await delegateText({...input,transport:f.transport});
 assert.equal(result.provider,'openai');assert.equal(result.model,'test-model');assert.equal(result.requestedModel,'test-model');assert.equal(result.text,'Model draft');assert.equal(result.verified,false);
 assert.deepEqual(result.usage,{inputTokens:5,outputTokens:3});assert.equal(f.data.calls.length,1);assert.ok(f.data.calls[0].url.startsWith('https://api.openai.com/'));
 assert.ok(!JSON.stringify(result).includes('fixture-key'));assert.ok(!JSON.parse(f.data.calls[0].body).tools);
});
test('invalid profiles, prompts, credentials, spend limits and unsupported providers fail before network',async()=>{
 const f=hosted();
 for(const override of [{profile:{...profile,maxCostUsd:1}},{profile:{...profile,timeoutMs:120001}},{profile:{...profile,provider:'codex'}},{profile:{...profile,provider:'custom'}},
  {prompt:''},{prompt:'x'.repeat(65537)},{prompt:'API_KEY=private-value'},{prompt:42},{environment:{}},{environment:{MODEL_KEY:'bad\r\nheader'}},{environment:null}]){
  await assert.rejects(delegateText({...input,...override,transport:f.transport}));
 }
 assert.equal(f.data.calls.length,0);assert.equal(f.data.resolves,0);
});
test('external cancellation and timeout during DNS prevent late dispatch',async()=>{
 for(const cancel of [true,false]) {
  const controller=new AbortController(),f=hosted(d=>{d.resolve=()=>new Promise(resolve=>setTimeout(resolve,60))});
  const pending=delegateText({...input,profile:{...profile,timeoutMs:20},signal:controller.signal,transport:f.transport});
  if(cancel)controller.abort();await assert.rejects(pending);await new Promise(resolve=>setTimeout(resolve,70));assert.equal(f.data.calls.length,0);
 }
});
test('unsafe DNS and redirects are rejected without fallback or leaking provider errors',async()=>{
 for(const change of [d=>d.addresses=['127.0.0.1'],d=>d.request=async()=>new Response(null,{status:302,headers:{location:'https://evil.example'}}),d=>d.request=async()=>{throw new Error('fixture-key-not-real')},d=>d.request=async()=>Response.json({error:{message:'fixture-key-not-real'}},{status:401})]){
  const f=hosted(change);await assert.rejects(delegateText({...input,transport:f.transport}),error=>!JSON.stringify(error).includes('fixture-key-not-real'));
  assert.ok(f.data.calls.length<=1);
 }
});
async function local(t,handler){
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close()});
 return `http://127.0.0.1:${server.address().port}`;
}
test('explicit loopback Ollama performs one bounded text request with no tools',async t=>{
 let calls=0,body='';const endpoint=await local(t,(request,response)=>{calls++;request.on('data',chunk=>body+=chunk);request.on('end',()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({model:'tiny',message:{role:'assistant',content:'Local draft'},done:true,done_reason:'stop',prompt_eval_count:4,eval_count:2}))})});
 const result=await delegateText({profile:{provider:'ollama',model:'tiny',endpoint,timeoutMs:500,maxOutputTokens:10},prompt:'Draft text',environment:{}});
 assert.equal(result.text,'Local draft');assert.equal(result.verified,false);assert.equal(calls,1);assert.equal(JSON.parse(body).stream,false);assert.ok(!JSON.parse(body).tools);
});
test('loopback refuses redirects, oversized responses and stalled bodies',async t=>{
 for(const kind of ['redirect','large','stall']){
  let calls=0;const endpoint=await local(t,(request,response)=>{calls++;if(kind==='redirect'){response.writeHead(302,{location:'https://evil.example'});response.end()}else if(kind==='large'){response.end('x'.repeat(1024*1024+1))}else{response.writeHead(200,{'content-type':'application/json'});response.write('{')}});
  await assert.rejects(delegateText({profile:{provider:'ollama',model:'tiny',endpoint,timeoutMs:100,maxOutputTokens:10},prompt:'Draft',environment:{}}));assert.equal(calls,1);
 }
});
test('hosted response byte limit and output budget fail without a second request',async()=>{
 for(const change of [d=>d.request=async()=>new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application/json'}}),
  d=>d.response={...response,usage:{input_tokens:5,output_tokens:101}},
  d=>d.response={...response,output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'fixture-key-not-real'}]}]}]){
  const f=hosted(change);await assert.rejects(delegateText({...input,transport:f.transport}));assert.equal(f.data.calls.length,1);
 }
});
test('input accessors and credential accessors are rejected without evaluation',async()=>{
 let invoked=false;const f=hosted();
 await assert.rejects(delegateText({...input,get prompt(){invoked=true;return 'Draft'},transport:f.transport}));
 await assert.rejects(delegateText({...input,environment:{get MODEL_KEY(){invoked=true;return 'fixture-key-not-real'}},transport:f.transport}));
 assert.equal(invoked,false);assert.equal(f.data.resolves,0);
});
test('local HTTP is restricted to explicit supported loopback endpoints',async()=>{
 const f=hosted();
 for(const endpoint of ['http://192.168.1.1','http://example.com','http://127.0.0.2','https://127.0.0.1','https://localhost']){
  await assert.rejects(delegateText({profile:{provider:'ollama',model:'tiny',endpoint,timeoutMs:100,maxOutputTokens:10},prompt:'Draft',environment:{},transport:f.transport}));
 }
 assert.equal(f.data.resolves,0);assert.equal(f.data.calls.length,0);
});
test('loopback body cancellation terminates one active request',async t=>{
 let calls=0;const controller=new AbortController();let begin;
 const started=new Promise(resolve=>{begin=resolve});
 const endpoint=await local(t,(request,response)=>{calls++;response.writeHead(200,{'content-type':'application/json'});response.write('{');begin()});
 const pending=delegateText({profile:{provider:'ollama',model:'tiny',endpoint,timeoutMs:1000,maxOutputTokens:10},prompt:'Draft',environment:{},signal:controller.signal});
 await started;controller.abort();await assert.rejects(pending,error=>error.reason==='aborted');assert.equal(calls,1);
});
test('OpenAI-compatible loopback sends explicit credential only to selected local endpoint',async t=>{
 let authorization;const endpoint=await local(t,(request,response)=>{
  authorization=request.headers.authorization;request.resume();response.setHeader('content-type','application/json');
  response.end(JSON.stringify({model:'alias-resolved',choices:[{finish_reason:'stop',message:{role:'assistant',content:'Draft'}}],usage:{prompt_tokens:2,completion_tokens:1}}));
 });
 const result=await delegateText({profile:{provider:'openai-compatible',model:'alias',endpoint,credentialEnv:'LOCAL_KEY',timeoutMs:500,maxOutputTokens:10},prompt:'Draft',environment:{LOCAL_KEY:'local-test-credential'}});
 assert.equal(authorization,'Bearer local-test-credential');assert.equal(result.requestedModel,'alias');assert.equal(result.model,'alias-resolved');
});
test('Anthropic and Gemini runtimes use their own bounded text protocols',async()=>{
 for(const [provider,body] of [
  ['anthropic',{type:'message',role:'assistant',model:'test-model',stop_reason:'end_turn',content:[{type:'text',text:'Draft'}],usage:{input_tokens:2,output_tokens:1}}],
  ['gemini',{modelVersion:'test-model',candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:'Draft'}]}}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:1}}],
 ]){
  const f=hosted(d=>{d.response=body});const result=await delegateText({...input,profile:{...profile,provider},transport:f.transport});
  assert.equal(result.text,'Draft');assert.equal(result.verified,false);assert.equal(f.data.calls.length,1);
  assert.ok(!f.data.calls[0].url.includes('fixture-key'));assert.ok(!f.data.calls[0].body.includes('fixture-key'));
 }
});
