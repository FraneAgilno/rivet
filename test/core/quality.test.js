import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import { configuredFeatureGates, featureQualityAuthority } from '../../src/feature/runtime-bridge.js';
import { claimApproval, createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { QualityError, runQualityGates } from '../../src/quality/runner.js';
import { validateTraceability } from '../../src/quality/traceability.js';
import { verifyProject } from '../../src/commands/verify.js';

const execFile = promisify(execFileCallback);
const START = Date.parse('2029-01-01T00:00:00.000Z');

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

async function git(cwd, ...args) {
  return execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agilno-quality-')));
  const projectRoot = join(root, 'project');
  await execFile('git', ['init', '--quiet', '-b', 'main', projectRoot]);
  await mkdir(join(projectRoot, 'reports'), { recursive: true });
  await mkdir(join(projectRoot, 'backend'), { recursive: true });
  await mkdir(join(projectRoot, 'frontend'), { recursive: true });
  await writeFile(join(projectRoot, 'README.md'), 'fixture\n');
  await writeFile(join(projectRoot, 'reports', '.keep'), 'tracked\n');
  await writeFile(join(projectRoot, 'backend', '.keep'), 'tracked\n');
  await writeFile(join(projectRoot, 'frontend', '.keep'), 'tracked\n');
  await writeFile(join(projectRoot, 'backend', 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'x' } }));
  await writeFile(join(projectRoot, 'frontend', 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  await writeFile(join(projectRoot, '.gitignore'), 'reports/results.json\n');
  await git(projectRoot, 'add', '--', 'README.md', 'reports/.keep', 'backend/.keep', 'backend/package.json',
    'frontend/.keep', 'frontend/package.json', '.gitignore');
  await execFile('git', ['-C', projectRoot, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example', 'commit', '--quiet', '-m', 'fixture']);
  const commitSha = (await git(projectRoot, 'rev-parse', 'HEAD')).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const passing = join(root, 'passing-gate');
  const failing = join(root, 'failing-gate');
  await writeFile(passing, [
    '#!/bin/sh', 'printf "gate passed"',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(failing, ['#!/bin/sh', 'printf "gate failed" >&2', 'exit 3', ''].join('\n'), { mode: 0o700 });
  await chmod(passing, 0o700);
  await chmod(failing, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectRoot, passing, failing, commitSha, gitClient };
}

async function npmExecutable() {
  const located = (await execFile('which', ['npm'])).stdout.trim();
  return realpath(located);
}

function authority(commandIds) {
  return createAuthorityEnvelope({
    actorId: 'quality-worker', principal: 'agent',
    actions: commandIds.map(id => 'command.' + id), ownedPaths: [], providers: [], commands: commandIds,
  });
}

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await access(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for fixture path.');
}

function approvalRegistry(principal = 'human') {
  return createApprovalRegistry({ approvers: [{ id: 'human-owner', principal }] });
}

function manualApproval(acId, reviewId, principal = 'human') {
  return createApprovalReceipt({
    id: 'approval-' + reviewId, approverId: 'human-owner', approverPrincipal: principal,
    subjectId: 'quality-manager', action: 'quality.manual-review',
    resource: 'acceptance:' + acId + ':manual-review:' + reviewId,
    policyId: 'quality.acceptance', decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  });
}

function configuredGate(executable, overrides = {}) {
  return {
    id: 'unit', executable, args: [], cwd: '.', required: true,
    artifactPaths: ['reports/results.json'], resultPath: 'reports/results.json',
    tests: [{ id: 'unit-agenda', acceptanceCriteria: ['DEMO-2-AC1'] }],
    ...overrides,
  };
}

async function qualityRun(f, overrides = {}, times = [START, START + 25]) {
  return runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
    gates: [configuredGate(f.passing)], ...overrides,
  }, { gitClient: f.gitClient, now: clock(...times) });
}

test('binds configured executable/argv provenance and gate-produced AC mappings to actual HEAD', async t => {
  const f = await fixture(t);
  const results = await qualityRun(f);
  assert.equal(results.status, 'pass');
  assert.equal(results.commitSha, f.commitSha);
  assert.equal(results.projectRoot, f.projectRoot);
  assert.equal(results.tests[0].id, 'unit-agenda');
  assert.equal(results.tests[0].status, 'passed');
  assert.deepEqual(results.tests[0].acceptanceCriteria, ['DEMO-2-AC1']);
  assert.equal(results.tests[0].gateId, 'unit');
  assert.equal(results.tests[0].resultPath, 'reports/results.json');
  assert.match(results.tests[0].resultSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(results.gates[0].command, { executable: f.passing, args: [] });
  assert.equal(results.gates[0].startedAt, '2029-01-01T00:00:00.000Z');
  assert.equal(results.gates[0].endedAt, '2029-01-01T00:00:00.025Z');
  assert.equal(results.gates[0].exitCode, 0);
  assert.equal(results.gates[0].output.stdout, 'gate passed');
  assert.match(results.gates[0].artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(results));
});

test('fails a required logical gate when any expanded child step fails', async t => {
  const f = await fixture(t);
  const executable = join(f.root, 'cwd-gate');
  await writeFile(executable, [
    '#!/bin/sh',
    'if [ "$(basename "$PWD")" = frontend ]; then exit 3; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(executable, 0o700);
  const config = {
    project: {
      schemaVersion: 2,
      commands: {
        build: { steps: [
          { cwd: 'backend', argv: ['npm', 'run', 'build'] },
          { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
        ] },
        test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
      },
    },
    quality: { commandGates: [
      { id: 'build', command: 'build', required: true },
      { id: 'test', command: 'test', required: true },
    ] },
  };
  const gates = await configuredFeatureGates(config, async () => executable);

  const result = await runQualityGates({
    projectRoot: f.projectRoot,
    commitSha: f.commitSha,
    authority: featureQualityAuthority(config),
    gates,
  }, { gitClient: f.gitClient, now: clock(START, START + 1, START + 2, START + 3, START + 4, START + 5) });

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.gates.map(gate => [gate.id, gate.cwd, gate.status]), [
    ['build-1', 'backend', 'passed'],
    ['build-2', 'frontend', 'failed'],
    ['test', 'backend', 'passed'],
  ]);
});

test('records a missing optional package script as unavailable without launching or failing required gates', async t => {
  const f = await fixture(t);
  const optionalMarker = join(f.root, 'optional-gate-ran');
  const executable = join(f.root, 'optional-aware-gate');
  await writeFile(executable, [
    '#!/bin/sh',
    `if [ "$(basename "$PWD")" = frontend ]; then printf ran > '${optionalMarker}'; fi`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(executable, 0o700);
  const config = {
    project: {
      schemaVersion: 2,
      commands: {
        build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
        test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
        typecheck: { steps: [{ cwd: 'frontend', argv: ['npm', 'run', 'typecheck'] }] },
      },
    },
    quality: { commandGates: [
      { id: 'build', command: 'build', required: true },
      { id: 'typecheck', command: 'typecheck', required: false },
    ] },
  };
  const gates = await configuredFeatureGates(config, async () => executable);

  const result = await runQualityGates({
    projectRoot: f.projectRoot,
    commitSha: f.commitSha,
    authority: featureQualityAuthority(config),
    gates,
  }, { gitClient: f.gitClient, now: clock(START, START + 1, START + 2, START + 3) });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.gates.map(gate => [gate.id, gate.status, gate.executionStatus]), [
    ['build', 'passed', 'success'],
    ['typecheck', 'failed', 'unavailable'],
  ]);
  await assert.rejects(() => access(optionalMarker));
});

test('rejects a missing child manifest before npm can fall back to an ancestor script', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'ancestor-script-ran');
  await rm(join(f.projectRoot, 'backend', 'package.json'));
  await writeFile(join(f.projectRoot, 'package.json'), JSON.stringify({
    scripts: { build: `node -e "require('node:fs').writeFileSync('${marker}', 'ran')"` },
  }));
  await git(f.projectRoot, 'add', '--all');
  await execFile('git', [
    '-C', f.projectRoot, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', 'remove child manifest',
  ]);
  const commitSha = (await git(f.projectRoot, 'rev-parse', 'HEAD')).stdout.trim();
  const config = {
    project: { schemaVersion: 2, commands: {
      build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    } },
    quality: { commandGates: [{ id: 'build', command: 'build', required: true }] },
  };
  const gates = await configuredFeatureGates(config, npmExecutable);

  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha, authority: featureQualityAuthority(config), gates,
  }, { gitClient: f.gitClient, now: clock(START, START + 1) }), QualityError);
  await assert.rejects(() => access(marker));
});

test('rejects a symlinked optional package manifest before launching its configured gate', async t => {
  const f = await fixture(t);
  const externalManifest = join(f.root, 'external-package.json');
  const marker = join(f.root, 'symlink-gate-ran');
  const gate = join(f.root, 'symlink-gate');
  await writeFile(externalManifest, JSON.stringify({ scripts: { build: 'x' } }));
  await rm(join(f.projectRoot, 'backend', 'package.json'));
  await symlink(externalManifest, join(f.projectRoot, 'backend', 'package.json'));
  await git(f.projectRoot, 'add', '--all');
  await execFile('git', [
    '-C', f.projectRoot, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example',
    'commit', '--quiet', '-m', 'link child manifest',
  ]);
  const commitSha = (await git(f.projectRoot, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(gate, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
  await chmod(gate, 0o700);
  const config = {
    project: { schemaVersion: 2, commands: {
      build: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'build'] }] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    } },
    quality: { commandGates: [{ id: 'build', command: 'build', required: false }] },
  };
  const gates = await configuredFeatureGates(config, async () => gate);

  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha, authority: featureQualityAuthority(config), gates,
  }, { gitClient: f.gitClient, now: clock(START, START + 1) }), QualityError);
  await assert.rejects(() => access(marker));
});

