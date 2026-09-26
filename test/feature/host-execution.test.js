import {bodyDigest} from '../../src/protocols/project.js';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import YAML from 'yaml';

import { createWorkAction, validateWorkAction } from '../../src/feature/actions.js';
import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createReservedWorktree } from '../../src/git/worktrees.js';
import { resolveFeatureRunPaths, resolveStatePaths } from '../../src/state/paths.js';
import { acquireLock } from '../../src/state/lock.js';
import { verificationReportPaths } from '../../src/state/paths.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);
const NOW = '2029-01-01T00:00:00.000Z';
const PROTOCOL_BODY = '# Database changes\n\nExisting reviewed procedure.\n';
const PROTOCOL_METADATA = {schemaVersion: 1, id: 'database-changes', title: 'Database changes', status: 'active', revision: 3, updatedAt: '2026-09-26T00:00:00.000Z'};
PROTOCOL_METADATA.digest = bodyDigest(PROTOCOL_METADATA, PROTOCOL_BODY);
const PROTOCOL_REF = `protocol:database-changes:3:${PROTOCOL_METADATA.digest}`;

async function git(root, ...args) {
  return (await execFile('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
}

async function npmExecutable() {
  const { stdout } = await execFile('which', ['npm']);
  return realpath(stdout.trim());
}

async function fixture(t, { now = NOW, schemaV2 = false, ownedPaths = ['app/agenda.js'], lockedDependencies = false, hostContext = false, repositoryRemote } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-host-execution-')));
  const root = join(parent, 'project');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Host execution fixture\n');
  if (lockedDependencies) {
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  }
  if (schemaV2) {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'host-v2-root',
      scripts: {
        build: 'node -e "require(\'node:fs\').writeFileSync(\'fallback-ran\', \'ran\');process.exit(71)"',
        test: 'node -e "require(\'node:fs\').writeFileSync(\'fallback-ran\', \'ran\');process.exit(72)"',
      },
    }));
    for (const name of ['backend', 'frontend']) await mkdir(join(root, name));
    await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({
      name: 'host-v2-backend',
      scripts: {
        build: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-backend\' ? 0 : 81)"',
        test: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-backend\' ? 0 : 82)"',
      },
    }));
    await writeFile(join(root, 'frontend', 'package.json'), JSON.stringify({
      name: 'host-v2-frontend',
      scripts: {
        build: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-frontend\' ? 0 : 83)"',
      },
    }));
    await writeFile(join(root, '.rivet', 'project.yaml'), [
      'schemaVersion: 2',
      'id: host-v2-project',
      'name: Host V2 Project',
      'stack:',
      '  framework: other',
      '  language: javascript',
      '  packageManager: npm',
      'repository:',
      '  defaultBranch: main',
      '  branchPattern: feature/{slug}',
      '  sensitivePaths: [.env]',
      'commands:',
      '  build:',
      '    steps:',
      '      - {cwd: backend, argv: [npm, run, build]}',
      '      - {cwd: frontend, argv: [npm, run, build]}',
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
      'expectations:',
      '  storybook: optional',
      '  playwright: optional',
      '  accessibility: wcag-aa',
      '  security: required',
      '  visual: none',
      'evidence:',
      '  requiredTypes: [commit, test, review, human-approval]',
      '  requireHumanBaseline: false',
      '  requireHumanFinal: true',
      '',
    ].join('\n'));
  } else {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
    }));
  }
  if (repositoryRemote) {
    const path = join(root, '.rivet', 'project.yaml');
    const config = YAML.parse(await readFile(path, 'utf8'));
    config.repository.remote = repositoryRemote;
    await writeFile(path, YAML.stringify(config));
  }
  let hostSource;
  if (hostContext) {
    const providerPath = join(root, '.rivet', 'providers.yaml');
    const providers = YAML.parse(await readFile(providerPath, 'utf8'));
    const jira = providers.providers.find(p => p.kind === 'jira');
    Object.assign(jira, { transport: 'harness-mcp', tools: ['get_issue'], endpoint: 'https://jira.example.test', resourceIds: ['DEMO-1'] });
    await writeFile(providerPath, YAML.stringify(providers));
    const project = YAML.parse(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'));
    hostSource = { kind: 'host-observation', value: { schemaVersion: 1, projectId: project.id,
      host: { projectId: project.id, providers: [{ id: jira.id, authenticated: true, tools: ['get_issue'] }] },
      request: { providerId: jira.id, resourceId: 'DEMO-1' },
      observations: [{ schemaVersion: 1, projectId: project.id, providerId: jira.id, tool: 'get_issue',
        resourceId: 'DEMO-1', sourceUrl: 'https://jira.example.test/browse/DEMO-1', revision: '1', capturedAt: NOW,
        content: { title: 'Add agenda', description: 'Add the agenda implementation.', acceptanceCriteria: ['Add the agenda implementation.'] } }],
    } };
  }
  await mkdir(join(root, '.rivet', 'protocols'), {recursive: true});
  await writeFile(join(root, '.rivet', 'protocols', 'database-changes.md'), '---\n' + YAML.stringify(PROTOCOL_METADATA) + '---\n\n' + PROTOCOL_BODY);
  await execFile('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const { stdout: gitPath } = await execFile('which', ['git']);
  const gitClient = await createGitClient({ gitExecutable: await realpath(gitPath.trim()) });
  const workflow = createFeatureWorkflow({
    gitClient,
    now: () => now,
    protocolsFor: async () => [PROTOCOL_REF],
    planningClientFor: async () => { throw new Error('host execution must not resolve a planning client'); },
    executeFeature: async () => { throw new Error('host execution must not use the spawned executor'); },
  });
  const proposal = await workflow.propose({
    project: root,
    source: hostSource ?? { kind: 'inline', value: '# Add agenda\n\n## Acceptance criteria\n\n- Add the agenda implementation.\n' },
    client: 'host',
    decomposition: {
      schemaVersion: 1,
      kind: 'agilno.feature-decomposition',
      workItems: [{
        objective: 'Add the agenda implementation.',
        ownedPaths,
        acceptanceCriterionIndexes: [1],
      }],
    },
  });
  const approved = await workflow.start({
    project: root,
    runId: proposal.runId,
    expectedVersion: proposal.version,
    proposalDigest: proposal.proposalDigest,
  });
  const gate = join(parent, 'gate');
  await writeFile(gate, '#!/bin/sh\nexit 0\n');
  await chmod(gate, 0o700);
  return { root, gitClient, approved, gate, workflow };
}

function resultFor(action, overrides = {}) {
  const payload = JSON.parse(action.payload);
  return {
    version: 1,
    status: 'success',
    output: { summary: 'Implemented the bounded host action.', evidence: payload.contract.evidence },
    usage: { tokens: 10, costUsd: 0 },
    ...overrides,
  };
}

async function completedWorker(t, options = {}) {
  const fixtureValue = await fixture(t, options);
  const { root, gitClient, approved, gate } = fixtureValue;
  const execution = createHostExecution({
    gitClient, now: () => NOW,
    resolveCommandExecutable: async () => gate,
    environment: { PATH: process.env.PATH },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const worktree = JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(worktree, 'app'), { recursive: true });
  await writeFile(join(worktree, 'app', 'agenda.js'), 'export const agenda = true;\n');
  const submitted = await execution.submitResult({
    project: root, runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action, result: resultFor(next.action),
  });
  assert.equal(submitted.status, 'accepted');
  const verifyInput = {
    project: root, runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  };
  return { ...fixtureValue, execution, verifyInput };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch {}
    await delay(25);
  }
  throw new Error('Gate start marker was not written');
}

test('prepare and nextAction durably hand one Worker to the host without a model client', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });

  const prepared = await execution.prepare({
    project: root,
    runId: approved.runId,
    expectedRunVersion: approved.version,
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.run.status, 'running');
  assert.equal(prepared.runtimeVersion, 1);

  const next = await execution.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: prepared.runtimeVersion,
  });
  assert.equal(next.status, 'action');
  assert.equal(next.action.runId, approved.runId);
  assert.equal(next.action.runtimeVersion, next.runtimeVersion);
  assert.equal(next.action.nodeId, 'add-the-agenda-implementation');
  const payload = JSON.parse(next.action.payload);
  assert.equal(payload.kind, 'agilno.agent-launch');
  assert.equal(payload.contract.nodeId, next.action.nodeId);
  assert.equal(payload.contract.worktree.reservationId, next.action.reservationId);
  assert.deepEqual(payload.contract.contextRefs.filter(ref => ref.startsWith('protocol:')), [PROTOCOL_REF]);
  assert.deepEqual(validateWorkAction(next.action), next.action);
  assert.throws(() => createWorkAction({ ...next.action, unexpected: true }));

  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.runtime.version, next.runtimeVersion);
  assert.equal(observed.runtime.nodes.find(node => node.id === next.action.nodeId).status, 'running');

  const restarted = createHostExecution({ gitClient, now: () => NOW });
  const afterRestart = await restarted.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
  });
  assert.equal(afterRestart.status, 'waiting-for-result');
  assert.equal(afterRestart.action.intentId, next.action.intentId);
  assert.equal(afterRestart.action.payload, next.action.payload);
});

