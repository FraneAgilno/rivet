import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createAdapter, createSourceEnvelope } from '../../src/adapters/contract.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';

const execFile = promisify(execFileCallback);
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'fixtures', 'config', 'valid', '.rivet');
const REQUEST = join(HERE, '..', 'fixtures', 'work-requests', 'smart-agenda.md');
const NOW = '2029-01-01T00:00:00.000Z';

function proposal(contract) {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement agenda recommendations and calendar export.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: contract.workRequest.acceptanceCriteria.map((_, index) => index + 1),
      },
    ],
  };
}

function trackerAdapter(provider, id, request) {
  const envelope = createSourceEnvelope({
    provider,
    sourceId: id,
    sourceUrl: provider === 'jira' ? `https://jira.example.test/browse/${id}` : `https://linear.app/example/issue/${id}/smart-agenda`,
    fetchedAt: NOW,
    fixtureSource: false,
    raw: { id },
    normalized: {
      id,
      summary: 'Smart agenda builder',
      description: request,
      acceptanceCriteria: [
        'Preserve sessions the attendee already accepted.',
        'Export the resulting agenda as an ICS file.',
      ],
      revision: NOW,
      ...(provider === 'jira' ? { epicId: '' } : {}),
      links: [], comments: [],
    },
    retryClassification: 'none',
    capabilities: { read: ['issue'], write: [] },
  });
  return createAdapter({
    provider, fixtureSource: false, capabilities: { read: ['issue'], write: [] },
    async read() { return envelope; },
    async write() { throw new Error('tracker writes are not part of this workflow'); },
  });
}

async function git(root, ...args) {
  return (await execFile('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-e2e-')));
  const root = join(parent, 'app');
  const remote = join(parent, 'origin.git');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'requests'), { recursive: true });
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  await cp(REQUEST, join(root, 'requests', 'smart-agenda.md'));
  await writeFile(join(root, '.rivet', 'providers.yaml'), `schemaVersion: 1
providers:
  - id: jira-main
    kind: jira
    mode: read-only
    capabilities: [issues-read]
    endpoint: https://jira.example.test
    credentials:
      apiTokenEnv: JIRA_API_TOKEN
  - id: linear-main
    kind: linear
    mode: read-only
    capabilities: [issues-read]
    endpoint: https://api.linear.app
    credentials:
      apiTokenEnv: LINEAR_API_TOKEN
  - id: confluence-main
    kind: confluence
    mode: read-only
    capabilities: [pages-read]
    resourceIds: [SPACE]
    credentials:
      apiTokenEnv: ATLASSIAN_API_TOKEN
  - id: figma-main
    kind: figma
    mode: read-only
    capabilities: [files-read]
    resourceIds: [DEMO_FILE]
    credentials:
      accessTokenEnv: FIGMA_ACCESS_TOKEN
  - id: git-ci-main
    kind: git-ci
    mode: read-write-with-approval
    capabilities: [repository-read, pull-request-write, checks-read]
    resourceIds: [agilno/conference-planner]
    credentials:
      tokenEnv: GITHUB_TOKEN
`);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fresh-nextjs-target', private: true, scripts: {
      build: 'node --check app/page.js', test: 'node --test test/*.test.js',
      lint: 'node --check app/page.js', typecheck: 'node --check app/page.js', dev: 'node app/page.js',
    },
  }, null, 2) + '\n');
  await writeFile(join(root, 'app', 'page.js'), "export default function Page() { return 'Conference planner'; }\n");
  await execFile('/usr/bin/git', ['init', '--quiet', '--bare', remote]);
  await execFile('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial target');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');
  return { parent, root, remote, baseline: await git(root, 'rev-parse', 'HEAD') };
}