test('revalidates the exact manifest immediately before every expanded step', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'second-step-ran');
  const gate = join(f.root, 'replace-next-manifest');
  await writeFile(gate, [
    '#!/bin/sh',
    'if [ "$(basename "$PWD")" = backend ]; then rm ../frontend/package.json; exit 0; fi',
    `printf ran > '${marker}'`,
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(gate, 0o700);
  const config = {
    project: { schemaVersion: 2, commands: {
      build: { steps: [
        { cwd: 'backend', argv: ['npm', 'run', 'build'] },
        { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
      ] },
      test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
    } },
    quality: { commandGates: [{ id: 'build', command: 'build', required: true }] },
  };
  const gates = await configuredFeatureGates(config, async () => gate);

  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot,
    commitSha: f.commitSha,
    authority: featureQualityAuthority(config),
    gates,
  }, { gitClient: f.gitClient, now: clock(START, START + 1, START + 2) }), QualityError);
  await assert.rejects(() => access(marker));
});

test('rejects caller-invented commit provenance and untrusted git clients', async t => {
  const f = await fixture(t);
  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha: '0'.repeat(40), authority: authority(['unit']), gates: [configuredGate(f.passing)],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) }), QualityError);
  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), gates: [configuredGate(f.passing)],
  }, { gitClient: { inspectRepository: async () => ({ headSha: f.commitSha }) }, now: clock(START, START + 1) }), QualityError);
});