test('task deps installs in the active host Worker before handoff', async t => {
  const { root, gitClient, approved } = await fixture(t, { lockedDependencies: true });
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const worktree = JSON.parse(next.action.payload).contract.worktree.path;
  const installer = join(dirname(root), 'install-fixture');
  await writeFile(installer, '#!/bin/sh\nmkdir -p node_modules\nprintf ready > node_modules/installed\n', { mode: 0o700 });
  const messages = [];
  const { stdout: gitPath } = await execFile('which', ['git']);
  const code = await main(['task', 'deps'], {
    cwd: () => root, terminalIsInteractive: () => true,
    output: { log: value => messages.push(value), error: value => messages.push(value), json() {} },
    work: execution,
    resolveCommandExecutable: async name => name === 'git' ? await realpath(gitPath.trim()) : installer,
    confirmDependencyInstall: async plan => plan.worktreePath === worktree,
  });
  assert.equal(code, EXIT_CODES.SUCCESS, messages.join('\n'));
  assert.equal(await readFile(join(worktree, 'node_modules/installed'), 'utf8'), 'ready');
  assert.match(messages.join('\n'), /Continue in the owning harness/);
});

test('submitResult integrates an exact restarted host action and verify stops at final human approval', async t => {
  const now = new Date().toISOString();
  const { root, gitClient, approved, gate } = await fixture(t, { now, repositoryRemote: {name:'origin',url:'https://github.com/team/demo'} });
  const execution = createHostExecution({
    gitClient,
    now: () => now,
    resolveCommandExecutable: async () => gate,
    environment: {},
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');

  const restarted = createHostExecution({
    gitClient,
    now: () => now,
    resolveCommandExecutable: async () => gate,
    environment: {},
  });
  const submitted = await restarted.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });
  assert.equal(submitted.status, 'accepted');
  assert.equal(submitted.nodeStatus, 'completed');

  const verified = await restarted.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  });
  assert.equal(verified.status, 'awaiting-final-approval');
  assert.ok(verified.evidenceRefs.some(ref => /^commit:[a-f0-9]{40}$/.test(ref)));
  assert.deepEqual(verified.evidenceRefs.filter(ref => ref.startsWith('test:')).sort(), ['test:build', 'test:lint', 'test:test']);
  const observed = await restarted.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'awaiting-final-approval');
  assert.equal(observed.runtime.nodes.find(node => node.id === 'final-delivery').status, 'ready');
  assert.equal(observed.deliveryReady, true);
  const delivery = await import('../../src/delivery/prepare.js');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/team/demo.git');
  await git(root, 'remote', 'add', 'alternate', 'https://github.com/team/alternate.git');
  const candidate = await delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient });
  assert.equal(candidate.localVerification.headSha, observed.checkout.acceptedCommit);
  assert.equal(candidate.repository.fullName, 'team/demo');
  const override = await delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient, remoteName:'alternate' });
  assert.equal(override.repository.fullName, 'team/alternate');
  await git(root, 'remote', 'set-url', 'origin', 'https://github.com/team/substituted.git');
  await assert.rejects(delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }));
  await git(root, 'remote', 'set-url', 'origin', 'https://github.com/team/demo.git');
  assert.match(candidate.localVerification.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(candidate.targetBranch, 'main');
  let deliveryOutput;
  const deliveryDeps = {
    cwd: () => root,
    env: {},
    output: { json: value => { deliveryOutput = value; }, error() {}, log() {} },
  };
  assert.equal(await main(['delivery', 'prepare', `--run=${approved.runId}`, '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.stage, 'locally-verified');
  assert.equal(await main(['delivery', 'status', '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.candidate.localVerification.headSha, candidate.localVerification.headSha);
  const deliveryVersion = deliveryOutput.result.version;
  assert.equal(await main(['delivery', 'prepare', '--json'], { ...deliveryDeps, cwd: () => join(root, '.rivet') }), 0);
  assert.equal(deliveryOutput.result.version, deliveryVersion);
  assert.equal(await main(['delivery', 'recover', '--json'], deliveryDeps), 0);
  assert.deepEqual(deliveryOutput.recovery.recoveredLocks, []);
  assert.equal(await main(['delivery', 'status', '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.version, deliveryVersion);
  const originalReadme = await readFile(join(root, 'README.md'), 'utf8');
  await writeFile(join(root, 'README.md'), 'source drift');
  await assert.rejects(() => delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }), /verified|verification/i);
  await writeFile(join(root, 'README.md'), originalReadme);
  await writeFile(join(observed.checkout.path, 'unverified.txt'), 'unverified');
  await assert.rejects(() => delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }), /verified|verification/i);
});

test('schema-v2 host verification runs each exact child package and still stops at final approval', async t => {
  const { root, gitClient, approved } = await fixture(t, { schemaV2: true });
  const npm = await npmExecutable();
  const execution = createHostExecution({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async runner => {
      assert.equal(runner, 'npm');
      return npm;
    },
    environment: { PATH: process.env.PATH },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  const submitted = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });

  const verified = await execution.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  });

  assert.equal(verified.status, 'awaiting-final-approval');
  assert.deepEqual(verified.evidenceRefs.filter(ref => ref.startsWith('test:')).sort(), [
    'test:build-1', 'test:build-2', 'test:test',
  ]);
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.runtime.nodes.find(node => node.id === 'final-delivery').status, 'ready');
});

test('host verification rejects deleted and symlinked child manifests before execution', async t => {
  for (const replacement of ['deleted', 'symlink']) {
    await t.test(replacement, async t2 => {
      const { root, gitClient, approved } = await fixture(t2, {
        schemaV2: true,
        ownedPaths: ['backend/package.json'],
      });
      const npm = await npmExecutable();
      const execution = createHostExecution({
        gitClient,
        now: () => NOW,
        resolveCommandExecutable: async () => npm,
        environment: { PATH: process.env.PATH },
      });
      const prepared = await execution.prepare({
        project: root, runId: approved.runId, expectedRunVersion: approved.version,
      });
      const next = await execution.nextAction({
        project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
      });
      const worktree = JSON.parse(next.action.payload).contract.worktree.path;
      await rm(join(worktree, 'backend', 'package.json'));
      if (replacement === 'symlink') {
        await symlink('../frontend/package.json', join(worktree, 'backend', 'package.json'));
      }
      const submitted = await execution.submitResult({
        project: root,
        runId: approved.runId,
        expectedRuntimeVersion: next.runtimeVersion,
        action: next.action,
        result: resultFor(next.action),
      });

      await assert.rejects(() => execution.verify({
        project: root,
        runId: approved.runId,
        expectedRunVersion: prepared.run.version,
        expectedRuntimeVersion: submitted.runtimeVersion,
      }), error => error.code === 'ERR_HOST_EXECUTION_VERIFICATION_FAILED');
      const observed = await execution.status({ project: root, runId: approved.runId });
      assert.equal(observed.run.status, 'running');
      assert.equal(observed.verification.status, 'fail');
      assert.match(observed.verification.failure, /quality gate/i);
      assert.deepEqual(observed.verification.checks, []);
      const integration = (await gitClient.listWorktrees(root))
        .find(item => item.branch.includes(approved.runId));
      await assert.rejects(() => access(join(integration.path, 'fallback-ran')));
    });
  }
});

test('submitResult rejects stale actions and blocks mismatched evidence before integration', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  await assert.rejects(() => execution.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: prepared.runtimeVersion,
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion - 1,
    action: next.action,
    result: resultFor(next.action),
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');

  const alteredPayload = JSON.parse(next.action.payload);
  alteredPayload.contract.objective = 'Widened host objective that was never persisted.';
  const alteredAction = { ...next.action, payload: JSON.stringify(alteredPayload) };
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: alteredAction,
    result: resultFor(next.action),
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');

  const integrationBefore = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  const blocked = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action, {
      output: { summary: 'Claimed success with wrong evidence.', evidence: ['wrong-evidence'] },
    }),
  });
  assert.equal(blocked.status, 'blocked');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'blocked');
  assert.equal(observed.runtime.graphStatus, 'blocked');
  assert.ok(observed.blockedNodes.includes(next.action.nodeId));
  assert.match(observed.nextAction, /new reviewed proposal/);
  const integrationAfter = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  assert.equal(integrationAfter, integrationBefore);
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: blocked.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  }));
});