test('runs equivalent Markdown/Jira/Linear requests through one resumable local-only feature lifecycle', async () => {
  const target = await fixture();
  const { stdout: gitPath } = await execFile('which', ['git']);
  const gitClient = await createGitClient({ gitExecutable: await realpath(gitPath.trim()) });
  const requestBody = await readFile(REQUEST, 'utf8');
  const adapters = {
    jira: trackerAdapter('jira', 'DEMO-42', requestBody),
    linear: trackerAdapter('linear', 'DEMO-123', requestBody),
  };
  const remoteBefore = await git(target.root, 'ls-remote', '--refs', 'origin');
  let executionAttempt = 0;
  let integrationWorktree;

  const workflow = createFeatureWorkflow({
    gitClient,
    now: () => NOW,
    planningClientFor: async () => ({ async propose(contract) { return proposal(contract); } }),
    trackerAdapterFor: async ({ provider }) => adapters[provider],
    async executeFeature({ project, run }) {
      executionAttempt += 1;
      if (executionAttempt === 1) {
        return {
          status: 'blocked', summary: 'Worker interruption recorded; resume is safe.',
          runtimeRefs: ['worker:interrupted'], evidenceRefs: ['report:interrupted'],
        };
      }
      integrationWorktree = join(target.parent, 'integration');
      await execFile('/usr/bin/git', ['-C', project, 'worktree', 'add', '--quiet', '-b', 'feature/smart-agenda', integrationWorktree, run.featurePlan.baselineCommit]);
      await mkdir(join(integrationWorktree, 'app', 'agenda'), { recursive: true });
      await mkdir(join(integrationWorktree, 'test'), { recursive: true });
      await writeFile(join(integrationWorktree, 'app', 'agenda', 'smart-agenda.js'),
        "export function smartAgenda(accepted) { return [...new Set(accepted)]; }\n");
      await writeFile(join(integrationWorktree, 'test', 'smart-agenda.test.js'),
        "import assert from 'node:assert/strict'; import test from 'node:test'; import { smartAgenda } from '../app/agenda/smart-agenda.js'; test('preserves accepted sessions', () => assert.deepEqual(smartAgenda(['a', 'a']), ['a']));\n");
      await git(integrationWorktree, 'add', '.');
      await git(integrationWorktree, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '--quiet', '-m', 'feat: add smart agenda');
      for (const command of ['build', 'test', 'lint', 'typecheck']) {
        await execFile('npm', ['run', command], { cwd: integrationWorktree });
      }
      const commit = await git(integrationWorktree, 'rev-parse', 'HEAD');
      return {
        status: 'awaiting-final-approval', summary: 'Local feature branch passed every configured quality command.',
        runtimeRefs: ['worker:completed', 'branch:feature-smart-agenda'],
        evidenceRefs: [`commit:${commit}`, 'test:quality-gates'],
      };
    },
  });

  const markdown = await workflow.propose({
    project: target.root, source: { kind: 'file', value: join(target.root, 'requests', 'smart-agenda.md') }, client: 'claude',
  });
  const jira = await workflow.propose({
    project: target.root, source: { kind: 'ticket', value: 'DEMO-42' }, tracker: 'jira', client: 'claude',
  });
  const linear = await workflow.propose({
    project: target.root, source: { kind: 'ticket', value: 'DEMO-123' }, tracker: 'linear', client: 'claude',
  });

  assert.match(markdown.summary, /Claude sonnet, 120s\/\$1 planning, \$2 execution cap, no fallback/);
  assert.equal(markdown.featurePlan.clientProfile.id, 'claude-bounded-sonnet-v1');
  assert.deepEqual(
    markdown.featurePlan.nodes.map(({ objective, ownedPaths, commandIds, acceptanceCriteria }) => ({ objective, ownedPaths, commandIds, acceptanceCriteria })),
    jira.featurePlan.nodes.map(({ objective, ownedPaths, commandIds, acceptanceCriteria }) => ({ objective, ownedPaths, commandIds, acceptanceCriteria })),
  );
  assert.deepEqual(
    jira.featurePlan.nodes.map(({ objective, ownedPaths, commandIds, acceptanceCriteria }) => ({ objective, ownedPaths, commandIds, acceptanceCriteria })),
    linear.featurePlan.nodes.map(({ objective, ownedPaths, commandIds, acceptanceCriteria }) => ({ objective, ownedPaths, commandIds, acceptanceCriteria })),
  );

  const approved = await workflow.start({
    project: target.root, runId: markdown.runId, expectedVersion: markdown.version, proposalDigest: markdown.proposalDigest,
  });
  const interrupted = await workflow.resume({ project: target.root, runId: markdown.runId, expectedVersion: approved.version });
  assert.equal(interrupted.status, 'blocked');
  const observed = await workflow.status({ project: target.root, runId: markdown.runId });
  assert.equal(observed.version, interrupted.version);
  const completed = await workflow.resume({ project: target.root, runId: markdown.runId, expectedVersion: interrupted.version });
  assert.equal(completed.status, 'awaiting-final-approval');
  assert.match(completed.evidenceRefs.find(ref => ref.startsWith('commit:')), /^commit:[a-f0-9]{40}$/);

  assert.equal(await git(target.root, 'branch', '--show-current'), 'main');
  assert.equal(await git(target.root, 'rev-parse', 'HEAD'), target.baseline);
  assert.equal(await git(target.root, 'status', '--porcelain'), '');
  assert.equal(await git(target.root, 'ls-remote', '--refs', 'origin'), remoteBefore);
  assert.notEqual(await git(integrationWorktree, 'rev-parse', 'HEAD'), target.baseline);
  assert.equal(await git(target.root, 'rev-parse', 'origin/main'), target.baseline);

  const missingConfiguration = createFeatureWorkflow({
    gitClient,
    loadConfig: async () => { throw new Error('private configuration detail'); },
    planningClientFor: async () => ({ async propose(contract) { return proposal(contract); } }),
    executeFeature: async () => { throw new Error('must not execute'); },
  });
  await assert.rejects(
    () => missingConfiguration.propose({
      project: target.root, source: { kind: 'file', value: join(target.root, 'requests', 'smart-agenda.md') }, client: 'claude',
    }),
    error => error.code === 'ERR_FEATURE_WORKFLOW_CONFIGURATION' && !error.message.includes('private configuration detail'),
  );
});

