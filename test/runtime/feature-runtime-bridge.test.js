import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { failAgent } from '../../src/clients/contract.js';
import { createFakeClient } from '../../src/clients/fake.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { featurePlanDigest } from '../../src/feature/plan-contract.js';
import { createAcceptedIntegrationStore } from '../../src/feature/accepted-integration.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';
import { createFeaturePlanner } from '../../src/feature/planner.js';
import {
  configuredFeatureGates,
  createFeatureExecutor,
  createFeatureRuntimeControls,
  createFeatureRuntimeState,
  featureQualityAuthority,
} from '../../src/feature/runtime-bridge.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createRuntimeInstance } from '../../src/runtime/instance-store.js';
import { createOrchestrator } from '../../src/runtime/orchestrator.js';
import { acceptedIntegrationPaths, resolveFeatureRunPaths, resolveStatePaths, verificationReportPaths } from '../../src/state/paths.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const CONFIG_ROOT = new URL('../fixtures/config/valid/', import.meta.url).pathname;
const BASELINE = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2029-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const execFile = promisify(execFileCallback);

test('compiles schema-v2 logical gates and quality authority from the same ordered step list', async () => {
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
  const resolved = [];

  const gates = await configuredFeatureGates(config, async runner => {
    resolved.push(runner);
    return `/safe/${runner}`;
  });
  const authority = featureQualityAuthority(config);

  assert.deepEqual(gates.map(gate => ({ id: gate.id, cwd: gate.cwd, args: gate.args })), [
    { id: 'build-1', cwd: 'backend', args: ['run', 'build'] },
    { id: 'build-2', cwd: 'frontend', args: ['run', 'build'] },
    { id: 'test', cwd: 'backend', args: ['run', 'test'] },
  ]);
  assert.deepEqual(resolved, ['npm', 'npm', 'npm']);
  assert.deepEqual(authority.commands, ['build-1', 'build-2', 'test']);
  assert.deepEqual(authority.actions, ['command.build-1', 'command.build-2', 'command.test']);
});

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

function workRequest() {
  return createWorkRequest({
    source: { kind: 'inline', ref: 'inline' },
    title: 'Smart agenda builder',
    description: 'Recommend and export a conflict-free agenda.',
    acceptanceCriteria: ['Preserve accepted sessions', 'Export the agenda as ICS'],
    contextRefs: [],
    capturedAt: NOW,
  });
}

function proposal() {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  };
}

async function runtimeFixture(decomposition = proposal()) {
  const config = await loadProjectConfig(CONFIG_ROOT);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit: BASELINE, client: 'codex' });
  const digest = featurePlanDigest(featurePlan);
  const run = {
    runId: 'smart-agenda-run',
    workRequest: request,
    featurePlan,
    proposalDigest: digest,
    activation: {
      approverId: 'human-cli-operator',
      approvedAt: NOW,
      requestDigest: request.digest,
      proposalDigest: digest,
    },
  };
  return { config, request, run };
}

test('maps the exact approved plan into a bounded canonical runtime graph without widening authority', async () => {
  const { config, run } = await runtimeFixture();
  const state = createFeatureRuntimeState({ config, run });

  assert.equal(state.version, 0);
  assert.equal(state.activated, false);
  assert.equal(state.graph.status, 'approved');
  assert.equal(state.graph.nodes.find(node => node.id === 'activation').status, 'completed');
  assert.equal(state.graph.nodes.find(node => node.id === 'management').status, 'completed');
  assert.equal(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').status, 'ready');
  assert.equal(state.graph.nodes.find(node => node.id === 'final-delivery').approvalGate, 'final-delivery');
  assert.deepEqual(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').authorityScopes, ['implement', 'verify']);
  assert.deepEqual(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').evidenceRefs, [
    'implement-agenda-recommendations-commit-1',
    'implement-agenda-recommendations-test-2',
  ]);
  assert.equal(JSON.stringify(state).includes('ATLASSIAN_API_TOKEN'), false);
  assert.equal(Object.isFrozen(state), true);
});

test('derives bounded unique evidence references for maximum-length Worker identifiers', async () => {
  const sharedPrefix = 'Implement accessible conference session discovery controls with deterministic behavior and';
  const { config, run } = await runtimeFixture({
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: `${sharedPrefix} domain coverage.`,
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: `${sharedPrefix} browser coverage.`,
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  });

  const state = createFeatureRuntimeState({ config, run });
  const workerEvidenceRefs = state.graph.nodes
    .filter(node => node.owner.role === 'worker')
    .flatMap(node => node.evidenceRefs);

  assert.equal(workerEvidenceRefs.length, 4);
  assert.equal(new Set(workerEvidenceRefs).size, workerEvidenceRefs.length);
  assert.ok(workerEvidenceRefs.every(reference => reference.length <= 64));
  assert.ok(workerEvidenceRefs.every(reference => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reference)));
  assert.deepEqual(
    workerEvidenceRefs,
    createFeatureRuntimeState({ config, run }).graph.nodes
      .filter(node => node.owner.role === 'worker')
      .flatMap(node => node.evidenceRefs),
  );
});

