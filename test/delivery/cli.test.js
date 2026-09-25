import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/cli/main.js';

for (const args of [
  ['delivery', 'merge'],
  ['delivery', 'deploy'],
  ['delivery', 'deploy', '--method=merge'],
  ['delivery', 'deploy', '--environment=production'],
  ['delivery', 'prepare', '--verification-json={}'],
  ['delivery', 'prepare', '--receipt={}'],
  ['delivery', 'status', '--remote=origin'],
  ['delivery', 'prepare', '--run=../../outside'],
  ['delivery', 'recover', '--force'],
  ['delivery', 'recover', '--provider=github-team'],
  ['delivery', 'recover', '--pid=1'],
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

test('delivery parser accepts scoped remote operations and explicit merge method', async () => {
  const { parseArgs } = await import('../../src/cli/parse-args.js');
  const parsed = parseArgs(['delivery', 'merge', '--method=squash', '--provider=github-team']);
  assert.equal(parsed.subcommand, 'merge');
  assert.equal(parsed.flags.method, 'squash');
  assert.equal(parsed.flags.provider, 'github-team');
});