test('submitResult blocks out-of-scope host edits without moving the integration branch', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  await writeFile(join(contract.worktree.path, 'README.md'), '# Unauthorized host edit\n');
  const integrationBefore = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;

  const blocked = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reconciliation.reason, 'worker-uncommitted-changes');
  const integrationAfter = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  assert.equal(integrationAfter, integrationBefore);
});

test('prepare leaves an approved run retryable after a temporary repository conflict', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await writeFile(join(root, 'temporary.txt'), 'temporary\n');
  await assert.rejects(() => execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  }), error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const unchanged = await execution.status({ project: root, runId: approved.runId });
  assert.equal(unchanged.run.status, 'approved');
  assert.equal(unchanged.run.version, approved.version);
  await rm(join(root, 'temporary.txt'));
  const prepared = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  });
  const resumed = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: prepared.run.version,
  });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.runtimeVersion, prepared.runtimeVersion);
});

test('nextAction reuses an active worker checkout left by an interrupted preparation', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  });
  const integration = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId));
  assert.ok(integration);
  const nodeId = 'add-the-agenda-implementation';
  const observed = await execution.status({ project: root, runId: approved.runId });
  const node = observed.runtime.nodes.find(item => item.id === nodeId);
  const statePaths = await resolveStatePaths(root, approved.runId);
  await createReservedWorktree({
    projectRoot: integration.path,
    statePaths,
    nodeId,
    branch: `worker/${approved.runId}/${nodeId}`,
    worktreePath: join(dirname(integration.path), 'workers', nodeId),
    ownerId: node.owner.id,
    baseSha: integration.head,
    responsibilities: ['app/agenda.js'],
    intendedPaths: ['app/agenda.js'],
    expiresAt: new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000).toISOString(),
  }, { gitClient, nowMs: Date.parse(NOW) });

  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  assert.equal(next.status, 'action');
  assert.equal(JSON.parse(next.action.payload).contract.worktree.path, join(dirname(integration.path), 'workers', nodeId));
});

