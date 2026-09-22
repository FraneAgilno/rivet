import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from './run-cli.js';

test('assertion diagnostics redact sensitive values without corrupting exit codes', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'rivet-redaction-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(join(projectDir, 'package.json'), '{"private":true}\n');

  const controlledSecret = 'controlled-fixture-token-value';
  const result = await runCli(['unknown-command'], {
    cwd: projectDir,
    env: {
      CHARACTERIZATION_API_TOKEN: controlledSecret,
      CHARACTERIZATION_LOW_ENTROPY_TOKEN: '1',
    },
  });
  result.stderr += `\ncontrolled diagnostic: ${controlledSecret}`;

  assert.throws(
    () => result.assertSuccess(),
    error => {
      assert.doesNotMatch(error.message, new RegExp(controlledSecret));
      assert.match(error.message, /controlled diagnostic: \[REDACTED\]/);
      assert.match(error.message, /CLI exited with code 1/);
      assert.match(error.message, /Usage:/);
      return true;
    },
  );
});
