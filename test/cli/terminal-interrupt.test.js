import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const probe = new URL('../fixtures/terminal-interrupt-probe.py', import.meta.url).pathname;

for (const [stage, signal] of [
  ['planning', 'SIGINT'],
  ['planning', 'SIGTERM'],
  ['planning-descendant', 'SIGINT'],
  ['probe-descendant', 'SIGTERM'],
  ['approval', 'SIGINT'],
  ['worker', 'SIGINT'],
  ['worker', 'SIGTERM'],
  ['worker-descendant', 'SIGINT'],
  ['worker-descendant', 'SIGTERM'],
  ['gate', 'SIGINT'],
  ['gate', 'SIGTERM'],
  ['gate-descendant', 'SIGTERM'],
  ['gate-descendant-pid', 'SIGTERM'],
  ['resume', 'SIGINT'],
]) {
  test(`real terminal ${signal} during ${stage} leaves no detached writer`, async t => {
    if (process.platform === 'win32') return t.skip('Rivet terminal adapters do not support Windows');
    let stdout;
    try {
      ({ stdout } = await execFile('python3', [probe, stage, signal], {
        timeout: 35_000, maxBuffer: 64 * 1024,
      }));
    } catch (error) {
      if (error?.code === 'ENOENT') return t.skip('python3 PTY helper is unavailable');
      throw error;
    }
    const result = JSON.parse(stdout.trim());
    assert.equal(result.stage, stage);
    assert.equal(result.signal, signal);
    assert.equal(result.cli_returncode, 6);
    if (stage === 'approval') assert.equal(result.activated, false);
    else {
      assert.equal(result.child_survived, false);
      assert.equal(result.heartbeat_after, result.heartbeat_before);
    }
  });
}
