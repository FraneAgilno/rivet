import assert from 'node:assert/strict';
import test from 'node:test';

async function registryModule() {
  try { return await import('../../src/models/registry.js'); }
  catch (error) { assert.fail(`Model registry is unavailable: ${error.code}`); }
}

test('registry includes hosted, local, compatible and harness adapters with honest readiness', async () => {
  const { createModelRegistry } = await registryModule();
  const providers = createModelRegistry().list();
  for (const id of ['anthropic', 'openai', 'gemini', 'ollama', 'openai-compatible', 'claude-code', 'codex']) {
    assert.ok(providers.some(provider => provider.id === id), id);
  }
  assert.equal(providers.find(p => p.id === 'gemini').kind, 'api');
  assert.equal(providers.find(p => p.id === 'ollama').kind, 'local');
  assert.equal(providers.find(p => p.id === 'codex').kind, 'harness');
  assert.equal(providers.find(p => p.id === 'gemini').execution, 'planned');
  assert.equal(providers.every(p => p.liveVerified === false), true);
});

test('custom adapters and arbitrary model IDs do not require workflow changes', async () => {
  const { createModelRegistry } = await registryModule();
  const registry = createModelRegistry();
  registry.register({ id: 'company-model', label: 'Company', kind: 'api', protocol: 'company-v1', capabilities: ['text'], execution: 'planned' });
  const result = registry.resolve({ provider: 'company-model', model: 'team/model-2027', timeoutMs: 1000, maxOutputTokens: 100, credentialEnv: 'COMPANY_API_KEY' });
  assert.equal(result.profile.model, 'team/model-2027');
  assert.equal(result.provider.id, 'company-model');
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['adapter-not-implemented']);
});

test('profiles validate endpoints, credentials and bounded limits without accepting secrets', async () => {
  const { createModelRegistry } = await registryModule();
  const registry = createModelRegistry();
  const profile = { provider: 'gemini', model: 'configured-model', timeoutMs: 1000, maxOutputTokens: 100 };
  for (const patch of [
    { provider: 'missing' }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { maxOutputTokens: -1 }, { apiKey: 'not-allowed' }, { credentialEnv: 'not-an-env-name' },
    { endpoint: 'http://external.example/v1' }, { endpoint: 'https://user:password@example.com' },
    { endpoint: 'https://example.com/?key=secret' }, { model: 'bad\nmodel' },
    { endpoint: 'http://127.0.0.1:11434', provider: 'gemini' },
  ]) assert.throws(() => registry.resolve({ ...profile, ...patch }), /Invalid model profile/);
  const local = registry.resolve({ ...profile, provider: 'ollama', endpoint: 'http://127.0.0.1:11434' });
  assert.equal(local.profile.endpoint, 'http://127.0.0.1:11434/');
});

test('capability mismatch, duplicates and mutable input cannot change registered policy', async () => {
  const { createModelRegistry } = await registryModule();
  const registry = createModelRegistry();
  const capabilities = ['text'];
  const valid = { id: 'invalid-test', label: 'Custom', kind: 'local', protocol: 'custom', capabilities, execution: 'planned' };
  for (const patch of [{ id: undefined }, { id: null }, { protocol: undefined }, { protocol: null }]) {
    assert.throws(() => registry.register({ ...valid, ...patch }), /Invalid model adapter/);
  }
  registry.register({ id: 'custom', label: 'Custom', kind: 'local', protocol: 'custom', capabilities, execution: 'planned' });
  capabilities.push('workspace-write');
  assert.throws(() => registry.register({ id: 'custom', label: 'Duplicate', kind: 'local', protocol: 'custom', capabilities: ['text'], execution: 'planned' }), /already registered/);
  assert.throws(() => registry.resolve({ provider: 'custom', model: 'local', timeoutMs: 100, maxOutputTokens: 10 }, { requiredCapabilities: ['workspace-write'] }), /Missing model capability/);
  assert.deepEqual(registry.list().find(p => p.id === 'custom').capabilities, ['text']);
});
