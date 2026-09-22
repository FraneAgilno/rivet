import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createWorkAction, validateWorkAction } from '../../src/feature/actions.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservedWorktree } from '../../src/git/worktrees.js';
import { resolveStatePaths } from '../../src/state/paths.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);
const NOW = '2029-01-01T00:00:00.000Z';
const PROTOCOL_REF = `protocol:database-changes:3:sha256:${'a'.repeat(64)}`;

async function git(root, ...args) {
  return (await execFile('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
}

async function npmExecutable() {
  const { stdout } = await execFile('which', ['npm']);
  return realpath(stdout.trim());
}

async function fixture(t, { schemaV2 = false, ownedPaths = ['app/agenda.js'] } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-host-execution-')));
  const root = join(parent, 'project');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Host execution fixture\n');
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
  await execFile('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const { stdout: gitPath } = await execFile('which', ['git']);
  const gitClient = await createGitClient({ gitExecutable: await realpath(gitPath.trim()) });
  const workflow = createFeatureWorkflow({
    gitClient,
    now: () => NOW,
    protocolsFor: async () => [PROTOCOL_REF],
    planningClientFor: async () => { throw new Error('host execution must not resolve a planning client'); },
    executeFeature: async () => { throw new Error('host execution must not use the spawned executor'); },
  });
  const proposal = await workflow.propose({
    project: root,
    source: { kind: 'inline', value: '# Add agenda\n\n## Acceptance criteria\n\n- Add the agenda implementation.\n' },
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
  return { root, gitClient, approved, gate };
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

test('submitResult integrates an exact restarted host action and verify stops at final human approval', async t => {
  const { root, gitClient, approved, gate } = await fixture(t);
  const execution = createHostExecution({
    gitClient,
    now: () => NOW,
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
    now: () => NOW,
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
      }), error => error.code === 'ERR_QUALITY_GATE');
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