test('suppresses secret-bearing output and marks gate-produced tests failed with their gate', async t => {
  const f = await fixture(t);
  const secret = 'inert-quality-secret-123456789';
  const sensitive = join(f.root, 'sensitive-gate');
  await writeFile(sensitive, ['#!/bin/sh', 'printf "%s" "$1"', 'exit 3', ''].join('\n'), { mode: 0o700 });
  await chmod(sensitive, 0o700);
  const result = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['sensitive']), environment: { DEMO_API_TOKEN: secret },
    gates: [configuredGate(sensitive, { id: 'sensitive', args: [secret], tests: [{ id: 'secret-test', acceptanceCriteria: ['DEMO-2-AC1'] }] })],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) });
  assert.equal(result.status, 'fail');
  assert.equal(result.gates[0].output.stdout, '');
  assert.deepEqual(result.gates[0].command.args, ['[REDACTED]']);
  assert.equal(result.tests[0].status, 'failed');
});

test('snapshots gate environment before awaiting and reuses it for execution and provenance redaction', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'environment-started');
  const release = join(f.root, 'environment-release');
  const secret = 'inert-snapshot-secret-123456789';
  const changed = 'inert-mutated-secret-987654321';
  const delayed = join(f.root, 'delayed-environment-gate');
  await writeFile(delayed, [
    '#!/bin/sh',
    'printf started > "$1"',
    'while [ ! -f "$2" ]; do sleep 0.01; done',
    'printf "%s" "$3"',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(delayed, 0o700);
  const environment = { DEMO_API_TOKEN: secret };
  const pending = runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), environment,
    gates: [configuredGate(delayed, { args: [marker, release, secret] })],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) });
  await waitForPath(marker);
  environment.DEMO_API_TOKEN = changed;
  await writeFile(release, 'continue\n');
  const result = await pending;
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.gates[0].command.args, [marker, release, '[REDACTED]']);
  assert.equal(result.gates[0].output.stdout, '');
  assert.doesNotMatch(JSON.stringify(result), /inert-(?:snapshot|mutated)-secret/);
});

