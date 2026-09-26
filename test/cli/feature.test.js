import { createRivetApplication } from '../../src/runtime/application.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { FeaturePlanError } from '../../src/feature/plan-contract.js';

import { main } from '../../src/cli/main.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { EXIT_CODES } from '../../src/cli/output.js';

const execFile = promisify(execFileCallback);
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const VALID_CONFIG = join(HERE, '..', 'fixtures', 'config', 'valid', '.rivet');
const FAKE_CLIENT = join(HERE, '..', 'fixtures', 'clients', 'fake-feature-client.mjs');

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

async function installedFixture(t, kind, workerHarness) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), `rivet-installed-${kind}-`)));
  const root = join(parent, 'project');
  const remote = join(parent, 'origin.git');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'requests'), { recursive: true });
  await cp(VALID_CONFIG, join(root, '.rivet'), { recursive: true });
  if (workerHarness) {
    const path = join(root, '.rivet', 'orchestration.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('    kind: worker', `    kind: worker\n    harness: ${workerHarness}`));
  }
  await writeFile(join(root, 'requests', 'feature.md'), '# Recording agenda\n\n## Acceptance Criteria\n\n- Preserve recorded selections.\n');
  await writeFile(join(root, 'app', 'page.js'), "export const page = 'conference';\n");
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'installed-feature-fixture',
    private: true,
    scripts: { build: 'x', test: 'x', lint: 'x' },
  }, null, 2)}\n`);
  await execFile('git', ['init', '--quiet', '--bare', remote]);
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  await execFile('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  await execFile('git', ['-C', root, 'push', '--quiet', '-u', 'origin', 'main']);
  const client = join(parent, kind);
  await cp(FAKE_CLIENT, client);
  await chmod(client, 0o700);
  const otherClient = join(parent, kind === 'claude' ? 'codex' : 'claude');
  await cp(FAKE_CLIENT, otherClient);
  await chmod(otherClient, 0o700);
  const gate = join(parent, 'bounded-npm');
  await writeFile(gate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(gate, 0o700);
  if (process.env.KEEP_RIVET_FIXTURE !== '1') t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, remote, client, gate };
}

async function installedCli(args, env) {
  const result = await execFile(process.execPath, [join(PACKAGE_ROOT, 'bin', 'cli.js'), ...args], {
    cwd: PACKAGE_ROOT,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

function captureOutput() {
  const stdout = [];
  const stderr = [];
  return {
    output: Object.freeze({
      log: value => stdout.push(String(value)),
      warn: value => stderr.push(String(value)),
      error: value => stderr.push(String(value)),
      json(value, stream = 'stdout') { (stream === 'stderr' ? stderr : stdout).push(JSON.stringify(value)); },
    }),
    stdout,
    stderr,
  };
}

function service(overrides = {}) {
  return Object.freeze({
    propose: async input => ({ runId: 'feature-demo', version: 1, proposalDigest: 'a'.repeat(64), input }),
    start: async input => ({ runId: input.runId, version: 2, status: 'approved' }),
    watch: async input => ({ runId: input.runId, version: 3, status: 'running' }),
    status: async input => ({ runId: input.runId, version: 1, status: 'proposed' }),
    resume: async input => ({ runId: input.runId, version: input.expectedVersion + 1, status: 'running' }),
    cancel: async input => ({ runId: input.runId, version: input.expectedVersion + 1, status: 'cancelled' }),
    ...overrides,
  });
}

test('parses the bounded feature lifecycle surface', () => {
  assert.deepEqual(parseArgs([
    'feature', 'propose', '--project=/project', '--request=/requests/feature.md', '--client=claude', '--json',
  ]), {
    command: 'feature', subcommand: 'propose', operands: [],
    flags: { project: '/project', request: '/requests/feature.md', client: 'claude', json: true },
  });
  assert.deepEqual(parseArgs([
    'feature', 'start', 'feature-demo', '--project=/project', '--expected-version=1', `--proposal-digest=${'a'.repeat(64)}`,
  ]).subcommand, 'start');
});

test('propose accepts exactly one local or tracker source and emits stable JSON', async () => {
  const seen = [];
  for (const args of [
    ['--request=/requests/feature.md', '--client=claude'],
    ['--request-text=Add smart agenda suggestions', '--client=codex'],
    ['--ticket=DEMO-123', '--tracker=jira'],
    ['--ticket=ENG-44', '--tracker=linear'],
  ]) {
    const capture = captureOutput();
    const exitCode = await main(['feature', 'propose', '--project=/project', ...args, '--json'], {
      output: capture.output,
      feature: service({ propose: async input => { seen.push(input); return { runId: 'feature-demo', version: 1, proposalDigest: 'b'.repeat(64) }; } }),
    });
    assert.equal(exitCode, EXIT_CODES.SUCCESS);
    assert.equal(capture.stderr.length, 0);
    assert.deepEqual(JSON.parse(capture.stdout[0]), {
      ok: true, command: 'feature', subcommand: 'propose',
      result: { runId: 'feature-demo', version: 1, proposalDigest: 'b'.repeat(64) },
    });
  }
  assert.deepEqual(seen.map(input => input.source.kind), ['file', 'inline', 'ticket', 'ticket']);
  assert.equal(seen[2].tracker, 'jira');
  assert.equal(seen[3].tracker, 'linear');
});

test('rejects absent ambiguous or inconsistent proposal sources before calling the application', async () => {
  let calls = 0;
  const feature = service({ propose: async () => { calls += 1; } });
  for (const argv of [
    ['feature', 'propose', '--project=/project', '--client=claude'],
    ['feature', 'propose', '--project=/project', '--request=/a.md', '--request-text=text', '--client=claude'],
    ['feature', 'propose', '--project=/project', '--request=/a.md', '--tracker=jira'],
    ['feature', 'propose', '--project=relative', '--request=/a.md', '--client=claude'],
    ['feature', 'propose', '--project=/project', '--ticket=DEMO-1', '--tracker=github'],
  ]) {
    const capture = captureOutput();
    assert.equal(await main(argv, { output: capture.output, feature }), EXIT_CODES.INVALID_INPUT);
    assert.equal(capture.stdout.length, 0);
  }
  assert.equal(calls, 0);
});

test('binds start resume and cancel to exact run version and proposal digest inputs', async () => {
  const calls = [];
  const feature = service({
    start: async input => { calls.push(['start', input]); return { status: 'approved' }; },
    resume: async input => { calls.push(['resume', input]); return { status: 'running' }; },
    cancel: async input => { calls.push(['cancel', input]); return { status: 'cancelled' }; },
  });
  const digest = 'c'.repeat(64);
  for (const argv of [
    ['feature', 'start', 'feature-demo', '--project=/project', '--expected-version=4', `--proposal-digest=${digest}`],
    ['feature', 'resume', 'feature-demo', '--project=/project', '--expected-version=5'],
    ['feature', 'cancel', 'feature-demo', '--project=/project', '--expected-version=6'],
  ]) {
    const capture = captureOutput();
    assert.equal(await main(argv, { output: capture.output, feature }), EXIT_CODES.SUCCESS);
  }
  assert.deepEqual(calls, [
    ['start', { project: '/project', runId: 'feature-demo', expectedVersion: 4, proposalDigest: digest }],
    ['resume', { project: '/project', runId: 'feature-demo', expectedVersion: 5 }],
    ['cancel', { project: '/project', runId: 'feature-demo', expectedVersion: 6 }],
  ]);
});

test('rejects incomplete or malformed lifecycle mutations before application effects', async () => {
  let calls = 0;
  const mutate = async () => { calls += 1; };
  const feature = service({ start: mutate, resume: mutate, cancel: mutate });
  for (const argv of [
    ['feature', 'start', 'feature-demo', '--project=/project', '--expected-version=1'],
    ['feature', 'start', 'feature-demo', '--project=/project', '--expected-version=0', `--proposal-digest=${'a'.repeat(64)}`],
    ['feature', 'start', 'feature-demo', '--project=/project', '--expected-version=1', '--proposal-digest=bad'],
    ['feature', 'resume', 'feature-demo', '--project=/project'],
    ['feature', 'cancel', '../other', '--project=/project', '--expected-version=1'],
  ]) {
    const capture = captureOutput();
    assert.equal(await main(argv, { output: capture.output, feature }), EXIT_CODES.INVALID_INPUT);
  }
  assert.equal(calls, 0);
});

test('status reads one explicit private run without mutation', async () => {
  let input;
  const capture = captureOutput();
  const exitCode = await main(['feature', 'status', 'feature-demo', '--project=/project', '--json'], {
    output: capture.output,
    feature: service({ status: async value => { input = value; return { runId: value.runId, status: 'proposed', version: 1 }; } }),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(input, { project: '/project', runId: 'feature-demo' });
  assert.equal(JSON.parse(capture.stdout[0]).result.status, 'proposed');
});

test('human run displays the proposal asks once then starts and watches the approved run', async () => {
  const calls = [];
  let prompts = 0;
  const capture = captureOutput();
  const digest = 'd'.repeat(64);
  const exitCode = await main([
    'feature', 'run', '--project=/project', '--request-text=Add agenda suggestions', '--client=claude',
  ], {
    output: capture.output,
    confirmFeatureActivation: async proposal => { prompts += 1; calls.push(['confirm', proposal.runId]); return true; },
    feature: service({
      propose: async input => { calls.push(['propose', input.source.kind]); return { runId: 'feature-demo', version: 1, proposalDigest: digest, summary: 'Three bounded tasks.' }; },
      start: async input => { calls.push(['start', input]); return { runId: input.runId, version: 2, status: 'approved' }; },
      watch: async input => { calls.push(['watch', input]); return { runId: input.runId, version: 3, status: 'running' }; },
    }),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(prompts, 1);
  assert.match(capture.stdout[0], /Three bounded tasks/);
  assert.deepEqual(calls.map(call => call[0]), ['propose', 'confirm', 'start', 'watch']);
});

test('JSON run never prompts or activates', async () => {
  let effects = 0;
  const capture = captureOutput();
  const exitCode = await main([
    'feature', 'run', '--project=/project', '--request-text=Add agenda suggestions', '--client=claude', '--json',
  ], {
    output: capture.output,
    confirmFeatureActivation: async () => { effects += 1; return true; },
    feature: service({ propose: async () => { effects += 1; } }),
  });
  assert.equal(exitCode, EXIT_CODES.INVALID_INPUT);
  assert.equal(effects, 0);
  assert.equal(capture.stdout.length, 0);
  assert.equal(JSON.parse(capture.stderr[0]).error.code, 'INVALID_INPUT');
});

test('maps bounded workflow prerequisites and version conflicts to stable public CLI errors', async () => {
  for (const [code, expected] of [
    ['ERR_FEATURE_WORKFLOW_CONFIGURATION', 'MISSING_CONFIGURATION'],
    ['ERR_FEATURE_WORKFLOW_STATE_CONFLICT', 'REPOSITORY_CONFLICT'],
    ['ERR_AGENT_OUTPUT_INVALID', 'PROVIDER_UNAVAILABLE'],
  ]) {
    const capture = captureOutput();
    const error = Object.assign(new Error('private detail'), { code, safeMessage: 'Bounded workflow failure.' });
    const exitCode = await main([
      'feature', 'propose', '--project=/project', '--request=/requests/feature.md', '--client=claude', '--json',
    ], { output: capture.output, feature: service({ propose: async () => { throw error; } }) });
    assert.equal(exitCode, EXIT_CODES[expected]);
    assert.equal(JSON.parse(capture.stderr[0]).error.code, expected);
    assert.equal(capture.stderr[0].includes('private detail'), false);
  }
});

test('installed CLI uses one selected live client through planning and Worker execution without moving main or remotes', async t => {
  for (const [kind, workerHarness] of [['claude', undefined], ['codex', undefined], ['claude','codex'], ['codex','claude']]) {
    await t.test(`${kind} planner, ${workerHarness ?? kind} worker`, async t => {
      const fixture = await installedFixture(t, kind, workerHarness);
      const worker = workerHarness ?? kind;
      const gitPath = await gitExecutable();
      const baseline = (await execFile('git', ['-C', fixture.root, 'rev-parse', 'HEAD'])).stdout.trim();
      const remoteBefore = (await execFile('git', ['-C', fixture.root, 'ls-remote', '--refs', 'origin'])).stdout;
      const environment = {
        PATH: `${fixture.parent}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        TMPDIR: fixture.parent,
        RIVET_GIT_EXECUTABLE: gitPath,
        RIVET_NPM_EXECUTABLE: fixture.gate,
        [`RIVET_${kind.toUpperCase()}_EXECUTABLE`]: fixture.client,
        RIVET_CLAUDE_INTERPRETER: await realpath(process.execPath),
        RIVET_CODEX_INTERPRETER: await realpath(process.execPath),
      };
      const proposal = (await installedCli([
        'feature', 'propose', `--project=${fixture.root}`, `--request=${join(fixture.root, 'requests', 'feature.md')}`,
        `--client=${kind}`, '--json',
      ], environment)).result;
      const configPath = join(fixture.root, '.rivet', 'orchestration.yaml');
      const exactConfig = await readFile(configPath, 'utf8');
      if (workerHarness) {
        assert.equal(proposal.featurePlan.nodes.find(node => node.role === 'worker').execution.client, workerHarness);
        await writeFile(configPath, exactConfig.replace(`    harness: ${workerHarness}\n`, ''));
        await assert.rejects(installedCli(['feature','start',proposal.runId,`--project=${fixture.root}`,
          `--expected-version=${proposal.version}`,`--proposal-digest=${proposal.proposalDigest}`,'--json'], environment));
        const unchanged = (await installedCli(['feature','status',proposal.runId,`--project=${fixture.root}`,'--json'],environment)).result;
        assert.equal(unchanged.status,'proposed'); assert.equal(unchanged.version,proposal.version);
        await writeFile(configPath, exactConfig);
      }
      const approved = (await installedCli([
        'feature', 'start', proposal.runId, `--project=${fixture.root}`, `--expected-version=${proposal.version}`,
        `--proposal-digest=${proposal.proposalDigest}`, '--json',
      ], environment)).result;
      if (workerHarness) {
        await writeFile(configPath, exactConfig.replace(`    harness: ${workerHarness}\n`, ''));
        await assert.rejects(installedCli(['feature','resume',proposal.runId,`--project=${fixture.root}`,
          `--expected-version=${approved.version}`,'--json'],environment));
        const unchanged = (await installedCli(['feature','status',proposal.runId,`--project=${fixture.root}`,'--json'],environment)).result;
        assert.equal(unchanged.status,'approved'); assert.equal(unchanged.version,approved.version);
        await writeFile(configPath, exactConfig);
      }
      const completed = (await installedCli([
        'feature', 'resume', proposal.runId, `--project=${fixture.root}`, `--expected-version=${approved.version}`, '--json',
      ], environment)).result;
      const observed = (await installedCli([
        'feature', 'status', proposal.runId, `--project=${fixture.root}`, '--json',
      ], environment)).result;

      assert.equal(completed.status, 'awaiting-final-approval', JSON.stringify(completed));
      assert.equal(observed.status, 'awaiting-final-approval');
      assert.equal((await execFile('git', ['-C', fixture.root, 'branch', '--show-current'])).stdout.trim(), 'main');
      assert.equal((await execFile('git', ['-C', fixture.root, 'rev-parse', 'HEAD'])).stdout.trim(), baseline);
      assert.equal((await execFile('git', ['-C', fixture.root, 'status', '--porcelain'])).stdout, '');
      assert.equal((await execFile('git', ['-C', fixture.root, 'ls-remote', '--refs', 'origin'])).stdout, remoteBefore);
      const log = (await readFile(join(fixture.parent, 'rivet-fake-client.log'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(log.map(item => item.provider), [kind, worker]);
      assert.deepEqual(log.map(item => item.mode), [kind === 'claude' ? 'dontAsk' : 'read-only', worker === 'claude' ? 'acceptEdits' : 'workspace-write']);
      assert.deepEqual(log.map(item => item.kind), ['agilno.feature-planning', 'agilno.agent-launch']);
      assert.equal((await execFile('git', ['-C', fixture.root, 'ls-files', '.git/rivet'])).stdout, '');
    });
  }
});