test('derives one exact activation control set accepted by the existing orchestrator', async () => {
  const { config, run } = await runtimeFixture();
  let state = structuredClone(createFeatureRuntimeState({ config, run }));
  let locked = false;
  const instance = {
    id: run.runId,
    async acquire() {
      assert.equal(locked, false);
      locked = true;
      return { release: async () => { locked = false; } };
    },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expectedVersion, next) {
      assert.equal(expectedVersion, state.version);
      state = structuredClone(next);
      return structuredClone(state);
    },
  };
  const runtime = createOrchestrator({
    client: createFakeClient({ scripts: [{
      version: 1,
      kind: 'success',
      output: { summary: 'unused', evidence: ['unused-commit', 'unused-test'] },
      usage: { tokens: 1, costUsd: 0 },
    }] }),
    now: () => NOW_MS,
    launchFor() { throw new Error('activation must not launch a Worker'); },
  });
  const activated = await runtime.activate(instance, {
    expectedVersion: 0,
    ...createFeatureRuntimeControls({ run, nowMs: NOW_MS }),
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.version, 1);
  assert.equal(activated.graph.status, 'running');
});

test('rejects client, digest, role, or authority drift before runtime state exists', async () => {
  const { config, run } = await runtimeFixture();
  for (const mutate of [
    value => { value.featurePlan.client = 'claude'; },
    value => { value.featurePlan.workRequestDigest = 'f'.repeat(64); },
    value => { value.featurePlan.nodes[2].roleId = 'portfolio-boss'; },
    value => { value.featurePlan.nodes[2].authorityScopes.push('merge'); },
  ]) {
    const changed = structuredClone(run);
    mutate(changed);
    assert.throws(() => createFeatureRuntimeState({ config, run: changed }));
  }
});

test('rehydrates the exact persisted approved plan without weakening validation', async () => {
  const { config, run } = await runtimeFixture();
  const persisted = structuredClone(run);
  const state = createFeatureRuntimeState({ config, run: persisted });
  assert.equal(state.graph.id, run.featurePlan.id);
  persisted.featurePlan.nodes[2].authorityScopes.push('merge');
  assert.throws(() => createFeatureRuntimeState({ config, run: persisted }));
});