test('sanitizes hostile nested gate environments without invoking accessors', async t => {
  const f = await fixture(t);
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'DEMO_API_TOKEN', {
    enumerable: true,
    get() { reads += 1; return 'inert-once-secret-123456789'; },
  });
  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), environment: accessor,
    gates: [configuredGate(f.passing)],
  }, { gitClient: f.gitClient }), error => {
    assert.equal(error.name, 'QualityError');
    assert.equal(error.message, 'Quality gate input is invalid.');
    return true;
  });
  assert.equal(reads, 0, 'accessor values must not execute');

  let ownKeyReads = 0;
  let descriptorReads = 0;
  const source = { DEMO_API_TOKEN: 'inert-once-secret-123456789' };
  const counted = new Proxy(source, {
    ownKeys(target) { ownKeyReads += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get() { throw new Error('environment-value-was-reread'); },
  });
  const result = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), environment: counted,
    gates: [configuredGate(f.passing)],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) });
  assert.equal(result.status, 'pass');
  assert.equal(ownKeyReads, 1);
  assert.equal(descriptorReads, 1);

  const hostile = new Proxy({}, { ownKeys() { throw new Error('hostile-environment-secret'); } });
  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), environment: hostile,
    gates: [configuredGate(f.passing)],
  }, { gitClient: f.gitClient }), error => {
    assert.equal(error.name, 'QualityError');
    assert.equal(error.message, 'Quality gate input is invalid.');
    assert.doesNotMatch(error.message, /hostile-environment-secret/);
    return true;
  });
});

test('rejects shell strings, hostile accessors, and duplicate test aliases', async t => {
  const f = await fixture(t);
  const base = { projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']) };
  await assert.rejects(() => runQualityGates({ ...base, gates: [configuredGate(f.passing + ' --all')] }, { gitClient: f.gitClient }), QualityError);
  await assert.rejects(() => runQualityGates({ ...base, gates: [configuredGate(f.passing, { tests: [
    { id: 'same', acceptanceCriteria: ['DEMO-2-AC1'] }, { id: 'SAME', acceptanceCriteria: ['DEMO-2-AC1'] },
  ] })] }, { gitClient: f.gitClient }), QualityError);
  const hostile = {};
  Object.defineProperty(hostile, 'id', { enumerable: true, get() { throw new Error('hostile'); } });
  await assert.rejects(() => runQualityGates({ ...base, gates: [hostile] }, { gitClient: f.gitClient }), QualityError);
});

test('traceability consumes only an authenticated quality run and exact trusted manual approval', async t => {
  const f = await fixture(t);
  const run = await qualityRun(f);
  const traceability = validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }, { id: 'DEMO-2-AC2', inScope: true }, { id: 'DEMO-2-AC3', inScope: false }],
    manualReviews: [{ id: 'manual-dialog', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval: manualApproval('DEMO-2-AC2', 'manual-dialog') }],
  }, { approvalRegistry: approvalRegistry(), nowMs: START });
  assert.equal(traceability.valid, true);
  assert.deepEqual(traceability.coverage.map(item => [item.acceptanceCriterion, item.method]), [['DEMO-2-AC1', 'test'], ['DEMO-2-AC2', 'manual-review']]);
  assert.throws(() => validateTraceability({
    subjectId: 'quality-manager', qualityRun: { ...run }, acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [],
  }, { approvalRegistry: approvalRegistry(), nowMs: START }), /traceability/i);
});

