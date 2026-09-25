import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelRequest, parseModelResponse } from '../../src/models/protocols.js';
const profile = provider => ({provider,model:'configured-model',maxOutputTokens:100,timeoutMs:1000,...(provider==='ollama'?{endpoint:'http://localhost:11434'}:provider==='openai-compatible'?{endpoint:'https://models.example/v1'}:{})});
const responses={
 anthropic:{type:'message',role:'assistant',model:'snapshot-model',stop_reason:'end_turn',content:[{type:'text',text:'Hello'}],usage:{input_tokens:3,output_tokens:4}},
 openai:{status:'completed',model:'snapshot-model',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Hello',annotations:[]}]}],usage:{input_tokens:3,output_tokens:4}},
 gemini:{modelVersion:'snapshot-model',candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:'Hello'}]}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:4}},
 ollama:{model:'snapshot-model',done:true,done_reason:'stop',message:{role:'assistant',content:'Hello'},prompt_eval_count:3,eval_count:4},
 'openai-compatible':{model:'snapshot-model',choices:[{finish_reason:'stop',message:{role:'assistant',content:'Hello'}}],usage:{prompt_tokens:3,completion_tokens:4}},
};
test('builds bounded one-shot requests for five protocols without tools',()=>{
 for(const provider of Object.keys(responses)) {
  const result=buildModelRequest(profile(provider),'Hello','inert-test-key');
  assert.equal(result.headers['content-type'],'application/json');
  assert.equal(JSON.stringify(result.body).includes('Hello'),true);
  assert.equal(result.body.tools,undefined);
  assert.equal(result.url.includes('inert-test-key'),false);
 }
 assert.equal(buildModelRequest(profile('openai'),'Hello','key').body.store,false);
 assert.match(buildModelRequest(profile('gemini'),'Hello','key').url,/\/models\/configured-model:generateContent$/);
 for(const p of [{...profile('openai'),endpoint:'https://elsewhere.example'}, {...profile('ollama'),endpoint:'https://remote.example'}]) assert.throws(()=>buildModelRequest(p,'Hello','key'));
 for(const prompt of ['', 'a'.repeat(65537)]) assert.throws(()=>buildModelRequest(profile('openai'),prompt,'key'));
 assert.throws(()=>buildModelRequest(profile('anthropic'),'Hello','key\r\nInjected: true'));
});
test('parses only complete text with required usage and accepts reported model snapshots',()=>{
 for(const [provider,response] of Object.entries(responses)) assert.deepEqual(parseModelResponse(profile(provider),response),{text:'Hello',model:'snapshot-model',usage:{inputTokens:3,outputTokens:4}});
 const gemini=structuredClone(responses.gemini);gemini.usageMetadata.thoughtsTokenCount=5;
 assert.equal(parseModelResponse(profile('gemini'),gemini).usage.outputTokens,9);
});
test('fails closed for tool calls, incomplete or refused responses and missing usage',()=>{
 const bad=[['anthropic',r=>r.stop_reason='max_tokens'],['anthropic',r=>r.content.push({type:'tool_use',name:'run'})],['openai',r=>r.status='incomplete'],['openai',r=>r.output.push({type:'function_call'})],['openai',r=>r.output[0].content=[{type:'refusal',refusal:'no'}]],['gemini',r=>r.candidates[0].finishReason='MAX_TOKENS'],['gemini',r=>r.candidates[0].content.parts=[{functionCall:{name:'run'}}]],['ollama',r=>r.done=false],['ollama',r=>r.message.tool_calls=[{}]],['openai-compatible',r=>r.choices[0].message.refusal='no'],['openai-compatible',r=>r.choices[0].finish_reason='length']];
 for(const [provider,change] of bad){const response=structuredClone(responses[provider]);change(response);assert.throws(()=>parseModelResponse(profile(provider),response),{code:'ERR_MODEL_PROTOCOL'});}
 for(const [provider,response] of Object.entries(responses)) {assert.throws(()=>parseModelResponse({...profile(provider),maxOutputTokens:1},response));const copy=structuredClone(response);delete copy.usage;delete copy.usageMetadata;delete copy.eval_count;assert.throws(()=>parseModelResponse(profile(provider),copy));}
});
test('never invokes accessors or returns raw errors',()=>{
 let called=false;const response={};Object.defineProperty(response,'model',{enumerable:true,get(){called=true;throw new Error('credential-secret');}});
 assert.throws(()=>parseModelResponse(profile('openai'),response),error=>error.code==='ERR_MODEL_PROTOCOL'&&!error.message.includes('credential-secret'));assert.equal(called,false);
 assert.throws(()=>parseModelResponse(profile('openai'),JSON.parse('{"__proto__":{}}')));
});
test('counts reasoning and caching conservatively and rejects malformed budget metadata',()=>{
 const anthropic=structuredClone(responses.anthropic);Object.assign(anthropic.usage,{cache_creation_input_tokens:5,cache_read_input_tokens:6});
 assert.equal(parseModelResponse(profile('anthropic'),anthropic).usage.inputTokens,14);
 const openai=structuredClone(responses.openai);openai.output.unshift({type:'reasoning',summary:[{type:'summary_text',text:'Reasoned.'}]});
 openai.usage.output_tokens_details={reasoning_tokens:2};
 assert.equal(parseModelResponse(profile('openai'),openai).usage.outputTokens,4);
 openai.usage.output_tokens_details.reasoning_tokens=5;
 assert.throws(()=>parseModelResponse(profile('openai'),openai));
 const gemini=structuredClone(responses.gemini);gemini.candidates[0].content.parts.unshift({text:'Reasoning',thought:true});
 assert.throws(()=>parseModelResponse(profile('gemini'),gemini));
 gemini.usageMetadata.thoughtsTokenCount=6;
 assert.equal(parseModelResponse(profile('gemini'),gemini).usage.outputTokens,10);
 const compatible=structuredClone(responses['openai-compatible']);compatible.usage.completion_tokens_details={reasoning_tokens:-1};
 assert.throws(()=>parseModelResponse(profile('openai-compatible'),compatible));
});
