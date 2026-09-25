import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../helpers/run-cli.js';

test('models list exposes providers and their actual execution status without network calls', async () => {
  const result = (await runCli(['models', 'list', '--json'])).assertSuccess();
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.providers.find(p => p.id === 'gemini').execution, 'adapter-available');
  assert.ok(payload.result.providers.some(p => p.id === 'ollama'));
});

test('models check validates a profile but does not claim readiness or use credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-model-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ provider: 'ollama', model: 'custom-local-model', endpoint: 'http://localhost:11434', timeoutMs: 1000, maxOutputTokens: 100 }));
  const result = (await runCli(['models', 'check', `--profile=${profile}`, '--json'])).assertSuccess();
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.ready, false);
  assert.equal(payload.result.profile.model, 'custom-local-model');
  await writeFile(profile, JSON.stringify({ apiKey: 'do-not-echo-this-value' }));
  const invalid = await runCli(['models', 'check', `--profile=${profile}`, '--json']);
  assert.notEqual(invalid.code, 0);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /do-not-echo-this-value/);
});

test('models rejects unknown options and commands', async () => {
  for (const args of [['models', 'run'], ['models', 'list', '--unexpected'], ['models', 'check']]) {
    const result = await runCli(args);
    assert.notEqual(result.code, 0);
  }
});
