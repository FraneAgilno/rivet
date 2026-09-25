import { createModelRegistry } from './registry.js';
import { buildModelRequest, parseModelResponse } from './protocols.js';
import { requestModelJson } from './transport.js';
import { containsSecretMaterial } from '../clients/contract.js';
const IMPLEMENTED = new Set(['anthropic', 'openai', 'gemini', 'ollama', 'openai-compatible']);
const MESSAGES = Object.freeze({
  'invalid-input': 'Invalid text delegation input.',
  'unsupported-provider': 'This provider does not support direct text delegation.',
  'unsupported-budget': 'A monetary limit cannot be enforced for this model profile. Remove maxCostUsd or use another workflow.',
  'unsupported-timeout': 'Direct text delegation requires timeoutMs at most 120000.',
  'sensitive-prompt': 'The prompt contains credential-shaped text. Remove secrets before delegation.',
  'credential-unavailable': 'The configured model credential is missing or invalid.',
  'aborted': 'Text delegation was cancelled.',
  'timeout': 'Text delegation exceeded its deadline.',
  'request-failed': 'The model request failed or returned an unsupported response. No fallback was attempted.',
});
export class ModelDelegationError extends Error {
  constructor(reason) {
    super(MESSAGES[reason] ?? MESSAGES['request-failed']);
    this.name = 'ModelDelegationError'; this.reason = reason;
    this.code = `ERR_MODEL_DELEGATION_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
  }
}
const fail = reason => { throw new ModelDelegationError(reason); };
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const ADD = EventTarget.prototype.addEventListener, REMOVE = EventTarget.prototype.removeEventListener;
function capture(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-input');
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!['profile','prompt','environment','signal','transport'].includes(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('invalid-input');
    output[key] = descriptor.value;
  }
  return output;
}

export async function delegateText(input) {
  let config, profile;
  try {
    config = capture(input);
    profile = createModelRegistry().resolve(config.profile, { requiredCapabilities: ['text'] }).profile;
  } catch { fail('invalid-input'); }
  if (!IMPLEMENTED.has(profile.provider)) fail('unsupported-provider');
  if (profile.maxCostUsd !== undefined) fail('unsupported-budget');
  if (profile.timeoutMs > 120000) fail('unsupported-timeout');
  if (typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.includes('\0')
    || Buffer.byteLength(config.prompt, 'utf8') > 64 * 1024) fail('invalid-input');
  if (containsSecretMaterial(config.prompt)) fail('sensitive-prompt');
  const environment = config.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) fail('invalid-input');
  let credential;
  try {
    if (profile.credentialEnv !== undefined) {
      const value = Object.getOwnPropertyDescriptor(environment, profile.credentialEnv);
      if (!value || !Object.hasOwn(value, 'value') || typeof value.value !== 'string'
        || !/^[!-~]{1,4096}$/.test(value.value)) fail('credential-unavailable');
      credential = value.value;
    } else if (['anthropic','openai','gemini'].includes(profile.provider)) fail('credential-unavailable');
  } catch { fail('credential-unavailable'); }
  if (credential?.length >= 8 && config.prompt.includes(credential)) fail('sensitive-prompt');
  const controller = new AbortController();
  let timedOut = false, timer;
  const deadline = Date.now() + profile.timeoutMs;
  const abort = () => controller.abort();
  try {
    if (config.signal !== undefined) {
      try {
        if (Reflect.apply(ABORTED, config.signal, [])) fail('aborted');
        Reflect.apply(ADD, config.signal, ['abort', abort, { once: true }]);
        if (Reflect.apply(ABORTED, config.signal, [])) abort();
      } catch (error) { if (error instanceof ModelDelegationError) throw error; fail('invalid-input'); }
    }
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, profile.timeoutMs);
    const request = buildModelRequest(profile, config.prompt, credential);
    if (Date.now() >= deadline) fail('timeout');
    const data = await requestModelJson({ provider: profile.provider, request, timeoutMs: profile.timeoutMs,
      signal: controller.signal, ...(config.transport === undefined ? {} : { transport: config.transport }) });
    if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'aborted');
    const result = parseModelResponse(profile, data);
    if (Date.now() >= deadline) fail('timeout');
    if (credential?.length >= 8 && JSON.stringify(result).includes(credential)) fail('request-failed');
    if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > 256 * 1024
      || !Number.isSafeInteger(result.usage?.inputTokens) || result.usage.inputTokens < 0
      || !Number.isSafeInteger(result.usage?.outputTokens) || result.usage.outputTokens < 0
      || result.usage.outputTokens > profile.maxOutputTokens) fail('request-failed');
    return Object.freeze({ provider: profile.provider, requestedModel: profile.model, model: result.model,
      text: result.text, usage: Object.freeze({ ...result.usage }), verified: false });
  } catch (error) {
    if (error instanceof ModelDelegationError) throw error;
    if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'aborted');
    fail('request-failed');
  } finally {
    clearTimeout(timer);
    if (config.signal !== undefined) {
      try { Reflect.apply(REMOVE, config.signal, ['abort', abort]); } catch {}
    }
  }
}
