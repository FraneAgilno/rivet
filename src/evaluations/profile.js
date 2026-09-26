import { createHash } from 'node:crypto';
import { createModelRegistry } from '../models/registry.js';
import { buildModelRequest } from '../models/protocols.js';
import { capture, ensure, resolveCostPolicy } from './cost-policy.js';
const HARNESSES=new Set(['claude','codex']);
const TEXT=new Set(['anthropic','openai','gemini','ollama','openai-compatible']);
function integer(value,fallback,min,max) { const result=value??fallback;ensure(Number.isSafeInteger(result)&&result>=min&&result<=max);return result; }
function model(value) { ensure(typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value));return value; }
export function resolveLiveProfile(input) {
 const value=capture(input,['id','model','workerModel','endpoint','credentialEnv','timeoutMs','maxOutputTokens','costPolicy']);
 ensure(HARNESSES.has(value.id)||TEXT.has(value.id));
 const cost=resolveCostPolicy(value.costPolicy,value.id);
 if(HARNESSES.has(value.id)) {
  ensure(value.model===undefined&&value.endpoint===undefined&&value.credentialEnv===undefined&&value.maxOutputTokens===undefined);
  ensure(value.id==='codex'||value.workerModel===undefined);
  const worker=value.id==='claude'?'sonnet':value.workerModel===undefined?'harness-default':model(value.workerModel);
  ensure(value.workerModel===undefined||/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.workerModel));
  return Object.freeze({schemaVersion:1,id:value.id,kind:'harness',models:Object.freeze({planning:value.id==='claude'?'sonnet':'harness-default',worker}),destination:`installed-${value.id}-authenticated-account`,limits:Object.freeze({timeoutMs:integer(value.timeoutMs,300000,1000,600000),planningTimeoutMs:120000,maxModelCalls:2,maxWorkers:1,maxRetries:0,maxOutputBytes:524288}),cost});
 }
 ensure(value.workerModel===undefined);
 const profile=createModelRegistry().resolve({provider:value.id,model:model(value.model),timeoutMs:integer(value.timeoutMs,60000,1000,120000),maxOutputTokens:integer(value.maxOutputTokens,4096,64,16384),...(value.endpoint===undefined?{}:{endpoint:value.endpoint}),...(value.credentialEnv===undefined?{}:{credentialEnv:value.credentialEnv})}).profile;
 ensure(!['anthropic','openai','gemini'].includes(value.id)||profile.credentialEnv!==undefined,'credential-reference-required');
 // Derive the displayed destination from the exact production protocol. This
 // constructs a request with a dummy credential; it sends nothing.
 const destination=buildModelRequest(profile,'Evaluation destination preview.','preview-only').url;
 return Object.freeze({schemaVersion:1,id:value.id,kind:'text',models:Object.freeze({planning:null,worker:profile.model}),destination,modelProfile:profile,limits:Object.freeze({timeoutMs:profile.timeoutMs,maxOutputTokens:profile.maxOutputTokens,maxModelCalls:1,maxRetries:0}),cost});
}
export function liveProfileDigest(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex'); }