test('rolls back manual approval claims when full traceability fails', async t => {
  const f = await fixture(t);
  const run = await qualityRun(f);
  const registry = approvalRegistry();
  const approval = manualApproval('DEMO-2-AC2', 'manual-dialog');
  const invalid = validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [
      { id: 'DEMO-2-AC1', inScope: false }, { id: 'DEMO-2-AC2', inScope: true }, { id: 'DEMO-2-AC9', inScope: true },
    ],
    manualReviews: [{ id: 'manual-dialog', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval }],
  }, { approvalRegistry: registry, nowMs: START });
  assert.equal(invalid.valid, false);
  const valid = validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: false }, { id: 'DEMO-2-AC2', inScope: true }],
    manualReviews: [{ id: 'manual-dialog', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval }],
  }, { approvalRegistry: registry, nowMs: START });
  assert.equal(valid.valid, true);
});

test('verifyProject ignores caller status assertions and uses gate-produced test mappings', async t => {
  const f = await fixture(t);
  const empty = join(f.root, 'empty-gate');
  await writeFile(empty, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(empty, 0o700);
  const result = await verifyProject({
    quality: { projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), gates: [configuredGate(empty, { tests: [] })] },
    traceability: {
      subjectId: 'quality-manager', acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [],
      tests: [{ id: 'invented', status: 'passed', acceptanceCriteria: ['DEMO-2-AC1'], gateId: 'unit' }],
    },
  }, { gitClient: f.gitClient, now: clock(START, START + 1), approvalRegistry: approvalRegistry(), nowMs: START });
  assert.equal(result.ok, false);
  assert.equal(result.traceability.valid, false);
});

test('verifyProject passes only when authenticated gates and traceability both pass', async t => {
  const f = await fixture(t);
  const result = await verifyProject({
    quality: { projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']), gates: [configuredGate(f.passing)] },
    traceability: { subjectId: 'quality-manager', acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [] },
  }, { gitClient: f.gitClient, now: clock(START, START + 1), approvalRegistry: approvalRegistry(), nowMs: START });
  assert.equal(result.ok, true);
  assert.equal(result.commitSha, f.commitSha);
});

test('verifyProject snapshots complete nested traceability before awaiting quality gates', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'traceability-started');
  const release = join(f.root, 'traceability-release');
  const delayed = join(f.root, 'delayed-traceability-gate');
  await writeFile(delayed, [
    '#!/bin/sh',
    'printf started > "$1"',
    'while [ ! -f "$2" ]; do sleep 0.01; done',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(delayed, 0o700);
  const acceptanceCriteria = [
    { id: 'DEMO-2-AC1', inScope: true },
    { id: 'DEMO-2-AC2', inScope: true },
  ];
  const tests = [{ id: 'invented', status: 'passed', acceptanceCriteria: ['DEMO-2-AC2'], gateId: 'unit' }];
  const manualReviews = [];
  const pending = verifyProject({
    quality: {
      projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
      gates: [configuredGate(delayed, { args: [marker, release] })],
    },
    traceability: { subjectId: 'quality-manager', acceptanceCriteria, manualReviews, tests },
  }, { gitClient: f.gitClient, now: clock(START, START + 1), approvalRegistry: approvalRegistry(), nowMs: START });
  await waitForPath(marker);
  acceptanceCriteria.pop();
  tests[0].acceptanceCriteria.pop();
  manualReviews.push({
    id: 'late-review', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner',
    approval: manualApproval('DEMO-2-AC2', 'late-review'),
  });
  await writeFile(release, 'continue\n');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(result.traceability.coverage.map(row => row.acceptanceCriterion), ['DEMO-2-AC1']);
  assert.match(result.traceability.errors.join(' '), /DEMO-2-AC2/);
});

test('verifyProject snapshots manual review approval bindings before awaiting quality gates', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'approval-started');
  const release = join(f.root, 'approval-release');
  const delayed = join(f.root, 'delayed-approval-gate');
  await writeFile(delayed, [
    '#!/bin/sh',
    'printf started > "$1"',
    'while [ ! -f "$2" ]; do sleep 0.01; done',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(delayed, 0o700);
  const review = {
    id: 'manual-dialog', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner',
    approval: manualApproval('DEMO-2-AC2', 'manual-dialog'),
  };
  const pending = verifyProject({
    quality: {
      projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
      gates: [configuredGate(delayed, { args: [marker, release] })],
    },
    traceability: {
      subjectId: 'quality-manager',
      acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }, { id: 'DEMO-2-AC2', inScope: true }],
      manualReviews: [review], tests: [],
    },
  }, { gitClient: f.gitClient, now: clock(START, START + 1), approvalRegistry: approvalRegistry(), nowMs: START });
  await waitForPath(marker);
  review.approval = manualApproval('DEMO-2-AC2', 'different-review');
  review.acceptanceCriterion = 'DEMO-2-AC9';
  await writeFile(release, 'continue\n');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.traceability.coverage[1].approvalReceiptId, 'approval-manual-dialog');
});

