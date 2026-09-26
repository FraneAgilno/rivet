import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePackageSmokeOptions } from '../../scripts/package-smoke-options.mjs';
const args = ['--artifact-dir=/tmp/candidate', `--source-sha=${'a'.repeat(40)}`, `--artifact-sha256=${'b'.repeat(64)}`, '--tag=v0.1.0-alpha.0', '--report=/tmp/evidence.json'];
test('checkout smoke stays compatible; external smoke requires trusted artifact bindings', () => {
  assert.deepEqual(parsePackageSmokeOptions([]), { mode: 'checkout' });
  const value = parsePackageSmokeOptions(args);
  assert.equal(value.mode, 'artifact');
  assert.equal(value.expectedArtifactSha256, 'b'.repeat(64));
  assert.equal(value.expectedSourceSha, 'a'.repeat(40));
  for (let index = 0; index < args.length; index++) assert.throws(() => parsePackageSmokeOptions(args.filter((_, i) => i !== index)));
});
test('external smoke rejects ambiguous, unsafe and unbound inputs', () => {
  for (const bad of [ [...args, args[0]], [...args, '--ignore-checksum=true'], args.map(a => a.startsWith('--artifact-dir=') ? '--artifact-dir=../candidate' : a),
    args.map(a => a.startsWith('--tag=') ? '--tag=main' : a), args.map(a => a.startsWith('--source-sha=') ? '--source-sha=HEAD' : a),
    args.map(a => a.startsWith('--report=') ? '--report=/tmp/../evidence.json' : a)]) assert.throws(() => parsePackageSmokeOptions(bad));
});