test('verification rejects committed and dirty source drift beyond the reconciled worker commit', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  await writeFile(gate, '#!/bin/sh\nexit 1\n');
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_VERIFICATION_FAILED');
  const failed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(failed.verification.status, 'fail');
  assert.equal(failed.checkout.status, 'clean');
  const acceptedCommit = failed.checkout.acceptedCommit;
  const integration = failed.checkout.path;
  await writeFile(join(integration, 'UNAPPROVED.txt'), 'outside the reviewed scope\n');
  await git(integration, 'add', 'UNAPPROVED.txt');
  await git(integration, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'unapproved');
  await writeFile(gate, '#!/bin/sh\nexit 0\n');
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const stale = await execution.status({ project: root, runId: approved.runId });
  assert.equal(stale.checkout.status, 'stale');
  assert.equal(stale.checkout.acceptedCommit, acceptedCommit);
  assert.notEqual(stale.checkout.observedCommit, acceptedCommit);
  assert.equal(stale.run.status, 'running');
  assert.equal(stale.verification.commitSha, acceptedCommit);
  assert.match(stale.nextAction, /Do not deliver/);
  await writeFile(join(integration, 'UNAPPROVED.txt'), 'dirty after commit\n');
  const dirty = await execution.status({ project: root, runId: approved.runId });
  assert.equal(dirty.checkout.status, 'stale');
  assert.equal(dirty.checkout.dirty, true);
  assert.match(dirty.nextAction, /Do not deliver/);
});