test('executes all Workers sequentially on an isolated integration branch and stops before final approval', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-executor-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Runtime fixture\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal(request) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const digest = featurePlanDigest(featurePlan);
  const run = structuredClone({
    runId: 'smart-agenda-live-run',
    status: 'running',
    workRequest: request,
    featurePlan,
    proposalDigest: digest,
    activation: {
      approverId: 'human-cli-operator', approvedAt: NOW,
      requestDigest: request.digest, proposalDigest: digest,
    },
  });
  const gateExecutable = join(dirname(root), 'bounded-gate');
  await writeFile(gateExecutable, '#!/bin/sh\nif [ "$1" = ci ]; then mkdir -p node_modules; printf ready > node_modules/installed; exit 0; fi\n[ "$RIVET_GATE_ENV" = present ]\n', { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const launches = [];
  let installsApproved = 0;
  const executor = createFeatureExecutor({
    gitClient,
    environment: { RIVET_GATE_ENV: 'present', PATH: '/bin' },
    now: () => NOW,
    resolveCommandExecutable: async runner => {
      assert.equal(runner, 'npm');
      return gateExecutable;
    },
    clientFor(kind, clientProfile) {
      assert.equal(kind, 'claude');
      assert.deepEqual(clientProfile, featurePlan.clientProfile);
      return Object.freeze({
        provider: kind,
        async launch(contract) {
          assert.equal(await readFile(join(contract.worktree.path, 'node_modules/installed'), 'utf8'), 'ready');
          launches.push({
            nodeId: contract.nodeId,
            branchBase: (await gitClient.inspectRepository(contract.worktree.path)).headSha,
            maxCostUsd: contract.budget.maxCostUsd,
          });
          for (const path of contract.ownedPaths) {
            const target = join(contract.worktree.path, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, `${contract.nodeId}\n`);
          }
          return {
            version: 1, status: 'success',
            output: { summary: `Completed ${contract.nodeId}.`, evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const deferred = await executor({ project: root, run }, { confirmDependencyInstall: async () => false });
  assert.equal(deferred.status, 'blocked');
  assert.equal(launches.length, 0);

  const result = await executor({ project: root, run }, {
    confirmDependencyInstall: async plan => {
      assert.deepEqual(plan.args, ['ci']);
      assert.match(plan.worktreePath, /workers\//);
      installsApproved += 1;
      return true;
    },
  });
  assert.equal(result.status, 'awaiting-final-approval', JSON.stringify({ result, launches }));
  assert.equal(installsApproved, launches.length);
  const featurePaths = await resolveFeatureRunPaths(root, run.runId);
  const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths)).readOnly();
  const verification = await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
  assert.equal(verification.status, 'pass');
  assert.equal(verification.commitSha, accepted.commitSha);
  assert.ok(verification.checks.some(check => check.status === 'passed'));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map(launch => launch.maxCostUsd), [2, 2]);
  const integrationEntry = (await gitClient.listWorktrees(root)).find(item => item.branch === 'feature/smart-agenda-builder-smart-agenda-live-run');
  assert.ok(integrationEntry);
  assert.notEqual(launches[0].branchBase, (await gitClient.inspectRepository(integrationEntry.path)).headSha);
  const integrationLog = (await execFile('git', [
    '-C', integrationEntry.path, 'log', '-2', '--format=%s',
  ])).stdout;
  assert.match(integrationLog, /rivet: complete implement-ics-export/);
  assert.equal((await gitClient.inspectRepository(root)).branch, 'main');
  assert.equal((await gitClient.inspectRepository(root)).headSha, baselineCommit);
  assert.match(result.runtimeRefs[0], /^runtime:/);
  assert.ok(result.evidenceRefs.some(ref => ref.startsWith('commit:')));
});

test('autonomous verification blocks a committed child-manifest deletion before any gate launches', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-manifest-')));
  const root = join(parentRoot, 'project');
  const marker = join(parentRoot, 'quality-gate-ran');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await mkdir(join(root, 'backend'));
  await writeFile(join(root, 'README.md'), '# Runtime manifest fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'runtime-root', scripts: { build: 'node -e "process.exit(71)"', test: 'node -e "process.exit(72)"' },
  }));
  await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({
    name: 'runtime-backend', scripts: { build: 'x', test: 'x' },
  }));
  await writeFile(join(root, '.rivet', 'project.yaml'), [
    'schemaVersion: 2',
    'id: runtime-manifest-project',
    'name: Runtime Manifest Project',
    'stack: {framework: other, language: javascript, packageManager: npm}',
    'repository:',
    '  defaultBranch: main',
    '  branchPattern: feature/{slug}',
    '  sensitivePaths: [.env]',
    'commands:',
    '  build:',
    '    steps:',
    '      - {cwd: backend, argv: [npm, run, build]}',
    '  test:',
    '    steps:',
    '      - {cwd: backend, argv: [npm, run, test]}',
    '',
  ].join('\n'));
  await writeFile(join(root, '.rivet', 'quality.yaml'), [
    'schemaVersion: 1',
    'providerRefs: [figma-main, git-ci-main]',
    'completionProfileRefs: [engineering, delivery]',
    'commandGates:',
    '  - {id: build, command: build, required: true}',
    '  - {id: test, command: test, required: true}',
    'expectations: {storybook: optional, playwright: optional, accessibility: wcag-aa, security: required, visual: none}',
    'evidence:',
    '  requiredTypes: [commit, test, review, human-approval]',
    '  requireHumanBaseline: false',
    '  requireHumanFinal: true',
    '',
  ].join('\n'));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => ({
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [{
      objective: 'Replace the backend package manifest.',
      ownedPaths: ['backend/package.json'],
      acceptanceCriterionIndexes: [1, 2],
    }],
  }) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const digest = featurePlanDigest(featurePlan);
  const run = {
    runId: 'runtime-manifest-run', status: 'running', workRequest: request, featurePlan, proposalDigest: digest,
    activation: { approverId: 'human-cli-operator', approvedAt: NOW, requestDigest: request.digest, proposalDigest: digest },
  };
  const gateExecutable = join(parentRoot, 'bounded-gate');
  await writeFile(gateExecutable, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => gateExecutable,
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          await rm(join(contract.worktree.path, 'backend', 'package.json'));
          return {
            version: 1,
            status: 'success',
            output: { summary: 'Removed the package manifest.', evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const result = await executor({ project: root, run });

  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /quality gates could not complete safely/i);
  const featurePaths = await resolveFeatureRunPaths(root, run.runId);
  const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths)).readOnly();
  const verification = await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
  assert.equal(verification.status, 'fail');
  assert.equal(verification.commitSha, accepted.commitSha);
  assert.match(verification.failure, /quality gate execution failed safely|could not complete safely/i);
  await assert.rejects(() => access(marker));
});

test('rejects mismatched Worker evidence before integrating its committed changes', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-evidence-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Evidence fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal(request) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const digest = featurePlanDigest(featurePlan);
  const run = {
    runId: 'smart-agenda-evidence-run', status: 'running', workRequest: request, featurePlan, proposalDigest: digest,
    activation: { approverId: 'human-cli-operator', approvedAt: NOW, requestDigest: request.digest, proposalDigest: digest },
  };
  let launches = 0;
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => { throw new Error('quality gates must not run'); },
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          launches += 1;
          const target = join(contract.worktree.path, contract.ownedPaths[0]);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'committed despite invalid evidence\n');
          return {
            version: 1,
            status: 'success',
            output: { summary: 'invalid evidence', evidence: ['wrong-evidence'] },
            usage: { tokens: 1, costUsd: 0 },
          };
        },
      });
    },
  });

  const result = await executor({ project: root, run });
  assert.equal(result.status, 'blocked');
  assert.equal(launches, 1);
  const integration = (await gitClient.listWorktrees(root)).find(item => item.branch === 'feature/smart-agenda-builder-smart-agenda-evidence-run');
  assert.ok(integration);
  assert.equal((await gitClient.inspectRepository(integration.path)).headSha, baselineCommit);
});

