import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { parseArgs } from '../../src/cli/parse-args.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    output: createOutput({
      stdout: { write: value => { stdout += value; } },
      stderr: { write: value => { stderr += value; } },
    }),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test('parses strict host work commands', () => {
  assert.deepEqual(parseArgs([
    'work', 'propose', '--project=/repo', '--request-text=# Change\n\n## Acceptance criteria\n- Works',
    '--decomposition=/repo/plan.json', '--json',
  ]), {
    command: 'work', subcommand: 'propose', operands: [],
    flags: {
      project: '/repo',
      'request-text': '# Change\n\n## Acceptance criteria\n- Works',
      decomposition: '/repo/plan.json',
      json: true,
    },
  });
  assert.deepEqual(parseArgs(['work', 'next', 'run-one', '--project=/repo', '--expected-runtime-version=2']), {
    command: 'work', subcommand: 'next', operands: ['run-one'],
    flags: { project: '/repo', 'expected-runtime-version': '2' },
  });
  assert.throws(() => parseArgs(['work', 'next', 'run-one', '--unsafe=yes']), /Unknown option/);
});

test('propose reads a bounded decomposition and uses host planning without a model selector', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-work-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const decompositionPath = join(root, 'plan.json');
  const decomposition = {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [{ objective: 'Implement it.', ownedPaths: ['src/change.js'], acceptanceCriterionIndexes: [1] }],
  };
  await writeFile(decompositionPath, JSON.stringify(decomposition));
  let received;
  const output = capture();
  const exitCode = await main([
    'work', 'propose', `--project=${root}`,
    '--request-text=# Change\n\n## Acceptance criteria\n- Works',
    `--decomposition=${decompositionPath}`, '--json',
  ], {
    output: output.output,
    feature: {
      async propose(input) {
        received = input;
        return { runId: 'change-abc123', version: 1, status: 'proposed', proposalDigest: 'a'.repeat(64) };
      },
    },
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(received.client, 'host');
  assert.deepEqual(received.decomposition, decomposition);
  assert.equal(JSON.parse(output.stdout()).result.runId, 'change-abc123');
  assert.equal(output.stderr(), '');
});

test('prepare, next, and status delegate exact optimistic-concurrency inputs', async () => {
  const calls = [];
  const output = capture();
  const work = {
    async prepare(input) { calls.push(['prepare', input]); return { status: 'ready', runtimeVersion: 1 }; },
    async nextAction(input) { calls.push(['nextAction', input]); return { status: 'idle', runtimeVersion: 2, action: null }; },
    async status(input) { calls.push(['status', input]); return { run: { runId: input.runId }, runtime: null }; },
  };
  assert.equal(await main(['work', 'prepare', 'run-one', '--project=/repo', '--expected-version=3', '--json'], { output: output.output, work }), 0);
  assert.equal(await main(['work', 'next', 'run-one', '--project=/repo', '--expected-runtime-version=1', '--json'], { output: output.output, work }), 0);
  assert.equal(await main(['work', 'status', 'run-one', '--project=/repo', '--json'], { output: output.output, work }), 0);
  assert.deepEqual(calls, [
    ['prepare', { project: '/repo', runId: 'run-one', expectedRunVersion: 3 }],
    ['nextAction', { project: '/repo', runId: 'run-one', expectedRuntimeVersion: 1 }],
    ['status', { project: '/repo', runId: 'run-one' }],
  ]);
});

test('submit and verify pass serialized host results through exact version bindings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-work-submit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const action = { kind: 'action-fixture' };
  const result = { status: 'success' };
  await writeFile(join(root, 'action.json'), JSON.stringify(action));
  await writeFile(join(root, 'result.json'), JSON.stringify(result));
  const calls = [];
  const output = capture();
  const work = {
    async submitResult(input) { calls.push(['submitResult', input]); return { status: 'accepted', runtimeVersion: 4 }; },
    async verify(input) { calls.push(['verify', input]); return { status: 'awaiting-final-approval', version: 5 }; },
  };
  assert.equal(await main([
    'work', 'submit', 'run-one', `--project=${root}`, '--expected-runtime-version=3',
    `--action=${join(root, 'action.json')}`, `--result=${join(root, 'result.json')}`, '--json',
  ], { output: output.output, work }), 0);
  assert.equal(await main([
    'work', 'verify', 'run-one', `--project=${root}`, '--expected-version=2',
    '--expected-runtime-version=4', '--json',
  ], { output: output.output, work }), 0);
  assert.deepEqual(calls, [
    ['submitResult', {
      project: root, runId: 'run-one', expectedRuntimeVersion: 3, action, result,
    }],
    ['verify', {
      project: root, runId: 'run-one', expectedRunVersion: 2, expectedRuntimeVersion: 4,
    }],
  ]);
});

test('work JSON inputs reject a symlinked parent directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-work-linked-parent-'));
  const external = await mkdtemp(join(tmpdir(), 'rivet-work-external-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]));
  await mkdir(join(root, '.git'));
  await writeFile(join(external, 'plan.json'), JSON.stringify({ schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [] }));
  await symlink(external, join(root, 'linked'));
  const output = capture();
  const exitCode = await main([
    'work', 'propose', `--project=${root}`,
    '--request-text=# Change\n\n## Acceptance criteria\n- Works',
    `--decomposition=${join(root, 'linked', 'plan.json')}`, '--json',
  ], { output: output.output, feature: { async propose() { throw new Error('must not run'); } } });
  assert.equal(exitCode, EXIT_CODES.REPOSITORY_CONFLICT);
});