test('verification rejects source changes made while configured gates run', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  const before = await execution.status({ project: root, runId: approved.runId });
  const integration = before.checkout.path;
  const marker = join(dirname(root), 'gate-started');
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setTimeout(() => process.exit(0), 2000); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  const verification = execution.verify(verifyInput);
  await waitForFile(marker);
  await writeFile(join(integration, 'UNAPPROVED.txt'), 'changed during checks\n');
  await git(integration, 'add', 'UNAPPROVED.txt');
  await git(integration, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'mid-gate drift');
  await assert.rejects(verification, error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'running');
  assert.equal(observed.verification, null);
  assert.equal(observed.checkout.status, 'stale');
  assert.match(observed.nextAction, /Do not deliver/);
});

test('status rejects corrupt and symlinked private reports without preparing a checkout', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const reportPath = join(paths.runDir, 'verification.json');
  const unprepared = await execution.status({ project: root, runId: approved.runId });
  assert.equal(unprepared.runtime, null);
  assert.equal(unprepared.verification, null);
  await assert.rejects(() => access(join(dirname(root), '.rivet-worktrees')));
  await writeFile(reportPath, '{corrupt\n', { mode: 0o600 });
  await assert.rejects(() => execution.status({ project: root, runId: approved.runId }),
    /Invalid state snapshot/);
  await rm(reportPath);
  const outside = join(dirname(root), 'outside-report');
  await writeFile(outside, 'private outside content\n');
  await symlink(outside, reportPath);
  await assert.rejects(() => execution.status({ project: root, runId: approved.runId }),
    /Unsafe state snapshot/);
  await assert.rejects(() => access(join(dirname(root), '.rivet-worktrees')));
});

test('missing accepted commit identity fails closed after a completed worker', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  await rm(join(paths.runDir, 'accepted-integration.json'));
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'running');
  assert.equal(observed.checkout, null);
  assert.match(observed.nextAction, /identity is missing/);
});

test('an idle work next after submission preserves the accepted commit for verification', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  const next = await execution.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: verifyInput.expectedRuntimeVersion,
  });
  assert.equal(next.status, 'idle');
  assert.ok(next.runtimeVersion >= verifyInput.expectedRuntimeVersion);
  const verified = await execution.verify({
    ...verifyInput,
    expectedRuntimeVersion: next.runtimeVersion,
  });
  assert.equal(verified.status, 'awaiting-final-approval');
});

test('final approval status requires its private report and accepted commit identity', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  await execution.verify(verifyInput);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const acceptedPath = join(paths.runDir, 'accepted-integration.json');
  const reportPath = join(paths.runDir, 'verification.json');
  const acceptedBytes = await readFile(acceptedPath);
  const reportBytes = await readFile(reportPath);
  for (const missing of [[reportPath], [acceptedPath], [reportPath, acceptedPath]]) {
    for (const path of missing) await rm(path);
    const observed = await execution.status({ project: root, runId: approved.runId });
    assert.equal(observed.run.status, 'awaiting-final-approval');
    assert.match(observed.nextAction, /Do not deliver/);
    await writeFile(acceptedPath, acceptedBytes, { mode: 0o600 });
    await writeFile(reportPath, reportBytes, { mode: 0o600 });
  }
  const reports = createVerificationReportStore(await verificationReportPaths(paths));
  const current = await reports.readOnly();
  await reports.write({ ...current, commitSha: 'a'.repeat(40) });
  const mismatched = await execution.status({ project: root, runId: approved.runId });
  assert.match(mismatched.nextAction, /Do not deliver/);
});

test('verification holds the host lock through final run publication', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  const marker = join(dirname(root), 'publication-gate-started');
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setTimeout(() => process.exit(0), 700); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  let settled = false;
  const verifying = execution.verify(verifyInput).finally(() => { settled = true; });
  await waitForFile(marker);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const stateLock = await acquireLock(paths.lockPath);
  try {
    await waitForFile(join(paths.runDir, 'verification.json'));
    assert.equal(settled, false);
    const observed = await execution.status({ project: root, runId: approved.runId });
    assert.equal(observed.run.status, 'running');
    await assert.rejects(() => acquireLock(join(paths.runDir, 'host-operation.lock')),
      error => error.code === 'ERR_STATE_LOCKED');
  } finally { await stateLock.release(); }
  const verified = await verifying;
  assert.equal(verified.status, 'awaiting-final-approval');
});

test('concurrent failed verify and host cancellation cannot overwrite a passing final report', async t => {
  const { root, approved, gate, gitClient, workflow, execution, verifyInput } = await completedWorker(t);
  const marker = join(dirname(root), 'slow-gate-started');
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setTimeout(() => process.exit(0), 4000); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  const failingGate = join(dirname(root), 'failing-gate');
  await writeFile(failingGate, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await chmod(failingGate, 0o700);
  const failing = createHostExecution({
    gitClient, now: () => NOW,
    resolveCommandExecutable: async () => failingGate,
    environment: { PATH: process.env.PATH },
  });
  const passingAttempt = execution.verify(verifyInput);
  await waitForFile(marker);
  const outcomes = await Promise.allSettled([
    failing.verify(verifyInput),
    workflow.cancel({ project: root, runId: approved.runId, expectedVersion: verifyInput.expectedRunVersion }),
    execution.nextAction({
      project: root, runId: approved.runId, expectedRuntimeVersion: verifyInput.expectedRuntimeVersion,
    }),
  ]);
  assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'rejected', 'rejected']);
  assert.ok(outcomes.every(item => item.reason.code === 'ERR_HOST_RUN_BUSY'));
  const passed = await passingAttempt;
  assert.equal(passed.status, 'awaiting-final-approval');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'awaiting-final-approval');
  assert.equal(observed.verification.status, 'pass');
  assert.equal(observed.checkout.status, 'clean');
  assert.match(observed.nextAction, /final delivery decision/);
});


