// Text-only wire protocols. Transport, authorization and cost policy belong to the runtime.
const HOSTS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
};
function fail() {
  const error = new Error('Model protocol input or response is unsupported or invalid.');
  error.code = 'ERR_MODEL_PROTOCOL';
  error.safeMessage = error.message;
  throw error;
}
function ensure(value) { if (!value) fail(); }
function snapshot(input) {
  let nodes = 0;
  const copy = (value, depth = 0) => {
    ensure(++nodes <= 20000 && depth <= 24);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') { ensure(Number.isFinite(value)); return value; }
    ensure(value && typeof value === 'object');
    const array = Array.isArray(value);
    ensure(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
      || (!array && Object.getPrototypeOf(value) === null));
    const output = array ? [] : {};
    if (array) ensure(value.length <= 20000 && Object.keys(value).length === value.length);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      ensure(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
      if (array) ensure(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
      output[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  };
  const value = copy(input);
  ensure(Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024);
  return value;
}
function tokenCount(value) { ensure(Number.isSafeInteger(value) && value >= 0); return value; }
function nonempty(value, maximum) {
  ensure(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maximum);
  return value;
}
function settings(input) {
  const value = snapshot(input);
  ensure(Object.keys(value).every(key => ['provider','model','endpoint','credentialEnv','timeoutMs','maxOutputTokens','maxCostUsd'].includes(key)));
  ensure(['anthropic','openai','gemini','ollama','openai-compatible'].includes(value.provider));
  nonempty(value.model, 800);
  ensure(!/[\u0000-\u001f\u007f]/.test(value.model));
  ensure(Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 && value.maxOutputTokens <= 1000000);
  return value;
}
function baseUrl(profile) {
  const base = HOSTS[profile.provider];
  if (base) {
    ensure(profile.endpoint === undefined || profile.endpoint === base || profile.endpoint === `${base}/`);
    return base;
  }
  ensure(typeof profile.endpoint === 'string' && profile.endpoint.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(profile.endpoint));
  const url = new URL(profile.endpoint);
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  ensure(!url.username && !url.password && !url.search && !url.hash);
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && local));
  if (profile.provider === 'ollama') ensure(local && url.pathname === '/');
  return url.href.replace(/\/$/, '');
}
export function buildModelRequest(input, prompt, credential) {
  try {
    const profile = settings(input);
    nonempty(prompt, 65536);
    const base = baseUrl(profile);
    const headers = { 'content-type': 'application/json' };
    if (credential !== undefined) ensure(typeof credential === 'string' && credential.length > 0
      && credential.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(credential));
    if (HOSTS[profile.provider]) ensure(credential !== undefined);
    const { model, maxOutputTokens } = profile;
    const messages = [{ role: 'user', content: prompt }];
    let url; let body;
    switch (profile.provider) {
      case 'anthropic':
        url = `${base}/v1/messages`;
        Object.assign(headers, { 'x-api-key': credential, 'anthropic-version': '2023-06-01' });
        body = { model, max_tokens: maxOutputTokens, messages };
        break;
      case 'openai':
        url = `${base}/v1/responses`; headers.authorization = `Bearer ${credential}`;
        body = { model, input: prompt, max_output_tokens: maxOutputTokens, store: false };
        break;
      case 'gemini':
        url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        headers['x-goog-api-key'] = credential;
        body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens } };
        break;
      case 'ollama':
        url = `${base}/api/chat`;
        body = { model, messages, stream: false, options: { num_predict: maxOutputTokens } };
        break;
      case 'openai-compatible':
        url = `${base}/chat/completions`;
        if (credential !== undefined) headers.authorization = `Bearer ${credential}`;
        body = { model, messages, max_tokens: maxOutputTokens, stream: false };
        break;
    }
    return { url, headers, body };
  } catch { fail(); }
}
function fields(value, allowed) {
  ensure(value && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.keys(value).every(key => allowed.includes(key)));
}
function noCalls(message) {
  ensure(message && message.role === 'assistant');
  ensure(message.tool_calls === undefined || (Array.isArray(message.tool_calls) && message.tool_calls.length === 0));
  ensure(message.function_call === undefined || message.function_call === null);
  ensure(message.refusal === undefined || message.refusal === null);
}
export function parseModelResponse(input, data) {
  try {
    const profile = settings(input);
    const response = snapshot(data);
    ensure(response && typeof response === 'object' && !Array.isArray(response) && !response.error);
    let text; let model = response.model; let inputTokens; let outputTokens;
    switch (profile.provider) {
      case 'anthropic': {
        ensure(response.type === 'message' && response.role === 'assistant' && response.stop_reason === 'end_turn');
        ensure(Array.isArray(response.content) && response.content.length > 0);
        text = response.content.map(part => {
          fields(part, ['type','text','citations']);
          ensure(part.type === 'text'); return nonempty(part.text, 262144);
        }).join('');
        inputTokens = tokenCount(response.usage?.input_tokens)
          + tokenCount(response.usage?.cache_creation_input_tokens ?? 0)
          + tokenCount(response.usage?.cache_read_input_tokens ?? 0);
        outputTokens = tokenCount(response.usage?.output_tokens);
        break;
      }
      case 'openai': {
        ensure(response.status === 'completed' && !response.error && !response.incomplete_details);
        ensure(Array.isArray(response.output) && response.output.length > 0);
        text = response.output.map(item => {
          if (item.type === 'reasoning') {
            fields(item, ['type','id','summary','content','encrypted_content','status']);
            ensure(item.status === undefined || item.status === 'completed');
            if (item.summary !== undefined) { ensure(Array.isArray(item.summary)); for (const part of item.summary) { fields(part,['type','text']);ensure(part.type === 'summary_text' && typeof part.text === 'string'); } }
            if (item.content !== undefined) { ensure(Array.isArray(item.content));for (const part of item.content) { fields(part,['type','text']);ensure(part.type === 'reasoning_text' && typeof part.text === 'string'); } }
            return '';
          }
          fields(item, ['type','id','status','role','content','phase']);
          ensure(item.type === 'message' && item.role === 'assistant' && item.status === 'completed');
          ensure(Array.isArray(item.content) && item.content.length > 0);
          return item.content.map(part => {
            fields(part,['type','text','annotations','logprobs']);
            ensure(part.type === 'output_text'); return nonempty(part.text,262144);
          }).join('');
        }).join('');
        inputTokens = tokenCount(response.usage?.input_tokens);
        outputTokens = tokenCount(response.usage?.output_tokens);
        if (response.usage?.output_tokens_details?.reasoning_tokens !== undefined) {
          ensure(tokenCount(response.usage.output_tokens_details.reasoning_tokens) <= outputTokens);
        }
        break;
      }
      case 'gemini': {
        ensure(!response.promptFeedback?.blockReason && Array.isArray(response.candidates) && response.candidates.length === 1);
        const candidate = response.candidates[0];
        ensure(candidate.finishReason === 'STOP' && candidate.content?.role === 'model' && Array.isArray(candidate.content.parts));
        ensure(!candidate.safetyRatings?.some(rating => rating.blocked === true));
        if (candidate.content.parts.some(part => part.thought === true)) tokenCount(response.usageMetadata?.thoughtsTokenCount);
        text = candidate.content.parts.map(part => {
          fields(part,['text','thought','thoughtSignature']);
          ensure(part.thought === undefined || typeof part.thought === 'boolean');
          const content = nonempty(part.text,262144);return part.thought === true ? '' : content;
        }).join('');
        model = response.modelVersion;
        inputTokens = tokenCount(response.usageMetadata?.promptTokenCount);
        outputTokens = tokenCount(response.usageMetadata?.candidatesTokenCount) + tokenCount(response.usageMetadata?.thoughtsTokenCount ?? 0);
        break;
      }
      case 'ollama':
        ensure(response.done === true && response.done_reason === 'stop');
        fields(response.message, ['role','content','thinking','tool_calls']);
        noCalls(response.message);
        ensure(response.message.thinking === undefined || typeof response.message.thinking === 'string');
        text = response.message.content;
        inputTokens = tokenCount(response.prompt_eval_count); outputTokens = tokenCount(response.eval_count);
        break;
      case 'openai-compatible': {
        ensure(Array.isArray(response.choices) && response.choices.length === 1);
        const choice = response.choices[0];
        ensure(choice.finish_reason === 'stop'); noCalls(choice.message);
        fields(choice.message,['role','content','refusal','tool_calls','function_call','annotations','audio']);
        ensure(choice.message.audio === undefined || choice.message.audio === null);
        text = choice.message.content;
        inputTokens = tokenCount(response.usage?.prompt_tokens); outputTokens = tokenCount(response.usage?.completion_tokens);
        if (response.usage?.completion_tokens_details?.reasoning_tokens !== undefined) {
          ensure(tokenCount(response.usage.completion_tokens_details.reasoning_tokens) <= outputTokens);
        }
        break;
      }
    }
    nonempty(text,262144); nonempty(model,800);
    ensure(!/[\u0000-\u001f\u007f]/.test(model));
    tokenCount(inputTokens); tokenCount(outputTokens);
    ensure(outputTokens <= profile.maxOutputTokens);
    return { text, model, usage: { inputTokens, outputTokens } };
  } catch { fail(); }
}
