import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { modelsCommand } from '../../src/commands/models.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-delegate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { provider: 'ollama', model: 'example', endpoint: 'http://localhost:11434', timeoutMs: 1000, maxOutputTokens: 100 };
  await writeFile(join(root, 'model.json'), JSON.stringify(profile));
  const calls = [], logs = [];
  const dependencies = { cwd: () => root, env: {}, terminalIsInteractive: () => true,
    output: { log: text => logs.push(text) }, confirmModelDelegation: async () => true,
    models: { delegateText: async input => { calls.push(input); return { provider: 'ollama', requestedModel: 'example', model: 'example', text: 'Advice', usage: { inputTokens: 3, outputTokens: 2 }, verified: false }; } } };
  return { root, profile, calls, logs, dependencies, parsed: { subcommand: 'delegate', operands: ['Review this approach'], flags: { profile: 'model.json' } } };
}
test('delegation previews exact prompt and destination and requires approval', async t => {
  const f = await fixture(t);
  f.dependencies.confirmModelDelegation = async preview => { assert.equal(preview.prompt, f.parsed.operands[0]); assert.match(preview.url, /localhost:11434\/api\/chat/); assert.match(f.logs.join('\n'), /Review this approach/); return true; };
  assert.equal(await modelsCommand(f.parsed, f.dependencies), 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].prompt, f.parsed.operands[0]);
  assert.match(f.logs.join('\n'), /Unverified advisory output/);
});
test('denied, noninteractive, json, unsupported budgets and profile drift never dispatch', async t => {
  for (const kind of ['deny', 'noninteractive', 'json', 'cost', 'timeout', 'drift', 'control']) {
    const f = await fixture(t);
    if (kind === 'deny') f.dependencies.confirmModelDelegation = async () => false;
    if (kind === 'noninteractive') f.dependencies.terminalIsInteractive = () => false;
    if (kind === 'json') f.parsed.flags.json = true;
    if (kind === 'control') f.parsed.operands[0] = '\x1b[2Jhidden';
    if (kind === 'cost' || kind === 'timeout') await writeFile(join(f.root, 'model.json'), JSON.stringify({ ...f.profile, ...(kind === 'cost' ? { maxCostUsd: 1 } : { timeoutMs: 120001 }) }));
    if (kind === 'drift') f.dependencies.confirmModelDelegation = async () => { await writeFile(join(f.root, 'model.json'), JSON.stringify({ ...f.profile, model: 'changed' })); return true; };
    await assert.rejects(modelsCommand(f.parsed, f.dependencies)); assert.equal(f.calls.length, 0, kind);
  }
});
test('aborted approval cannot dispatch', async t => {
  const f = await fixture(t); const controller = new AbortController(); f.dependencies.models.signal = controller.signal;
  f.dependencies.confirmModelDelegation = async () => { controller.abort(); return true; };
  await assert.rejects(modelsCommand(f.parsed, f.dependencies)); assert.equal(f.calls.length, 0);
});

test('public CLI routes approved delegation and rejects unattended invocation', async t => {
  const { main } = await import('../../src/cli/main.js');
  const f = await fixture(t);
  f.dependencies.output.error = text => f.logs.push(text);
  assert.equal(await main(['models', 'delegate', 'Review this approach', '--profile=model.json'], f.dependencies), 0);
  assert.equal(f.calls.length, 1);
  f.dependencies.terminalIsInteractive = () => false;
  assert.notEqual(await main(['models', 'delegate', 'Review this approach', '--profile=model.json'], f.dependencies), 0);
  assert.equal(f.calls.length, 1);
});

test('role text selection binds configuration across approval and active role never dispatches', async t => {
  for (const drift of [false, true]) {
    const f = await fixture(t);
    const config = { schemaVersion: 1, profiles: { local: f.profile }, roles: { review: { kind: 'text', profile: 'local' } } };
    await writeFile(join(f.root, 'roles.json'), JSON.stringify(config));
    f.parsed.flags = { roles: 'roles.json', role: 'review' };
    f.dependencies.confirmModelDelegation = async () => {
      if (drift) await writeFile(join(f.root, 'roles.json'), JSON.stringify({ ...config, roles: {} }));
      return true;
    };
    if (drift) await assert.rejects(modelsCommand(f.parsed, f.dependencies));
    else await modelsCommand(f.parsed, f.dependencies);
    assert.equal(f.calls.length, drift ? 0 : 1);
    f.parsed.flags.role = 'planning';
    await modelsCommand(f.parsed, f.dependencies);
    assert.equal(f.calls.length, drift ? 0 : 1);
    assert.match(f.logs.join('\n'), /active harness/);
  }
});

test('role inspection is read-only and conflicting selectors cannot dispatch', async t => {
  const { main } = await import('../../src/cli/main.js');
  const f = await fixture(t);
  await writeFile(join(f.root, 'roles.json'), JSON.stringify({ schemaVersion: 1, profiles: {}, roles: {} }));
  let payload;
  f.dependencies.output.json = value => { payload = value; };
  f.dependencies.output.error = text => f.logs.push(text);
  assert.equal(await main(['models', 'role', '--roles=roles.json', '--role=planning', '--json'], f.dependencies), 0);
  assert.equal(payload.result.target.kind, 'active-harness');
  for (const extra of [['--profile=model.json'], ['--json'], ['--project=.']]) {
    assert.notEqual(await main(['models', 'delegate', 'Task', '--roles=roles.json', '--role=planning', ...extra], f.dependencies), 0);
  }
  assert.equal(f.calls.length, 0);
});