test('host-observed tracker context survives activation, isolated work and verification', async t => {
  const { root, execution, verifyInput } = await completedWorker(t, {hostContext:true});
  const result = await execution.verify(verifyInput);
  const status = await execution.status({project:root,runId:verifyInput.runId});
  assert.equal(status.run.status,'awaiting-final-approval');
  assert.equal(status.run.workRequest.source.kind,'host-observation');
  assert.equal(status.run.workRequest.context.sources[0].assurance,'harness-observed');
  assert.ok(status.run.workRequest.contextRefs.includes(PROTOCOL_REF));
  assert.equal(await git(root,'status','--porcelain'),'');
});

async function directoryBytes(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[path] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root);
  return files;
}

test('status advises review rather than restarting a completed Worker', async t => {
  const { root, execution, verifyInput } = await completedWorker(t);
  const status = await execution.status({ project: root, runId: verifyInput.runId });
  assert.equal(status.workerCheckouts[0].nodeStatus, 'completed');
  assert.match(status.workerCheckouts[0].nextAction, /do not restart/i);
});

test('status exposes active Worker edits without changing private state or taking its lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  const statePaths = await resolveStatePaths(root, approved.runId);
  const reservationFile = join(statePaths.instanceDir, 'worktree-reservations.json');
  const before = await readFile(reservationFile);
  const lock = await acquireLock(statePaths.lockPath);
  const privateBefore = await directoryBytes(statePaths.instanceDir);
  const workerIndex = await git(path, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const indexBefore = await readFile(workerIndex);
  try {
    const clean = await execution.status({ project: root, runId: approved.runId });
    assert.equal(clean.checkout, null);
    assert.equal(clean.workerCheckouts[0].status, 'clean');
    assert.equal(clean.workerCheckouts[0].path, path);
    await mkdir(join(path, 'app'), { recursive: true });
    await writeFile(join(path, 'app/agenda.js'), 'preserve this interrupted work\n');
    const dirty = await execution.status({ project: root, runId: approved.runId });
    assert.equal(dirty.workerCheckouts[0].status, 'dirty');
    assert.deepEqual(dirty.workerCheckouts[0].dirtyPaths, ['app/agenda.js']);
    assert.match(dirty.workerCheckouts[0].nextAction, /inspect/i);
    assert.equal(await readFile(join(path, 'app/agenda.js'), 'utf8'), 'preserve this interrupted work\n');
    assert.deepEqual(await readFile(reservationFile), before);
    assert.equal(dirty.deliveryReady, false);
    assert.deepEqual(await directoryBytes(statePaths.instanceDir), privateBefore);
    assert.deepEqual(await readFile(workerIndex), indexBefore);
  } finally { await lock.release(); }
});

test('status reports interrupted reserved, expired, moved, wrong-branch and missing Workers without recovery', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const statePaths = await resolveStatePaths(root, approved.runId);
  const current = await execution.status({ project: root, runId: approved.runId });
  const node = current.runtime.nodes.find(item => item.owner.role === 'worker');
  const repository = await gitClient.inspectRepository(root);
  const integration = (await gitClient.listWorktrees(root)).find(item => item.branch.includes(approved.runId));
  const path = join(dirname(integration.path), 'workers', node.id);
  const branch = `worker/${approved.runId}/${node.id}`;
  const expiresAt = new Date(Date.parse(NOW) + 1000).toISOString();
  await createReservationStore(statePaths).reserve({ nodeId: node.id, ownerId: node.owner.id,
    repositoryId: repository.repositoryId, branch, worktreePath: path, baseSha: repository.headSha,
    responsibilities: ['app/agenda.js'], intendedPaths: ['app/agenda.js'], expiresAt,
  }, { expectedVersion: 0, nowMs: Date.parse(NOW) });
  const read = async () => (await execution.status({ project: root, runId: approved.runId })).workerCheckouts[0];
  assert.equal((await read()).status, 'missing');
  await mkdir(dirname(path), { recursive: true });
  await git(root, 'worktree', 'add', '-q', '-b', branch, path);
  assert.equal((await read()).status, 'clean');
  assert.equal((await read()).reservationStatus, 'reserved');
  assert.match((await read()).nextAction, /interrupted/);
  const expired = createHostExecution({ gitClient, now: () => expiresAt });
  assert.equal((await expired.status({ project: root, runId: approved.runId })).workerCheckouts[0].leaseExpired, true);
  await git(path, 'checkout', '-q', '-b', 'other-worker-branch');
  assert.equal((await read()).status, 'mismatched');
  assert.equal((await read()).observedBranch, 'other-worker-branch');
  const other = join(dirname(path), 'other-location');
  await git(root, 'worktree', 'add', '-q', other, branch);
  assert.deepEqual((await read()).branchLocations, [other]);
  await rm(path, { recursive: true, force: true });
  assert.equal((await read()).status, 'missing');
});

