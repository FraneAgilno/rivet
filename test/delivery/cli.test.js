import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/cli/main.js';

for (const args of [
  ['delivery', 'merge'],
  ['delivery', 'prepare', '--verification-json={}'],
  ['delivery', 'prepare', '--receipt={}'],
  ['delivery', 'status', '--remote=origin'],
  ['delivery', 'prepare', '--run=../../outside'],
]) {
  test(`delivery rejects unsupported authority or selectors: ${args.join(' ')}`, async () => {
    let result;
    const code = await main([...args, '--json'], {
      cwd: () => '/missing-delivery-project',
      env: {},
      output: {
        json: (value) => {
          result = value;
        },
        error() {},
        log() {},
      },
    });
    assert.notEqual(code, 0);
    assert.equal(result.ok, false);
  });
}