test('accepts a harness-supplied decomposition without resolving a planning client', async () => {
  const target = await fixture();
  const { stdout: gitPath } = await execFile('which', ['git']);
  const gitClient = await createGitClient({ gitExecutable: await realpath(gitPath.trim()) });
  let planningCalls = 0;
  const workflow = createFeatureWorkflow({
    gitClient,
    now: () => NOW,
    protocolsFor: async () => ['protocol:database-changes:3:sha256:' + 'a'.repeat(64)],
    planningClientFor: async () => {
      planningCalls += 1;
      throw new Error('host preparation must not resolve a planning model');
    },
    async executeFeature() { throw new Error('proposal preparation must not execute work'); },
  });

  const prepared = await workflow.propose({
    project: target.root,
    source: { kind: 'file', value: join(target.root, 'requests', 'smart-agenda.md') },
    client: 'host',
    decomposition: proposal({
      workRequest: {
        acceptanceCriteria: [
          'Preserve sessions the attendee already accepted.',
          'Export the resulting agenda as an ICS file.',
        ],
      },
    }),
  });

  assert.equal(planningCalls, 0);
  assert.equal(prepared.status, 'proposed');
  assert.equal(prepared.featurePlan.client, 'host');
  assert.equal(Object.hasOwn(prepared.featurePlan, 'clientProfile'), false);
  assert.deepEqual(prepared.workRequest.contextRefs, [
    'product:conference-planner',
    'protocol:database-changes:3:sha256:' + 'a'.repeat(64),
  ]);
});