test('Worker status fails closed on unsafe reservation associations and symlinked state', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const paths = await resolveStatePaths(root, approved.runId);
  const file = join(paths.instanceDir, 'worktree-reservations.json');
  const original = await readFile(file, 'utf8');
  for (const patch of [{ worktreePath: root }, { ownerId: 'another-worker' }, { repositoryId: 'different-repository' }, { nodeId: 'unknown-node' }]) {
    const state = JSON.parse(original);
    Object.assign(state.reservations[0], patch);
    await writeFile(file, `${JSON.stringify(state)}\n`);
    await assert.rejects(execution.status({ project: root, runId: approved.runId }), { code: 'ERR_HOST_EXECUTION_STATE_CONFLICT' });
  }
  await writeFile(file, '{broken\n');
  await assert.rejects(execution.status({ project: root, runId: approved.runId }));
  await rm(file);
  const target = join(dirname(root), 'reservation-target');
  await writeFile(target, original, { mode: 0o600 });
  await symlink(target, file);
  await assert.rejects(execution.status({ project: root, runId: approved.runId }));
  assert.equal(await readFile(target, 'utf8'), original);
});


test('Worker status refuses checkout paths with symlinked ancestors', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  const parent = dirname(path);
  await rename(parent, `${parent}-relocated`);
  await symlink(`${parent}-relocated`, parent);
  const status = await execution.status({ project: root, runId: approved.runId });
  assert.equal(status.workerCheckouts[0].status, 'unavailable');
  assert.equal(status.workerCheckouts[0].headCommit, null);
  assert.deepEqual(status.workerCheckouts[0].dirtyPaths, []);
});

test('Worker status rejects excessive dirty-path output instead of returning an unbounded report', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(join(path, `untracked-${i}`), 'preserved')));
  await assert.rejects(execution.status({ project: root, runId: approved.runId }), { code: 'ERR_HOST_EXECUTION_STATE_CONFLICT' });
  assert.equal(await readFile(join(path, 'untracked-256'), 'utf8'), 'preserved');
});

async function abandonedHostLock(path, overrides = {}) {
  const { hostname } = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  await writeFile(path, JSON.stringify({ pid: 2147483647, host: hostname(), timestamp: '2000-01-01T00:00:00.000Z', ownerId: randomUUID(), ...overrides }), { mode: 0o600 });
}

test('explicit host recovery removes all four abandoned locks without changing saved state or files', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  const before = await Promise.all([readFile(paths.snapshotPath), readFile(runtime.snapshotPath)]);
  const worktrees = await git(root, 'worktree', 'list', '--porcelain');
  await writeFile(join(root, 'uncommitted.txt'), 'preserve me');
  for (const path of [join(paths.runDir, 'host-operation.lock'), paths.lockPath, runtime.runtimeLockPath, runtime.lockPath]) await abandonedHostLock(path);
  const recovered = await execution.recover({ project: root, runId: approved.runId });
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(recovered.recoveredLocks, ['host-operation', 'run', 'runtime', 'state']);
  assert.deepEqual(await Promise.all([readFile(paths.snapshotPath), readFile(runtime.snapshotPath)]), before);
  assert.equal(await readFile(join(root, 'uncommitted.txt'), 'utf8'), 'preserve me');
  assert.equal(await git(root, 'worktree', 'list', '--porcelain'), worktrees);
  assert.deepEqual((await execution.recover({ project: root, runId: approved.runId })).recoveredLocks, []);
});

test('host recovery reports partial progress and preserves a live inner owner', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  await abandonedHostLock(join(paths.runDir, 'host-operation.lock'));
  await abandonedHostLock(paths.lockPath, { pid: process.pid });
  const before = await readFile(paths.lockPath);
  const result = await execution.recover({ project: root, runId: approved.runId });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.recoveredLocks, ['host-operation']);
  assert.equal(result.blockedLock, 'run');
  assert.deepEqual(await readFile(paths.lockPath), before);
});

test('host recovery validates corrupt snapshots before removing an abandoned outer lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(outer);
  const before = await readFile(outer);
  await writeFile(paths.snapshotPath, '{}', { mode: 0o600 });
  await assert.rejects(createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(outer), before);
});

test('task recover selects a sole active host run and work recover reports blocked progress as failure', async t => {
  const { root, approved } = await fixture(t);
  const calls = [];
  const messages = [];
  const output = { log: x => messages.push(x), error: x => messages.push(x), json: x => messages.push(x) };
  const work = { recover: async value => { calls.push(value); return { status: 'recovered', recoveredLocks: ['run'], nextAction: 'Read task status.' }; } };
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.deepEqual(calls[0], { project: root, runId: approved.runId });
  assert.match(messages.join('\n'), /run/);
  const blocked = { recover: async () => ({ status: 'blocked', recoveredLocks: ['host-operation'], blockedLock: 'run', nextAction: 'Inspect remaining owner.' }) };
  messages.length = 0;
  assert.equal(await main(['work', 'recover', approved.runId, `--project=${root}`, '--json'], { work: blocked, output }), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(messages[0].ok, false);
  assert.deepEqual(messages[0].result.recoveredLocks, ['host-operation']);
  assert.equal(await main(['task', 'recover', '--force'], { cwd: () => root, work, output }), EXIT_CODES.INVALID_INPUT);
});

test('host recovery permits interrupted initialization without inventing a runtime snapshot', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const runtime = await resolveStatePaths(root, approved.runId);
  await abandonedHostLock(runtime.runtimeLockPath);
  await abandonedHostLock(runtime.lockPath);
  const result = await createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId });
  assert.equal(result.status, 'recovered');
  assert.equal(result.runtimeVersion, null);
  assert.deepEqual(result.recoveredLocks, ['runtime', 'state']);
  await assert.rejects(access(runtime.snapshotPath), { code: 'ENOENT' });
});

