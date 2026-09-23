import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const execFile = promisify(execFileCallback);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('real CLI completes host work, reports failed checks, and stops at human review', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-first-task-')));
  const root = join(parent, 'project');
  const remote = join(parent, 'origin.git');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'first-task-fixture', private: true,
    scripts: {
      build: 'node -e "process.exit(0)"',
      test: 'node -e "require(\'first-task-local-dep\')"',
      lint: 'node -e "process.exit(0)"',
    },
  }));
  await writeFile(join(root, 'README.md'), '# First task fixture\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await execFile('git', ['init', '--quiet', '--bare', remote]);
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  const setup = JSON.parse((await execFile(process.execPath, [
    join(PACKAGE_ROOT, 'bin', 'cli.js'), 'setup', `--project=${root}`, '--write', '--json',
  ], { cwd: PACKAGE_ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })).stdout);
  assert.equal(setup.status, 'configured');
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture']);
  await execFile('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  await execFile('git', ['-C', root, 'push', '--quiet', '-u', 'origin', 'main']);
  const baseline = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const remoteRefs = (await execFile('git', ['--git-dir', remote, 'for-each-ref',
    '--format=%(refname):%(objectname)', 'refs/heads'])).stdout;
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: parent,
    RIVET_GIT_EXECUTABLE: await realpath((await execFile('which', ['git'])).stdout.trim()),
    RIVET_NPM_EXECUTABLE: await realpath((await execFile('which', ['npm'])).stdout.trim()),
  };
  const cli = async args => {
    const { stdout } = await execFile(process.execPath, [join(PACKAGE_ROOT, 'bin', 'cli.js'), ...args, '--json'], {
      cwd: PACKAGE_ROOT, env: environment, maxBuffer: 4 * 1024 * 1024,
    });
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    return response.result;
  };

  const readiness = JSON.parse((await execFile(process.execPath, [
    join(PACKAGE_ROOT, 'bin', 'cli.js'), 'preflight', `--project=${root}`, '--mode=host', '--json',
  ], { cwd: PACKAGE_ROOT, env: environment })).stdout);
  assert.equal(readiness.status, 'pass');
  assert.equal(readiness.checks.some(check => check.id === 'goal-state'), false);

  const decompositionJson = JSON.stringify({
    schemaVersion: 1, kind: 'agilno.feature-decomposition',
    workItems: [{
      objective: 'Add the greeting module.',
      ownedPaths: ['src/greeting.js'],
      acceptanceCriterionIndexes: [1],
    }],
  });
  const proposal = await cli(['work', 'propose', `--project=${root}`,
    '--request-text=# Add a greeting\n\n## Acceptance criteria\n\n- Add a greeting module.\n',
    `--decomposition-json=${decompositionJson}`]);
  assert.equal(proposal.status, 'proposed');
  const approved = await cli(['feature', 'start', proposal.runId, `--project=${root}`,
    `--expected-version=${proposal.version}`, `--proposal-digest=${proposal.proposalDigest}`]);
  assert.equal(approved.status, 'approved');
  const unprepared = await cli(['work', 'status', proposal.runId, `--project=${root}`]);
  assert.equal(unprepared.runtime, null);
  await assert.rejects(() => access(join(parent, '.rivet-worktrees')));
  await assert.rejects(() => cli(['work', 'status', 'missing-run', `--project=${root}`]));
  await assert.rejects(() => access(join(root, '.git', 'rivet', 'feature-runs', 'missing-run')));
  let resumeError;
  try {
    await cli(['feature', 'resume', proposal.runId, `--project=${root}`,
      `--expected-version=${approved.version}`]);
  } catch (error) { resumeError = error; }
  assert.equal(resumeError?.code, EXIT_CODES.INVALID_INPUT);
  assert.match(JSON.parse(resumeError.stderr).error.message, /work status and work next/);
  assert.equal((await cli(['work', 'status', proposal.runId, `--project=${root}`])).run.version,
    approved.version);
  await assert.rejects(() => access(join(parent, '.rivet-worktrees')));
  const prepared = await cli(['work', 'prepare', proposal.runId, `--project=${root}`,
    `--expected-version=${approved.version}`]);
  assert.equal(prepared.status, 'ready');
  const next = await cli(['work', 'next', proposal.runId, `--project=${root}`,
    `--expected-runtime-version=${prepared.runtimeVersion}`]);
  assert.equal(next.status, 'action');
  const worktree = JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(worktree, 'src'));
  await writeFile(join(worktree, 'src', 'greeting.js'), "export const greeting = 'hello';\n");

  const interrupted = await cli(['work', 'status', proposal.runId, `--project=${root}`]);
  assert.equal(interrupted.run.status, 'running');
  assert.equal(interrupted.runtime.version, next.runtimeVersion);
  const pending = await cli(['work', 'next', proposal.runId, `--project=${root}`,
    `--expected-runtime-version=${interrupted.runtime.version}`]);
  assert.equal(pending.status, 'waiting-for-result');
  assert.deepEqual(pending.action, next.action);

  const resultJson = JSON.stringify({
    version: 1, status: 'success',
    output: {
      summary: 'Added the greeting module.',
      evidence: JSON.parse(pending.action.payload).contract.evidence,
    },
    usage: { tokens: 1, costUsd: 0 },
  });
  const submitted = await cli(['work', 'submit', proposal.runId, `--project=${root}`,
    `--expected-runtime-version=${pending.runtimeVersion}`,
    `--action-json=${JSON.stringify(pending.action)}`, `--result-json=${resultJson}`]);
  assert.equal(submitted.status, 'accepted');
  await assert.rejects(() => access(join(root, '.git', 'rivet-inputs')));
  assert.equal((await execFile('git', ['-C', root, 'status', '--porcelain'])).stdout, '');
  let verificationError;
  try {
    await cli(['work', 'verify', proposal.runId, `--project=${root}`,
      `--expected-version=${prepared.run.version}`,
      `--expected-runtime-version=${submitted.runtimeVersion}`]);
  } catch (error) { verificationError = error; }
  assert.equal(verificationError?.code, EXIT_CODES.FAILED_GATE);
  assert.equal(JSON.parse(verificationError.stderr).error.code, 'FAILED_GATE');
  const failed = await cli(['work', 'status', proposal.runId, `--project=${root}`]);
  assert.equal(failed.run.status, 'running');
  assert.equal(failed.verification.status, 'fail');
  assert.match(failed.verification.commitSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(failed.verification.changedPaths, ['src/greeting.js']);
  assert.match(failed.verification.integration.branch, /^feature\//);
  assert.ok(failed.verification.workerClaims.length > 0);
  const failedCheck = failed.verification.checks.find(check => check.id === 'test');
  assert.equal(failedCheck?.status, 'failed');
  assert.equal(failedCheck.cwd, '.');
  assert.notEqual(failedCheck.exitCode, 0);
  assert.notEqual(failedCheck.executionStatus, 'success');
  assert.match(failedCheck.output.stderr, /Cannot find module|MODULE_NOT_FOUND/);
  assert.ok(failedCheck.output.stderr.length <= 512);
  assert.match(failed.nextAction, /unchanged integration checkout/);
  let staleError;
  try {
    await cli(['work', 'verify', proposal.runId, `--project=${root}`,
      `--expected-version=${prepared.run.version}`,
      `--expected-runtime-version=${submitted.runtimeVersion - 1}`]);
  } catch (error) { staleError = error; }
  assert.equal(staleError?.code, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal((await cli(['work', 'status', proposal.runId, `--project=${root}`])).verification.version,
    failed.verification.version);
  const testedCommit = failed.verification.commitSha;
  const integrationPath = failed.verification.integration.path;
  await mkdir(join(integrationPath, 'node_modules', 'first-task-local-dep'), { recursive: true });
  await writeFile(join(integrationPath, 'node_modules', 'first-task-local-dep', 'index.js'), 'module.exports = true;\n');
  assert.equal((await execFile('git', ['-C', integrationPath, 'rev-parse', 'HEAD'])).stdout.trim(), testedCommit);
  assert.equal((await execFile('git', ['-C', integrationPath, 'status', '--porcelain'])).stdout, '');
  const verified = await cli(['work', 'verify', proposal.runId, `--project=${root}`,
    `--expected-version=${prepared.run.version}`,
    `--expected-runtime-version=${submitted.runtimeVersion}`]);
  assert.equal(verified.status, 'awaiting-final-approval');
  const passed = await cli(['work', 'status', proposal.runId, `--project=${root}`]);
  assert.equal(passed.verification.status, 'pass');
  assert.equal(passed.verification.commitSha, testedCommit);
  assert.match(passed.nextAction, /final delivery decision/);
  const commitRef = verified.evidenceRefs.find(ref => /^commit:[a-f0-9]{40}$/.test(ref));
  assert.ok(commitRef);
  assert.equal((await execFile('git', ['-C', root, 'diff', '--name-only', baseline,
    commitRef.slice('commit:'.length)])).stdout.trim(), 'src/greeting.js');
  assert.deepEqual(verified.evidenceRefs.filter(ref => ref.startsWith('test:')).sort(),
    ['test:build', 'test:lint', 'test:test']);
  const observed = await cli(['work', 'status', proposal.runId, `--project=${root}`]);
  assert.equal(observed.run.status, 'awaiting-final-approval');
  assert.equal(observed.runtime.nodes.find(node => node.id === 'final-delivery').status, 'ready');

  const blockedDecomposition = JSON.stringify({
    schemaVersion: 1, kind: 'agilno.feature-decomposition',
    workItems: [{ objective: 'Add another module.', ownedPaths: ['src/another.js'], acceptanceCriterionIndexes: [1] }],
  });
  const blockedProposal = await cli(['work', 'propose', `--project=${root}`,
    '--request-text=# Add another module\n\n## Acceptance criteria\n\n- Add another module.\n',
    `--decomposition-json=${blockedDecomposition}`]);
  const blockedApproval = await cli(['feature', 'start', blockedProposal.runId, `--project=${root}`,
    `--expected-version=${blockedProposal.version}`, `--proposal-digest=${blockedProposal.proposalDigest}`]);
  const blockedPrepared = await cli(['work', 'prepare', blockedProposal.runId, `--project=${root}`,
    `--expected-version=${blockedApproval.version}`]);
  const blockedAction = await cli(['work', 'next', blockedProposal.runId, `--project=${root}`,
    `--expected-runtime-version=${blockedPrepared.runtimeVersion}`]);
  const blockedWorker = JSON.parse(blockedAction.action.payload).contract.worktree.path;
  await mkdir(join(blockedWorker, 'src'));
  await writeFile(join(blockedWorker, 'src', 'another.js'), "export const another = true;\n");
  const blockedResult = JSON.stringify({
    version: 1, status: 'success',
    output: { summary: 'Claimed unrelated evidence.', evidence: ['wrong-evidence'] },
    usage: { tokens: 1, costUsd: 0 },
  });
  const blockedSubmission = await cli(['work', 'submit', blockedProposal.runId, `--project=${root}`,
    `--expected-runtime-version=${blockedAction.runtimeVersion}`,
    `--action-json=${JSON.stringify(blockedAction.action)}`, `--result-json=${blockedResult}`]);
  assert.equal(blockedSubmission.status, 'blocked');
  const blockedStatus = await cli(['work', 'status', blockedProposal.runId, `--project=${root}`]);
  assert.equal(blockedStatus.run.status, 'blocked');
  assert.ok(blockedStatus.blockedNodes.includes(blockedAction.action.nodeId));
  assert.match(blockedStatus.nextAction, /new reviewed proposal/);
  let blockedResumeError;
  try {
    await cli(['feature', 'resume', blockedProposal.runId, `--project=${root}`,
      `--expected-version=${blockedStatus.run.version}`]);
  } catch (error) { blockedResumeError = error; }
  assert.equal(blockedResumeError?.code, EXIT_CODES.INVALID_INPUT);
  assert.equal((await cli(['work', 'status', blockedProposal.runId, `--project=${root}`])).run.version,
    blockedStatus.run.version);

  assert.equal((await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), baseline);
  assert.equal((await execFile('git', ['--git-dir', remote, 'for-each-ref',
    '--format=%(refname):%(objectname)', 'refs/heads'])).stdout, remoteRefs);
  assert.equal((await execFile('git', ['-C', root, 'status', '--porcelain'])).stdout, '');
});

test('inline host inputs reach the same services without reading files', async () => {
  const output = capture();
  const calls = [];
  const dependencies = {
    output: output.output,
    fs: { lstatSync() { throw new Error('inline input must not read files'); } },
    feature: { async propose(input) { calls.push(input); return { status: 'proposed' }; } },
    work: { async submitResult(input) { calls.push(input); return { status: 'accepted' }; } },
  };
  const decomposition = { schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [] };
  assert.equal(await main(['work', 'propose', '--project=/repo', '--request-text=Task',
    '--decomposition-json=' + JSON.stringify(decomposition), '--json'], dependencies), 0);
  assert.deepEqual(calls[0].decomposition, decomposition);
  assert.equal(await main(['work', 'submit', 'run-one', '--project=/repo', '--expected-runtime-version=3',
    '--action-json={"id":"one"}', '--result-json={"status":"success"}', '--json'], dependencies), 0);
  assert.deepEqual(calls[1].action, { id: 'one' });
  assert.deepEqual(calls[1].result, { status: 'success' });
  assert.equal(calls[1].expectedRuntimeVersion, 3);
});

test('inline inputs reject missing, conflicting, malformed, and oversized values before invoking services', async () => {
  let effects = 0;
  for (const flags of [[], ['--decomposition-json={',], ['--decomposition-json='],
    ['--decomposition=/repo/input.json', '--decomposition-json={}'],
    ['--decomposition-json=' + JSON.stringify('é'.repeat(32768))]]) {
    const output = capture();
    assert.equal(await main(['work', 'propose', '--project=/repo', '--request-text=Task', ...flags, '--json'], {
      output: output.output, feature: { async propose() { effects++; } },
    }), EXIT_CODES.INVALID_INPUT);
  }
  for (const flags of [[], ['--action-json={}', '--result-json={'],
    ['--action=/repo/action.json', '--action-json={}', '--result-json={}'],
    ['--action-json={}', '--result=/repo/result.json', '--result-json={}']]) {
    const output = capture();
    assert.equal(await main(['work', 'submit', 'run-one', '--project=/repo', '--expected-runtime-version=3', ...flags, '--json'], {
      output: output.output, work: { async submitResult() { effects++; } },
    }), EXIT_CODES.INVALID_INPUT);
  }
  assert.equal(effects, 0);
});

test('mixed file and inline submissions preserve JSON values literally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-mixed-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'action.json'), '{"id":"one"}');
  const result = { summary: 'quotes " and apostrophe \' and $(touch never) and `never`\nUnicode: é' };
  let received;
  const output = capture();
  assert.equal(await main(['work', 'submit', 'run-one', '--project=' + root, '--expected-runtime-version=3',
    '--action=' + join(root, 'action.json'), '--result-json=' + JSON.stringify(result), '--json'], {
    output: output.output, work: { async submitResult(input) { received = input; return { status: 'accepted' }; } },
  }), 0);
  assert.deepEqual(received.result, result);
  assert.deepEqual(received.action, { id: 'one' });
});

test('inline size boundary is measured in UTF-8 bytes', async () => {
  const source = JSON.stringify('é'.repeat(32767));
  assert.equal(Buffer.byteLength(source), 65536);
  const output = capture();
  let calls = 0;
  assert.equal(await main(['work', 'propose', '--project=/repo', '--request-text=Task', '--decomposition-json=' + source, '--json'], {
    output: output.output, feature: { async propose() { calls++; return { status: 'received' }; } },
  }), 0);
  assert.equal(calls, 1);
});

test('host filesystem permission failures give an actionable sanitized error', async () => {
  for (const code of ['EPERM', 'EACCES']) {
    const output = capture();
    const result = await main(['work', 'prepare', 'run-one', '--project=/repo', '--expected-version=1', '--json'], {
      output: output.output,
      work: { async prepare() { throw Object.assign(new Error('secret filesystem details'), { code }); } },
    });
    assert.equal(result, EXIT_CODES.REPOSITORY_CONFLICT);
    const message = JSON.parse(output.stderr()).error.message;
    assert.match(message, /permission/i);
    assert.match(message, /approval/i);
    assert.doesNotMatch(message, /secret filesystem details/);
  }
});