test('JSON proposal failures preserve sanitized governed-plan diagnostics without activation fields', async () => {
  const capture = captureOutput();
  const feature = service({ propose: async () => {
    throw new FeaturePlanError('compiled-plan-invalid', 'owned-path-protected');
  } });
  const code = await main(['feature', 'propose', '--project=/project', '--request=/project/request.md', '--client=claude', '--json'],
    { output: capture.output, feature });
  assert.equal(code, EXIT_CODES.INVALID_INPUT);
  const result = JSON.parse([...capture.stdout, ...capture.stderr].join(''));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /protected project path/);
  assert.equal(result.result, undefined);
});


test('real application composes a Linear read into a proposal without a Markdown request', async t => {
  const fixture = await installedFixture(t, 'claude');
  const providers = join(fixture.root, '.rivet', 'providers.yaml');
  await writeFile(providers, (await readFile(providers, 'utf8')) + `
  - id: linear-main
    kind: linear
    mode: read-only
    capabilities: [issues-read]
    endpoint: https://api.linear.app
    credentials:
      apiTokenEnv: LINEAR_API_TOKEN
`);
  await execFile('git', ['-C', fixture.root, 'add', '.rivet/providers.yaml']);
  await execFile('git', ['-C', fixture.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Linear policy']);
  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  let reads = 0;
  const providerTransport = createTrustedProviderTransport({
    resolve: async () => ['93.184.216.34'],
    fetchPinned: async (url, init) => {
      reads += 1;
      assert.equal(url, 'https://api.linear.app/graphql');
      assert.equal(init.headers.authorization, 'fixture-linear-credential');
      assert.equal(JSON.parse(init.body).variables.identifier, 'ENG-7');
      return new Response(JSON.stringify({ data: { issue: {
        id: 'issue-7', identifier: 'ENG-7', title: 'Recording agenda', description: 'AC1: Preserve recorded selections.',
        updatedAt: '2026-09-18T00:00:00.000Z', url: 'https://linear.app/example/issue/ENG-7',
        state: { id: 'open', name: 'Open' }, team: { id: 'team', key: 'ENG' },
        labels: empty, relations: empty, comments: empty,
      } } }));
    },
  });
  const env = {
    PATH: process.env.PATH, TMPDIR: fixture.parent,
    RIVET_GIT_EXECUTABLE: await gitExecutable(),
    RIVET_CLAUDE_EXECUTABLE: fixture.client,
    RIVET_CLAUDE_INTERPRETER: await realpath(process.execPath),
    LINEAR_API_TOKEN: 'fixture-linear-credential',
  };
  const app = createRivetApplication({ env, providerTransport });
  const proposal = await app.feature.propose({ project: fixture.root, source: { kind: 'ticket', value: 'ENG-7' }, tracker: 'linear', client: 'claude' });
  assert.equal(reads, 1);
  assert.equal(proposal.workRequest.source.kind, 'linear');
  assert.equal(proposal.workRequest.source.ref, 'ENG-7');
  assert.match(proposal.workRequest.source.revision, /sha256:/);
  assert.ok(!JSON.stringify(proposal).includes('fixture-linear-credential'));
  assert.equal((await execFile('git', ['-C', fixture.root, 'status', '--porcelain'])).stdout, '');
  const missing = createRivetApplication({ env: { ...env, LINEAR_API_TOKEN: '' }, providerTransport });
  await assert.rejects(() => missing.feature.propose({ project: fixture.root, source: { kind: 'ticket', value: 'ENG-7' }, tracker: 'linear', client: 'claude' }), error => error.code === 'ERR_TRACKER_PROVIDER_CONFIGURATION');
  assert.equal(reads, 1);
});

test('feature ticket proposals accept supplemental criteria and reject invalid or local-source additions', async () => {
  const {featureCommand}=await import('../../src/commands/feature.js');let received;
  const dependencies={output:{log(){},json(){}},feature:{async propose(input){received=input;return {runId:'run-one',version:1,proposalDigest:'a'.repeat(64)};}}};
  const parsed={command:'feature',subcommand:'propose',operands:[],flags:{project:'/repo',ticket:'DEMO-42','acceptance-criteria':'First\nSecond'}};
  assert.equal(await featureCommand(parsed,dependencies),0);assert.deepEqual(received.userAcceptanceCriteria,['First','Second']);
  received=null;
  await assert.rejects(featureCommand({...parsed,flags:{project:'/repo','request-text':'local',client:'codex','acceptance-criteria':'Unexpected'}},dependencies));assert.equal(received,null);
  assert.equal(parseArgs(['feature','run','--project=/repo','--ticket=DEMO-42','--acceptance-criteria=First']).flags['acceptance-criteria'],'First');
});

test('feature ticket run previews tracker and user criteria separately before activation, and JSON retains provenance', async () => {
  const {featureCommand}=await import('../../src/commands/feature.js');const lines=[];let json;
  const workRequest={acceptanceCriteria:['Source','User'],criteriaProvenance:{sourceAcceptanceCriteria:['Source'],userAcceptanceCriteria:['User']}};
  const result={runId:'run-one',version:1,proposalDigest:'a'.repeat(64),workRequest};
  const dependencies={output:{log(value){lines.push(value);},json(value){json=value;}},feature:{async propose(){return result;},async start(){throw new Error('must not activate');},async watch(){throw new Error('must not execute');}},async confirmFeatureActivation(){assert.match(lines.join('\n'),/Tracker acceptance criteria:[\s\S]*Source[\s\S]*User-supplied acceptance criteria:[\s\S]*User/);return false;}};
  const parsed={command:'feature',subcommand:'run',operands:[],flags:{project:'/repo',ticket:'DEMO-42','acceptance-criteria':'User'}};
  assert.equal(await featureCommand(parsed,dependencies),0);
  assert.equal(await featureCommand({...parsed,subcommand:'propose',flags:{...parsed.flags,json:true}},dependencies),0);
  assert.deepEqual(JSON.parse(JSON.stringify(json.result.workRequest.criteriaProvenance)),workRequest.criteriaProvenance);
});
