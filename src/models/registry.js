const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]{1,127}$/;
const BUILTINS = [
  { id: 'anthropic', label: 'Anthropic API', kind: 'api', protocol: 'anthropic-messages' },
  { id: 'openai', label: 'OpenAI API', kind: 'api', protocol: 'openai-responses' },
  { id: 'gemini', label: 'Google Gemini API', kind: 'api', protocol: 'gemini-content' },
  { id: 'ollama', label: 'Ollama local models', kind: 'local', protocol: 'ollama-chat', allowLocalHttp: true },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', kind: 'api', protocol: 'openai-chat', allowLocalHttp: true },
  { id: 'claude-code', label: 'Claude Code harness', kind: 'harness', protocol: 'claude-cli', execution: 'adapter-available' },
  { id: 'codex', label: 'Codex harness', kind: 'harness', protocol: 'codex-cli', execution: 'adapter-available' },
];

function record(input, allowed, message) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError(message);
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(message);
    output[key] = descriptor.value;
  }
  return output;
}

function descriptor(input) {
  const message = 'Invalid model adapter';
  const value = record(input, ['id', 'label', 'kind', 'protocol', 'capabilities', 'execution', 'allowLocalHttp'], message);
  if (typeof value.id !== 'string' || !ID.test(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 120
    || /[\u0000-\u001f\u007f]/.test(value.label)
    || !['api', 'local', 'harness'].includes(value.kind) || typeof value.protocol !== 'string' || !ID.test(value.protocol)
    || !['planned', 'adapter-available'].includes(value.execution)
    || (value.allowLocalHttp !== undefined && typeof value.allowLocalHttp !== 'boolean')
    || !Array.isArray(value.capabilities) || value.capabilities.length < 1 || value.capabilities.length > 32
    || value.capabilities.some(item => typeof item !== 'string' || !ID.test(item))
    || new Set(value.capabilities).size !== value.capabilities.length) throw new TypeError(message);
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]), liveVerified: false });
}

function endpoint(value, provider) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && provider.allowLocalHttp))) throw new Error();
    return url.href;
  } catch { throw new TypeError('Invalid model profile'); }
}

export function createModelRegistry() {
  const providers = new Map();
  const register = input => {
    const provider = descriptor(input);
    if (providers.has(provider.id)) throw new TypeError('Model adapter already registered');
    providers.set(provider.id, provider);
    return provider;
  };
  for (const provider of BUILTINS) register({ capabilities: ['text'], execution: 'adapter-available', ...provider });

  return Object.freeze({
    register,
    list: () => Object.freeze([...providers.values()]),
    resolve(input, options = {}) {
      const message = 'Invalid model profile';
      const value = record(input, ['provider', 'model', 'endpoint', 'credentialEnv', 'timeoutMs', 'maxOutputTokens', 'maxCostUsd'], message);
      const provider = providers.get(value.provider);
      if (!provider || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
        || /[\u0000-\u001f\u007f]/.test(value.model)
        || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 3_600_000
        || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 1_000_000
        || (value.credentialEnv !== undefined && (typeof value.credentialEnv !== 'string' || !ENV.test(value.credentialEnv)))
        || (value.maxCostUsd !== undefined && (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd <= 0 || value.maxCostUsd > 10_000))) throw new TypeError(message);
      const settings = record(options, ['requiredCapabilities'], message);
      const required = settings.requiredCapabilities ?? [];
      if (!Array.isArray(required) || required.length > 32 || required.some(item => typeof item !== 'string' || !ID.test(item))) throw new TypeError(message);
      if (required.some(capability => !provider.capabilities.includes(capability))) throw new TypeError('Missing model capability');
      const profile = Object.freeze({ ...value, ...(value.endpoint === undefined ? {} : { endpoint: endpoint(value.endpoint, provider) }) });
      // Registry validation is not an authentication, executable, or live model probe.
      const reasons = Object.freeze([provider.execution === 'planned' ? 'adapter-not-implemented' : 'requires-runtime-check']);
      return Object.freeze({ provider, profile, ready: false, reasons });
    },
  });
}