test('verifyProject rejects hostile nested traceability with a fixed error before gate execution', async t => {
  const f = await fixture(t);
  const hostile = () => new Proxy({}, { ownKeys() { throw new Error('hostile-traceability-secret'); } });
  const requests = [
    { acceptanceCriteria: [hostile()], manualReviews: [], tests: [] },
    {
      acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }],
      manualReviews: [{
        id: 'manual-dialog', acceptanceCriterion: 'DEMO-2-AC1', expectedApproverId: 'human-owner', approval: hostile(),
      }],
      tests: [],
    },
    {
      acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [],
      tests: [{ id: 'invented', status: 'passed', acceptanceCriteria: hostile(), gateId: 'unit' }],
    },
  ];
  for (const traceability of requests) {
    await assert.rejects(() => verifyProject({
      quality: {
        projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
        gates: [configuredGate(f.passing)],
      },
      traceability: { subjectId: 'quality-manager', ...traceability },
    }, { gitClient: f.gitClient, now: clock(START, START + 1), approvalRegistry: approvalRegistry(), nowMs: START }), error => {
      assert.equal(error.name, 'TypeError');
      assert.equal(error.message, 'Verification input is invalid.');
      assert.doesNotMatch(error.message, /hostile-traceability-secret/);
      return true;
    });
  }
});

test('a successful no-op gate cannot attest caller-declared tests', async t => {
  const f = await fixture(t);
  const noop = join(f.root, 'noop-gate');
  await writeFile(noop, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(noop, 0o700);
  const run = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
    gates: [configuredGate(noop)],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) });
  assert.equal(run.status, 'fail');
  assert.equal(run.tests[0].status, 'failed');
});

test('accepts only exact per-test statuses from a newly gate-produced checksummed result artifact', async t => {
  const f = await fixture(t);
  const attesting = join(f.root, 'attesting-gate');
  await writeFile(attesting, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > reports/results.json',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(attesting, 0o700);
  const run = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
    gates: [configuredGate(attesting, {
      artifactPaths: ['reports/results.json'], resultPath: 'reports/results.json',
    })],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) });
  assert.equal(run.tests[0].status, 'passed');
  assert.equal(run.tests[0].resultPath, 'reports/results.json');
  assert.match(run.tests[0].resultSha256, /^[0-9a-f]{64}$/);
});

test('fails closed when the repository is dirty before or after gate execution', async t => {
  const before = await fixture(t);
  await writeFile(join(before.projectRoot, 'dirty-before.txt'), 'dirty\n');
  await assert.rejects(() => qualityRun(before), QualityError);

  const after = await fixture(t);
  const dirtying = join(after.root, 'dirtying-gate');
  await writeFile(dirtying, '#!/bin/sh\nprintf dirty > dirty-after.txt\nexit 0\n', { mode: 0o700 });
  await chmod(dirtying, 0o700);
  await assert.rejects(() => runQualityGates({
    projectRoot: after.projectRoot, commitSha: after.commitSha, authority: authority(['unit']),
    gates: [configuredGate(dirtying)],
  }, { gitClient: after.gitClient, now: clock(START, START + 1) }), QualityError);
});

