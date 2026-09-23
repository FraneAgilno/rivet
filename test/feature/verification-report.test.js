import assert from 'node:assert/strict';
import test from 'node:test';

import { verificationReport } from '../../src/feature/verification-report.js';

test('verification report retains a bounded failure tail and accurate execution flags', () => {
  const report = verificationReport({
    run: { runId: 'feature-one', version: 3, featurePlan: { baselineCommit: 'a'.repeat(40) } },
    state: {
      version: 7,
      graph: { nodes: [{ id: 'worker-one', owner: { role: 'worker' } }] },
      evidence: [{ id: 'worker-claim', nodeId: 'worker-one' }],
    },
    integration: { path: '/tmp/integration', branch: 'feature/one' },
    commitSha: 'b'.repeat(40),
    changedPaths: ['src/feature.js'],
    quality: {
      status: 'fail',
      gates: [{
        id: 'test', status: 'failed', required: true, cwd: '.', exitCode: 1,
        executionStatus: 'output-overflow',
        output: {
          stdout: `${'x'.repeat(140)}ACTUAL ASSERTION FAILURE`,
          stderr: '', redacted: false, suppressed: false,
          truncated: { stdout: true, stderr: false, combined: true },
        },
      }],
    },
    checkedAt: '2026-09-23T00:00:00.000Z',
  });
  assert.deepEqual(report.workerClaims, ['worker-claim']);
  assert.equal(report.checks[0].status, 'failed');
  assert.match(report.checks[0].output.stdout, /ACTUAL ASSERTION FAILURE/);
  assert.equal(report.checks[0].output.truncated.stdout, true);
  assert.equal(report.checks[0].output.truncated.stderr, false);
  assert.equal(report.checks[0].output.truncated.combined, true);
  assert.equal(report.checks[0].output.suppressed, false);
  assert.ok(report.checks[0].output.stdout.length <= 512);
});