test('resumes one blocked Worker in its exact preserved checkout and records a bounded retry', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-recovery-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Recovery fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal(request) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const digest = featurePlanDigest(featurePlan);
  const run = structuredClone({
    runId: 'smart-agenda-recovery-run',
    status: 'running',
    workRequest: request,
    featurePlan,
    proposalDigest: digest,
    activation: {
      approverId: 'human-cli-operator', approvedAt: NOW,
      requestDigest: request.digest, proposalDigest: digest,
    },
  });
  const gateExecutable = join(parentRoot, 'bounded-gate');
  await writeFile(gateExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const launches = [];
  let firstAttempt = true;
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => gateExecutable,
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          launches.push({ nodeId: contract.nodeId, path: contract.worktree.path });
          const [ownedPath] = contract.ownedPaths;
          const target = join(contract.worktree.path, ownedPath);
          await mkdir(dirname(target), { recursive: true });
          if (firstAttempt) {
            firstAttempt = false;
            await writeFile(target, 'preserved first-attempt work\n');
            failAgent('output-invalid');
          }
          if (contract.nodeId === 'implement-agenda-recommendations') {
            assert.equal(await readFile(target, 'utf8'), 'preserved first-attempt work\n');
          } else {
            await writeFile(target, `${contract.nodeId}\n`);
          }
          await execFile('git', ['-C', contract.worktree.path, 'add', '--', ...contract.ownedPaths]);
          await execFile('git', [
            '-C', contract.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid',
            'commit', '--quiet', '-m', `implement ${contract.nodeId}`,
          ]);
          return {
            version: 1,
            status: 'success',
            output: { summary: `Completed ${contract.nodeId}.`, evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const blocked = await executor({ project: root, run });
  assert.equal(blocked.status, 'blocked');
  assert.equal(launches.length, 1);
  const preservedPath = launches[0].path;
  const statePaths = await resolveStatePaths(root, run.runId);
  const reservations = await createReservationStore(statePaths).list();
  assert.equal(reservations.reservations.length, 1);
  assert.equal(reservations.reservations[0].status, 'active');
  assert.equal(reservations.reservations[0].worktreePath, preservedPath);

  await writeFile(join(preservedPath, 'README.md'), '# Out-of-scope retry drift\n');
  const unsafeResume = await executor({ project: root, run });
  assert.equal(unsafeResume.status, 'blocked');
  assert.equal(launches.length, 1);
  await writeFile(join(preservedPath, 'README.md'), '# Recovery fixture\n');

  const resumed = await executor({ project: root, run });

  assert.equal(resumed.status, 'awaiting-final-approval', JSON.stringify({ resumed, launches }));
  assert.equal(launches.length, 3);
  assert.equal(launches[1].nodeId, 'implement-agenda-recommendations');
  assert.equal(launches[1].path, preservedPath);
  const instance = createRuntimeInstance({
    id: run.runId,
    paths: statePaths,
    initialState: createFeatureRuntimeState({ config, run }),
  });
  const lock = await instance.acquire();
  let runtimeState;
  try { runtimeState = await instance.read(); } finally { await lock.release(); }
  assert.equal(runtimeState.attempts['implement-agenda-recommendations'], 2);
  assert.equal(runtimeState.usage.retries, 1);
  assert.ok(runtimeState.events.some(event => (
    event.type === 'retry'
    && event.nodeId === 'implement-agenda-recommendations'
    && event.actor.role === 'manager'
  )));
});