test('rejects duplicate manual reviews for one AC before consuming any approval', async t => {
  const f = await fixture(t);
  const run = await qualityRun(f);
  const registry = approvalRegistry();
  const first = manualApproval('DEMO-2-AC2', 'manual-first');
  const second = manualApproval('DEMO-2-AC2', 'manual-second');
  assert.throws(() => validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: false }, { id: 'DEMO-2-AC2', inScope: true }],
    manualReviews: [
      { id: 'manual-first', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval: first },
      { id: 'manual-second', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval: second },
    ],
  }, { approvalRegistry: registry, nowMs: START }), /traceability/i);
  const retried = validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: false }, { id: 'DEMO-2-AC2', inScope: true }],
    manualReviews: [{ id: 'manual-first', acceptanceCriterion: 'DEMO-2-AC2', expectedApproverId: 'human-owner', approval: first }],
  }, { approvalRegistry: registry, nowMs: START });
  assert.equal(retried.valid, true);
});

test('sanitizes hostile public array reflection traps as domain errors', async t => {
  const f = await fixture(t);
  const run = await qualityRun(f);
  const hostile = new Proxy([], {
    ownKeys() { throw new Error('hostile-array-secret'); },
  });
  assert.throws(() => validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: hostile,
  }, { approvalRegistry: approvalRegistry(), nowMs: START }), error => {
    assert.equal(error.name, 'TraceabilityError');
    assert.doesNotMatch(error.message, /hostile-array-secret/);
    return true;
  });
});

test('rejects a stale attestation whose preexisting inode is only touched by the gate', async t => {
  const f = await fixture(t);
  const stale = '{"schemaVersion":1,"gateId":"unit","tests":[{"id":"unit-agenda","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\n';
  await writeFile(join(f.projectRoot, 'reports', 'results.json'), stale);
  const touching = join(f.root, 'touching-gate');
  await writeFile(touching, '#!/bin/sh\ntouch -t 203001010000 reports/results.json\nexit 0\n', { mode: 0o700 });
  await chmod(touching, 0o700);
  await assert.rejects(() => runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(['unit']),
    gates: [configuredGate(touching)],
  }, { gitClient: f.gitClient, now: clock(START, START + 1) }), QualityError);
});

test('unused manual review receipts are rejected before they can be consumed', async t => {
  const f = await fixture(t);
  const run = await qualityRun(f);
  const registry = approvalRegistry();
  const receipt = manualApproval('DEMO-2-AC1', 'manual-unused');
  assert.throws(() => validateTraceability({
    subjectId: 'quality-manager', qualityRun: run,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }],
    manualReviews: [{
      id: 'manual-unused', acceptanceCriterion: 'DEMO-2-AC1',
      expectedApproverId: 'human-owner', approval: receipt,
    }],
  }, { approvalRegistry: registry, nowMs: START }), /traceability/i);
  const reusable = claimApproval(receipt, {
    subjectId: 'quality-manager', action: 'quality.manual-review',
    resource: 'acceptance:DEMO-2-AC1:manual-review:manual-unused', policyId: 'quality.acceptance',
  }, {
    registry, expectedApproverId: 'human-owner', requireHumanApprover: true,
    requireSingleUse: true, nowMs: START,
  });
  assert.equal(reusable.valid, true);
  reusable.release();
});

test('gate artifact reads pin ancestor directories during descriptor reads', async t => {
  const f = await fixture(t);
  const originalChdir = process.chdir;
  let pinnedChanges = 0;
  process.chdir = function countedChdir(path) {
    pinnedChanges += 1;
    return originalChdir.call(process, path);
  };
  try {
    const run = await qualityRun(f);
    assert.equal(run.status, 'pass');
  } finally {
    process.chdir = originalChdir;
  }
  assert.ok(pinnedChanges >= 2, 'artifact reads must enter and restore a pinned directory');
});