test('host recovery rejects substituted runtime objectives before removing locks', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  const saved = JSON.parse(await readFile(runtime.snapshotPath, 'utf8'));
  saved.data.graph.nodes.find(node => node.owner.role === 'worker').objective = 'Implement an unrelated task with different ownership.';
  await writeFile(runtime.snapshotPath, `${JSON.stringify(saved)}\n`);
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  await assert.rejects(execution.recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(lock), before);
});

test('host recovery fails closed for young live foreign corrupt and previously claimed owners', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = join(paths.runDir, 'host-operation.lock');
  const execution = createHostExecution({ gitClient });
  for (const [name, overrides] of [
    ['young', { timestamp: new Date().toISOString() }],
    ['live', { pid: process.pid }],
    ['foreign', { host: 'another-host.invalid' }],
    ['corrupt', {}],
    ['claimed', {}],
  ]) {
    await abandonedHostLock(outer, overrides);
    if (name === 'corrupt') await writeFile(outer, '{}');
    if (name === 'claimed') {
      const owner = JSON.parse(await readFile(outer, 'utf8'));
      await writeFile(`${outer}.recovered-${owner.ownerId}`, 'prior recovery claim', { mode: 0o600 });
    }
    const before = await readFile(outer);
    const result = await execution.recover({ project: root, runId: approved.runId });
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.blockedLock, 'host-operation', name);
    assert.deepEqual(result.recoveredLocks, [], name);
    assert.deepEqual(await readFile(outer), before, name);
  }
});

test('host prepare respects recovery outer lock and never initializes state while another owner holds it', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = await acquireLock(join(paths.runDir, 'host-operation.lock'));
  const before = await readFile(paths.snapshotPath);
  try {
    await assert.rejects(createHostExecution({ gitClient }).prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version }), { code: 'ERR_HOST_RUN_BUSY' });
    assert.deepEqual(await readFile(paths.snapshotPath), before);
  } finally { await outer.release(); }
});

test('concurrent host recoverers preserve snapshots and do not remove an active acquired lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const before = await readFile(paths.snapshotPath);
  await abandonedHostLock(join(paths.runDir, 'host-operation.lock'));
  const results = await Promise.all([
    execution.recover({ project: root, runId: approved.runId }),
    execution.recover({ project: root, runId: approved.runId }),
  ]);
  assert.ok(results.some(result => result.status === 'recovered'));
  assert.equal(results.filter(result => result.recoveredLocks.includes('host-operation')).length, 1);
  assert.deepEqual(await readFile(paths.snapshotPath), before);
});

test('host recovery refuses a running run with a missing runtime snapshot', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  await rm(runtime.snapshotPath);
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  await assert.rejects(execution.recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(lock), before);
});

test('task recover requires a selector for multiple host runs and refuses explicit spawned runs', async t => {
  const { root, gitClient, approved, workflow } = await fixture(t);
  const second = await workflow.propose({ project: root, client: 'host',
    source: { kind: 'inline', value: '# Another task\n\n## Acceptance criteria\n\n- Add another agenda item.\n' },
    decomposition: { schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [{ objective: 'Add another agenda item.', ownedPaths: ['app/second.js'], acceptanceCriterionIndexes: [1] }] },
  });
  const calls = [];
  const messages = [];
  const output = { log: value => messages.push(value), error: value => messages.push(value), json: value => messages.push(value) };
  const work = { recover: async value => { calls.push(value); return { status: 'recovered', recoveredLocks: [], nextAction: 'Read task status.' }; } };
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.INVALID_INPUT);
  assert.equal(calls.length, 0);
  assert.equal(await main(['task', 'recover', `--run=${second.runId}`], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.equal(calls[0].runId, second.runId);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const saved = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
  saved.data.featurePlan.client = 'codex';
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const { createHash } = await import('node:crypto');
  saved.data.proposalDigest = createHash('sha256').update(canonical(saved.data.featurePlan)).digest('hex');
  saved.data.activation.proposalDigest = saved.data.proposalDigest;
  await writeFile(paths.snapshotPath, `${JSON.stringify(saved)}\n`);
  assert.equal(await main(['task', 'recover', `--run=${approved.runId}`], { cwd: () => root, work, output }), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(calls.length, 1);
  await assert.rejects(createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId }), { code: 'ERR_HOST_RUN_RECOVERY_STATE' });
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.equal(calls.at(-1).runId, second.runId);
});

test('host recovery rejects missing runtime directories for started runs even without their expected runtime reference', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  await rm(runtime.instanceDir, { recursive: true });
  const saved = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  for (const status of ['running', 'blocked', 'completed']) {
    for (const refs of [[], ['runtime:unrelated-run']]) {
      saved.data.status = status;
      saved.data.runtimeRefs = refs;
      await writeFile(paths.snapshotPath, `${JSON.stringify(saved)}\n`);
      await assert.rejects(execution.recover({ project: root, runId: approved.runId }), { code: 'ERR_HOST_RUN_RECOVERY_STATE' });
      assert.deepEqual(await readFile(lock), before);
    }
  }
});
