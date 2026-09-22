import assert from 'node:assert/strict';
import test from 'node:test';

import { REDACTED, redactSecrets } from '../../src/state/redact.js';

test('redacts configured and conventional secret keys without mutating input', () => {
  const input = {
    nested: {
      password: 'correct horse battery staple',
      accessToken: 'access-token-value',
      customCredential: 'private-value',
      tokenLimit: 5000,
      safe: 'conference-planner',
    },
  };

  const result = redactSecrets(input, { secretKeys: ['customCredential'] });

  assert.deepEqual(result, {
    nested: {
      password: REDACTED,
      accessToken: REDACTED,
      customCredential: REDACTED,
      tokenLimit: 5000,
      safe: 'conference-planner',
    },
  });
  assert.equal(input.nested.password, 'correct horse battery staple');
});

test('redacts authorization headers and token formats embedded in text', () => {
  const result = redactSecrets({
    headers: { Authorization: 'Bearer top-secret-access-token' },
    message: 'request used github_pat_11AA22BB33CC44DD55 and xoxb-123456789-abcdefghijk',
  }, { environment: {} });

  assert.equal(result.headers.Authorization, REDACTED);
  assert.equal(result.message.includes('github_pat_'), false);
  assert.equal(result.message.includes('xoxb-'), false);
  assert.match(result.message, /\[REDACTED\]/);
});

test('redacts values sourced from sensitive environment variables', () => {
  const environment = {
    JIRA_API_TOKEN: 'jira-private-value-12345',
    ORDINARY_SETTING: 'ordinary-setting-value',
    SHORT_SECRET: 's3cr3t',
  };
  const result = redactSecrets({
    message: 'failed with jira-private-value-12345; ordinary-setting-value remains; short s3cr3t removed',
  }, { environment });

  assert.equal(result.message.includes('jira-private-value-12345'), false);
  assert.equal(result.message.includes('ordinary-setting-value'), true);
  assert.equal(result.message.includes('s3cr3t'), false);
});

test('rejects cyclic and unsupported values instead of partially redacting them', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => redactSecrets(cyclic), /redact a cyclic value/);
  assert.throws(() => redactSecrets({ value: 1n }), /JSON-compatible/);
});

test('preserves a JSON __proto__ property without changing the result prototype', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
  const result = redactSecrets(input);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.deepEqual(result.__proto__, { polluted: true });
  assert.equal({}.polluted, undefined);
});
