import { createModelRegistry } from './registry.js';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
function fail() { throw new TypeError('Invalid model role configuration.'); }
function record(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length > 64) fail();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !ID.test(key) || ['constructor', 'prototype'].includes(key)
      || (allowed && !allowed.includes(key)) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}

// Explicit role selection is separate from automatic workflow-node routing.
// Unassigned roles stay with the caller's active harness and spawn nothing.
export function resolveRoleProfile(input, role) {
  try {
    if (typeof role !== 'string' || !ID.test(role)) fail();
    // schemaVersion is the sole camel-case field in this versioned envelope.
    const version = Object.getOwnPropertyDescriptor(input ?? {}, 'schemaVersion');
    if (!version?.enumerable || !Object.hasOwn(version, 'value') || version.value !== 1) fail();
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).length !== 3) fail();
    const profilesField = Object.getOwnPropertyDescriptor(input, 'profiles');
    const rolesField = Object.getOwnPropertyDescriptor(input, 'roles');
    if (!profilesField?.enumerable || !Object.hasOwn(profilesField, 'value')
      || !rolesField?.enumerable || !Object.hasOwn(rolesField, 'value')) fail();
    const registry = createModelRegistry();
    const profiles = record(profilesField.value);
    for (const key of Object.keys(profiles)) {
      const resolved = registry.resolve(profiles[key], { requiredCapabilities: ['text'] });
      if (resolved.provider.kind === 'harness') fail();
      profiles[key] = resolved.profile;
    }
    const roles = record(rolesField.value);
    for (const key of Object.keys(roles)) {
      const target = record(roles[key], ['kind', 'profile', 'harness']);
      if (target.kind === 'active-harness' && Object.keys(target).length === 1) roles[key] = Object.freeze({ kind: target.kind });
      else if (target.kind === 'harness' && Object.keys(target).length === 2 && ['claude', 'codex'].includes(target.harness)) {
        roles[key] = Object.freeze({ kind: target.kind, harness: target.harness });
      } else if (target.kind === 'text' && Object.keys(target).length === 2 && typeof target.profile === 'string' && Object.hasOwn(profiles, target.profile)) {
        roles[key] = Object.freeze({ kind: target.kind, profileId: target.profile, profile: profiles[target.profile] });
      } else fail();
    }
    return Object.freeze({ role, target: roles[role] ?? Object.freeze({ kind: 'active-harness' }) });
  } catch { fail(); }
}
