import assert from 'node:assert/strict';
import test from 'node:test';
import { missingCapabilities, validVersion } from '../../src/clients/compatibility.js';
import { createCodexClient, CODEX_ADAPTER_SYNTAX } from '../../src/clients/codex.js';

test('accepts bounded version labels without a release allowlist', () => {
  assert.equal(validVersion('codex-cli 99.0.0'), true);
  for (const value of ['', null, 'x\ny', 'x'.repeat(201)]) assert.equal(validVersion(value), false);
  assert.doesNotThrow(() => createCodexClient({ executable: '/missing/codex', expectedVersion: 'codex-cli 99.0.0', args: CODEX_ADAPTER_SYNTAX.args }));
  assert.doesNotThrow(() => createCodexClient({ executable: '/missing/codex', args: CODEX_ADAPTER_SYNTAX.args }));
});

test('requires actual option declarations, not mentions or prefix matches', () => {
  assert.deepEqual(missingCapabilities('  --sandbox <MODE>\n  -m, --model <MODEL>', ['--sandbox', '--model']), []);
  assert.deepEqual(missingCapabilities('use --sandbox here\n  --sandbox-extra <MODE>', ['--sandbox']), ['--sandbox']);
});

test('help probes bound output and time, reject failed processes, and honor cancellation', async t => {
  const { mkdtemp, realpath, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createProcessRunner } = await import('../../src/clients/process-runner.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-help-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const interpreter = await realpath(process.execPath);
  for (const [name, body] of [
    ['oversized', "process.stdout.write('x'.repeat(65537))"],
    ['failed', 'process.exit(2)'],
    ['timeout', 'setInterval(() => {}, 1000)'],
    ['cancelled', 'setInterval(() => {}, 1000)'],
    ['malformed', 'process.stdout.write(Buffer.from([255]))'],
  ]) {
    const executable = join(root, name);
    await writeFile(executable, '#!' + interpreter + '\n' + body, { mode: 0o700 });
    const controller = new AbortController();
    const runner = await createProcessRunner({ executable, interpreter, worktree: root, timeoutMs: 200, launchTimeoutMs: 200, signal: controller.signal });
    if (name === 'cancelled') controller.abort();
    await assert.rejects(() => runner.probeHelp('codex'), error => error.code === (name === 'cancelled' ? 'ERR_AGENT_ABORTED' : 'ERR_AGENT_PROVIDER_UNAVAILABLE'));
  }
});
