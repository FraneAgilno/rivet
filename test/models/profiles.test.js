import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoleProfile } from '../../src/models/profiles.js';
const profile = { provider: 'ollama', model: 'tiny', endpoint: 'http://localhost:11434', timeoutMs: 1000, maxOutputTokens: 100 };
const config = { schemaVersion: 1, profiles: { local: profile }, roles: { review: { kind: 'text', profile: 'local' }, implementation: { kind: 'harness', harness: 'codex' } } };
test('unassigned roles stay in the active harness; explicit targets resolve immutably', () => {
  assert.deepEqual(resolveRoleProfile(config, 'planning').target, { kind: 'active-harness' });
  const result = resolveRoleProfile(config, 'review');
  assert.equal(result.target.profile.model, 'tiny'); assert.ok(Object.isFrozen(result.target.profile));
  assert.equal(resolveRoleProfile(config, 'implementation').target.harness, 'codex');
});
test('unknown profiles, unsupported targets and hidden unsafe settings reject without getters', () => {
  for (const target of [{ kind: 'text', profile: 'missing' }, { kind: 'harness', harness: 'unknown' }, { kind: 'active-harness', model: 'hidden' }]) {
    assert.throws(() => resolveRoleProfile({ ...config, roles: { review: target } }, 'review'));
  }
  let called = false;
  assert.throws(() => resolveRoleProfile({ ...config, get roles() { called = true; return {}; } }, 'review'));
  assert.equal(called, false);
  assert.throws(() => resolveRoleProfile({ ...config, roles: JSON.parse('{"__proto__":{"kind":"active-harness"}}') }, 'review'));
  assert.throws(() => resolveRoleProfile(config, '../review'));
});
