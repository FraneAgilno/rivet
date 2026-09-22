import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { renameSync, symlinkSync } from 'node:fs';
import {
  access,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../src/cli/main.js';
import { graphFixture } from '../../src/graph/fixtures.js';
import { readyNodeIds } from '../../src/graph/scheduler.js';
import { transitionAllowed } from '../../src/graph/reducer.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOLS = [
  'agent-orchestration.md',
  'goal-graph.md',
  'pattern-first-development.md',
  'design-authority.md',
  'qa-evidence.md',
  'security.md',
];
const MANDATORY_SKILLS = ['agentic-goal.md', 'agentic-status.md', 'feature-workflow.md'];
const ROLE_PROMPTS = [
  'boss-agent.md',
  'product-design-manager.md',
  'engineering-manager.md',
  'quality-manager.md',
  'bounded-worker.md',
];
const GRAPH_STATUSES = [
  'proposed', 'approved', 'ready', 'reserved', 'running', 'verifying', 'corrective',
  'blocked', 'failed', 'completed', 'archived', 'cancelled',
];
const EXPECTED_TRANSITIONS = {
  proposed: ['approved', 'blocked', 'cancelled'],
  approved: ['ready', 'blocked', 'cancelled'],
  ready: ['reserved', 'blocked', 'cancelled'],
  reserved: ['ready', 'running', 'blocked', 'cancelled'],
  running: ['verifying', 'corrective', 'blocked', 'failed', 'cancelled'],
  verifying: ['completed', 'corrective', 'blocked', 'failed', 'cancelled'],
  corrective: ['ready', 'reserved', 'running', 'verifying', 'blocked', 'failed', 'cancelled'],
  blocked: ['ready', 'corrective', 'failed', 'cancelled'],
  failed: ['corrective', 'archived'],
  completed: ['archived'],
  archived: [],
  cancelled: ['archived'],
};

function spawnProcess(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
    timeout.unref();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createBuildFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rivet-v2-build-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
    name: 'rivet-v2-build-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['dist/', 'schemas/', 'protocols/', 'templates/'],
  }) + '\n');
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
  await cp(join(REPOSITORY_ROOT, 'scripts', 'build.js'), join(fixtureRoot, 'scripts', 'build.js'));
  for (const directory of ['mandatory', 'optional', 'protocols', 'schemas', 'templates']) {
    await cp(join(REPOSITORY_ROOT, directory), join(fixtureRoot, directory), { recursive: true });
  }
  return fixtureRoot;
}

async function runBuild(fixtureRoot, options = {}) {
  return spawnProcess(process.execPath, [
    ...(options.execArgv ?? []),
    join(fixtureRoot, 'scripts', 'build.js'),
  ], {
    cwd: fixtureRoot,
    env: options.env,
  });
}

function runBuildWithOutputHook(fixtureRoot, trigger, hook) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(fixtureRoot, 'scripts', 'build.js')], {
      cwd: fixtureRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let hookPromise;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!hookPromise && stdout.includes(trigger)) {
        const stopped = process.platform !== 'win32' && child.kill('SIGSTOP');
        try { hookPromise = Promise.resolve(hook()); }
        catch (error) {
          hookPromise = Promise.reject(error);
          hookPromise.catch(() => {});
        }
        if (stopped) child.kill('SIGCONT');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    timeout.unref();
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      clearTimeout(timeout);
      try {
        await hookPromise;
        resolvePromise({ code, signal, stdout, stderr, hookRan: Boolean(hookPromise) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function listFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split('\\').join('/'));
  }
  return files.sort();
}

function parseTransitionTable(content) {
  const section = content.match(/^## State transitions\n([\s\S]*?)(?=^## |\Z)/m)?.[1] ?? '';
  const transitions = {};
  for (const line of section.split('\n')) {
    const match = line.match(/^- `([^`]+)` -> (.+)$/);
    if (!match) continue;
    transitions[match[1]] = match[2] === 'none'
      ? []
      : [...match[2].matchAll(/`([^`]+)`/g)].map(candidate => candidate[1]);
  }
  return { section, transitions };
}

async function runBuildAfterOutputMutation(fixtureRoot, sourcePath, replacementPath) {
  const backupPath = `${sourcePath}.safe`;
  for (let index = 0; index < 300; index += 1) {
    await writeFile(
      join(fixtureRoot, 'optional', 'skills', `slow-${String(index).padStart(3, '0')}.md`),
      `# Slow ${index}\n\nSlow build fixture ${index}.\n`,
    );
  }
  const result = await runBuildWithOutputHook(fixtureRoot, 'skill: slow-050', () => {
    renameSync(sourcePath, backupPath);
    renameSync(replacementPath, sourcePath);
  });
  assert.equal(result.hookRan, true, `late source hook did not run\nstdout:\n${result.stdout}`);
  renameSync(sourcePath, replacementPath);
  renameSync(backupPath, sourcePath);
  return result;
}

test('portable v2 sources declare versioned protocols, thin CLI skills, and sealed role boundaries', async () => {
  const protocolContents = await Promise.all(PROTOCOLS.map(name => readFile(join(REPOSITORY_ROOT, 'protocols', name), 'utf8')));
  const combinedProtocols = protocolContents.join('\n');

  for (const [index, content] of protocolContents.entries()) {
    assert.match(content, /^# /, `${PROTOCOLS[index]} needs a title`);
    assert.match(content, /Protocol version:\s*1/i, `${PROTOCOLS[index]} needs an explicit version`);
    assert.doesNotMatch(content, /ClientCompany|PrivateProduct/i);
  }
  for (const section of ['Authority', 'State transitions', 'Stop conditions', 'Evidence', 'Recovery', 'Client adapter boundaries']) {
    assert.match(combinedProtocols, new RegExp(`^## ${section}$`, 'mi'), `missing portable protocol section: ${section}`);
  }

  const goalSkill = await readFile(join(REPOSITORY_ROOT, 'mandatory', 'skills', 'agentic-goal.md'), 'utf8');
  const statusSkill = await readFile(join(REPOSITORY_ROOT, 'mandatory', 'skills', 'agentic-status.md'), 'utf8');
  const skills = `${goalSkill}\n${statusSkill}`;
  assert.match(skills, /rivet preflight/);
  assert.match(skills, /rivet goals status/);
  assert.match(skills, /rivet orchestrate run/);
  assert.match(skills, /rivet status/);
  assert.match(skills, /human decision|decision handoff/i);
  assert.match(skills, /thin (?:operator entry point|CLI entry point)|does not recreate/i);

  for (const name of ROLE_PROMPTS) {
    const role = await readFile(join(REPOSITORY_ROOT, 'optional', 'agents', name), 'utf8');
    assert.match(role, /sealed launch contract/i, `${name} must consume the sealed contract`);
    assert.match(role, /do not (?:redefine|expand|widen) (?:the )?(?:authority|permissions)/i, `${name} must preserve authority`);
    assert.match(role, /stop condition/i, `${name} must honor stop conditions`);
    assert.doesNotMatch(role, /ClientCompany|PrivateProduct/i);
  }
  const combinedRoles = (await Promise.all(ROLE_PROMPTS.map(name => readFile(join(REPOSITORY_ROOT, 'optional', 'agents', name), 'utf8')))).join('\n');
  assert.match(combinedRoles, /Boss does not implement|do not implement feature code/i);
  assert.match(combinedRoles, /Managers? may delegate only/i);
  assert.match(combinedRoles, /Workers? (?:cannot|must not) merge/i);
  assert.match(combinedRoles, /must not (?:approve|self-approve).*(?:own|your own)|no self-approval/i);
  assert.match(combinedRoles, /must not (?:publish|update|mutate).*(?:final Jira|final documentation)|final Jira.*must not|final documentation.*must not/i);
  assert.match(combinedRoles, /must not expose.*(?:private paths|raw prompts)|private paths.*raw prompts/i);
});

test('feature workflow skill routes natural-language requests through one governed CLI lifecycle', async () => {
  const content = await readFile(join(REPOSITORY_ROOT, 'mandatory', 'skills', 'feature-workflow.md'), 'utf8');

  assert.match(content, /Use Rivet to implement (?:Jira )?DEMO-123/i);
  assert.match(content, /rivet preflight --project/);
  assert.match(content, /rivet feature propose/);
  assert.match(content, /--request=.*\.md/);
  assert.match(content, /--ticket=DEMO-123/);
  assert.match(content, /rivet feature start/);
  assert.match(content, /--expected-version=.*--proposal-digest=/s);
  assert.match(content, /rivet feature (?:status|resume)/);
  assert.match(content, /thin (?:agent|CLI|operator).*entry point|same application service/i);
  assert.match(content, /do not (?:bypass|reimplement).*application service/i);
  assert.match(content, /do not invent.*(?:ticket|tracker)/i);
  assert.match(content, /explicit human activation|human.*exact proposal/i);
  assert.match(content, /stop at (?:the )?human final(?:-delivery)? gate/i);
  assert.match(content, /never (?:push|merge|deploy|publish)|no push, merge, deploy/i);
});

test('live feature runtime documentation covers setup, both clients, recovery, and the short Conference walkthrough', async () => {
  const names = [
    'PROJECT-ONBOARDING.md', 'OPERATOR-QUICKSTART.md', 'CONFERENCE-DEMO.md',
    'KNOWN-LIMITATIONS.md', 'SECURITY-MODEL.md',
  ];
  const documents = Object.fromEntries(await Promise.all(names.map(async name => [
    name, await readFile(join(REPOSITORY_ROOT, 'docs', 'v2', name), 'utf8'),
  ])));
  const combined = Object.values(documents).join('\n');

  for (const name of [
    'RIVET_CLAUDE_EXECUTABLE', 'RIVET_CODEX_EXECUTABLE',
    'RIVET_CLAUDE_INTERPRETER', 'RIVET_CODEX_INTERPRETER',
    'RIVET_NPM_EXECUTABLE',
  ]) assert.match(combined, new RegExp(name));
  assert.match(combined, /Claude.*Read,? ?Glob,? ?Grep.*acceptEdits/is);
  assert.match(combined, /Codex.*read-only.*workspace-write/is);
  assert.match(combined, /same selected client/i);
  assert.match(combined, /\.rivet-worktrees/);
  assert.match(combined, /maxActiveNodes.?[:= ]+1|one Worker at a time/i);
  assert.match(combined, /Markdown.*Jira.*Linear/is);
  assert.match(combined, /awaiting-final-approval/);
  assert.match(combined, /never (?:push|merge|deploy|publish)|no push, merge, deploy/i);
  assert.match(combined, /10[–-]15 minute/i);
  assert.match(documents['CONFERENCE-DEMO.md'], /setup.*proposal.*activation.*Worker.*quality.*final/is);
  assert.match(documents['OPERATOR-QUICKSTART.md'], /blocked.*status.*resume/is);
  assert.doesNotMatch(documents['KNOWN-LIMITATIONS.md'], /no approved planning\/worker adapter configuration yet/i);
});

test('normative protocol transition tables exactly match the graph reducer and reject invented lifecycle states', async () => {
  const schema = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'schemas', 'goal-graph.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.status.enum, GRAPH_STATUSES);
  for (const priorState of GRAPH_STATUSES) {
    assert.deepEqual(
      GRAPH_STATUSES.filter(newState => transitionAllowed(priorState, newState)).sort(),
      [...EXPECTED_TRANSITIONS[priorState]].sort(),
      `${priorState} fixture must remain aligned with the reducer`,
    );
  }
  for (const name of ['agent-orchestration.md', 'goal-graph.md']) {
    const content = await readFile(join(REPOSITORY_ROOT, 'protocols', name), 'utf8');
    const parsed = parseTransitionTable(content);
    assert.deepEqual(parsed.transitions, EXPECTED_TRANSITIONS, `${name} must publish the exact reducer transition table`);
    assert.doesNotMatch(
      parsed.section,
      /\b(?:initialized|grounded|proposal|active|review|delivered|closed|pending|submitted|verified|budget-exhausted)\b/i,
      `${name} contains an unsupported normative state`,
    );
  }
});

test('feature planning schema is packaged with the portable v2 assets', async () => {
  for (const name of ['feature-plan.schema.json', 'feature-decomposition.schema.json']) {
    const source = await readFile(join(REPOSITORY_ROOT, 'schemas', name), 'utf8');
    const packaged = await readFile(join(REPOSITORY_ROOT, 'dist', 'v2', 'schemas', name), 'utf8');
    assert.deepEqual(JSON.parse(packaged), JSON.parse(source));
  }
  const schema = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'schemas', 'feature-plan.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.client.enum, ['claude', 'codex']);
  assert.equal(schema.$defs.node.additionalProperties, false);
  const decomposition = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'schemas', 'feature-decomposition.schema.json'), 'utf8',
  ));
  assert.equal(decomposition.properties.kind.const, 'agilno.feature-decomposition');
  assert.equal(decomposition.$defs.workItem.additionalProperties, false);
});

test('goal protocol distinguishes persisted ready state from dependency-gated scheduler eligibility and exact activation bindings', async () => {
  const graph = graphFixture('parallel-fan-in');
  const integration = graph.nodes.find(node => node.id === 'integration');
  assert.equal(integration.status, 'ready', 'canonical fixtures may persist ready before dependencies complete');
  assert.ok(integration.dependencies.some(id => graph.nodes.find(node => node.id === id)?.status !== 'completed'));
  assert.equal(readyNodeIds(graph).includes(integration.id), false, 'the scheduler must still withhold the node');

  const content = await readFile(join(REPOSITORY_ROOT, 'protocols', 'goal-graph.md'), 'utf8');
  assert.match(content, /(?:ready|corrective).{0,120}schedulable only when (?:all|every) (?:declared )?dependenc(?:y is|ies are) `?completed`?/is);
  assert.match(content, /(?:may|can) (?:be )?persist(?:ed)? (?:as |in )?`ready`.{0,160}dependenc/is);
  assert.match(content, /activation.{0,240}exact instance (?:resource|ID).{0,160}authority.{0,160}receipt.{0,160}expected (?:state )?version/is);
  assert.doesNotMatch(content, /proposal digest|approved proposal digest|digest differs/i);
});

test('build deterministically copies v2 protocols, schemas, and templates once while preserving generated v1 surfaces', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const stale = join(fixtureRoot, 'dist', 'v2', 'protocols', 'stale.md');
  await mkdir(dirname(stale), { recursive: true });
  await writeFile(stale, 'stale\n');

  const first = await runBuild(fixtureRoot);
  assert.equal(first.code, 0, `build failed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const firstFiles = await listFiles(join(fixtureRoot, 'dist'));
  const firstContents = await Promise.all(firstFiles.map(path => readFile(join(fixtureRoot, 'dist', path), 'utf8')));

  const second = await runBuild(fixtureRoot);
  assert.equal(second.code, 0, `repeat build failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  const secondFiles = await listFiles(join(fixtureRoot, 'dist'));
  const secondContents = await Promise.all(secondFiles.map(path => readFile(join(fixtureRoot, 'dist', path), 'utf8')));

  assert.deepEqual(secondFiles, firstFiles);
  assert.deepEqual(secondContents, firstContents);
  assert.equal(await pathExists(stale), false);
  assert.equal(await pathExists(join(fixtureRoot, 'dist', 'mandatory', 'design', 'SKILL.md')), true);
  assert.equal(await pathExists(join(fixtureRoot, 'dist', 'skills', 'debugging', 'SKILL.md')), true);
  assert.equal(await pathExists(join(fixtureRoot, 'dist', 'agents', 'qa-agent', 'SKILL.md')), true);

  for (const name of PROTOCOLS) {
    assert.equal(
      await readFile(join(fixtureRoot, 'dist', 'v2', 'protocols', name), 'utf8'),
      await readFile(join(fixtureRoot, 'protocols', name), 'utf8'),
    );
  }
  for (const directory of ['schemas', 'templates']) {
    const sourceFiles = await listFiles(join(fixtureRoot, directory));
    const distributionFiles = await listFiles(join(fixtureRoot, 'dist', 'v2', directory));
    assert.deepEqual(distributionFiles, sourceFiles);
    for (const path of sourceFiles) {
      assert.equal(
        await readFile(join(fixtureRoot, 'dist', 'v2', directory, path), 'utf8'),
        await readFile(join(fixtureRoot, directory, path), 'utf8'),
      );
    }
  }
  for (const name of MANDATORY_SKILLS) {
    assert.equal(await pathExists(join(fixtureRoot, 'dist', 'mandatory', name.slice(0, -3), 'SKILL.md')), true);
  }
  for (const name of ROLE_PROMPTS) {
    assert.equal(await pathExists(join(fixtureRoot, 'dist', 'agents', name.slice(0, -3), 'SKILL.md')), true);
  }
});

test('build rejects unsafe or linked v2 asset sources before replacing generated output', async (t) => {
  await t.test('symbolic link', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const preserved = join(fixtureRoot, 'dist', 'v2', 'protocols', 'preserved.md');
    await mkdir(dirname(preserved), { recursive: true });
    await writeFile(preserved, 'preserved\n');
    const external = join(fixtureRoot, 'external.md');
    await writeFile(external, 'external\n');
    await symlink(external, join(fixtureRoot, 'protocols', 'linked.md'));

    const result = await runBuild(fixtureRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /symbolic link/i);
    assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
  });

  await t.test('unsafe name', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const preserved = join(fixtureRoot, 'dist', 'v2', 'protocols', 'preserved.md');
    await mkdir(dirname(preserved), { recursive: true });
    await writeFile(preserved, 'preserved\n');
    await writeFile(join(fixtureRoot, 'protocols', 'unsafe name.md'), 'unsafe\n');

    const result = await runBuild(fixtureRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unsafe asset name/i);
    assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
  });
});

test('build rejects unsafe destination topology before deleting or writing any output', async (t) => {
  await t.test('dist root symbolic link', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const outside = join(fixtureRoot, 'outside-dist');
    const marker = join(outside, 'skills', 'preserved.md');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, 'outside-preserved\n');
    await symlink(outside, join(fixtureRoot, 'dist'), 'dir');

    const result = await runBuild(fixtureRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /destination.*symbolic link|symbolic link.*destination/i);
    assert.equal(await readFile(marker, 'utf8'), 'outside-preserved\n');
  });

  await t.test('category ancestor symbolic link', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const outside = join(fixtureRoot, 'outside-v2');
    const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
    await mkdir(outside, { recursive: true });
    await mkdir(dirname(preserved), { recursive: true });
    await writeFile(preserved, 'preserved\n');
    await symlink(outside, join(fixtureRoot, 'dist', 'v2'), 'dir');

    const result = await runBuild(fixtureRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /destination.*symbolic link|symbolic link.*destination/i);
    assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
    assert.deepEqual(await readdir(outside), []);
  });

  await t.test('category ancestor is not a directory', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
    await mkdir(dirname(preserved), { recursive: true });
    await writeFile(preserved, 'preserved\n');
    await writeFile(join(fixtureRoot, 'dist', 'mandatory'), 'not-a-directory\n');

    const result = await runBuild(fixtureRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /destination.*directory/i);
    assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
  });
});

test('build stages a complete tree and never traverses raced public destination categories', async (t) => {
  await t.test('v2 category swap cannot overwrite an outside leaf victim', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const initial = await runBuild(fixtureRoot);
    assert.equal(initial.code, 0, initial.stderr);
    await writeFile(join(fixtureRoot, 'templates', 'victim.txt'), 'packaged-public-content\n');
    for (let index = 0; index < 600; index += 1) {
      await writeFile(join(fixtureRoot, 'templates', `zz-race-${String(index).padStart(3, '0')}.txt`), `race ${index}\n`);
    }
    const outside = join(fixtureRoot, 'outside-v2');
    const victim = join(outside, 'templates', 'victim.txt');
    await mkdir(dirname(victim), { recursive: true });
    await writeFile(victim, 'outside-leaf-private-canary\n');

    const result = await runBuildWithOutputHook(fixtureRoot, 'v2 protocols:', () => {
      renameSync(join(fixtureRoot, 'dist', 'v2'), join(fixtureRoot, 'displaced-v2'));
      symlinkSync(outside, join(fixtureRoot, 'dist', 'v2'), 'dir');
    });

    assert.equal(result.hookRan, true, `race hook did not run\nstdout:\n${result.stdout}`);
    assert.equal(await readFile(victim, 'utf8'), 'outside-leaf-private-canary\n');
    assert.ok(result.code === 1 || await pathExists(join(fixtureRoot, 'dist', 'v2', 'templates', 'victim.txt')));
  });

  await t.test('skills category swap cannot receive subsequent generated files', async (t) => {
    const fixtureRoot = await createBuildFixture(t);
    const initial = await runBuild(fixtureRoot);
    assert.equal(initial.code, 0, initial.stderr);
    for (let index = 0; index < 600; index += 1) {
      await writeFile(
        join(fixtureRoot, 'optional', 'skills', `race-${String(index).padStart(3, '0')}.md`),
        `# Race ${index}\n\nRace skill ${index}.\n`,
      );
    }
    const outside = join(fixtureRoot, 'outside-skills');
    const canary = join(outside, 'private-canary.txt');
    await mkdir(outside, { recursive: true });
    await writeFile(canary, 'outside-skill-private-canary\n');

    const result = await runBuildWithOutputHook(fixtureRoot, 'skill: race-050', () => {
      renameSync(join(fixtureRoot, 'dist', 'skills'), join(fixtureRoot, 'displaced-skills'));
      symlinkSync(outside, join(fixtureRoot, 'dist', 'skills'), 'dir');
    });

    assert.equal(result.hookRan, true, `race hook did not run\nstdout:\n${result.stdout}`);
    assert.deepEqual(await readdir(outside), ['private-canary.txt']);
    assert.equal(await readFile(canary, 'utf8'), 'outside-skill-private-canary\n');
    assert.ok(result.code === 1 || await pathExists(join(fixtureRoot, 'dist', 'skills', 'rivet-race-599', 'SKILL.md')));
  });
});

test('build validates governance sources before mutation and never follows linked or nonregular entries', async (t) => {
  for (const kind of ['symbolic link', 'hard link', 'directory']) {
    await t.test(kind, async (t) => {
      const fixtureRoot = await createBuildFixture(t);
      const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
      const external = join(fixtureRoot, 'governance-canary.md');
      const hostile = join(fixtureRoot, 'optional', 'governance', `hostile-${kind.replace(' ', '-')}.md`);
      await mkdir(dirname(preserved), { recursive: true });
      await writeFile(preserved, 'preserved\n');
      await writeFile(external, 'governance-private-canary\n');
      if (kind === 'symbolic link') await symlink(external, hostile);
      else if (kind === 'hard link') await link(external, hostile);
      else await mkdir(hostile);

      const result = await runBuild(fixtureRoot);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /source.*(?:symbolic link|unsupported entry)|symbolic link|unsupported entry/i);
      assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
      assert.equal(await readFile(external, 'utf8'), 'governance-private-canary\n');
    });
  }
});

test('build rejects a source family reached through a moved and symlinked ancestor before mutation', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
  await mkdir(dirname(preserved), { recursive: true });
  await writeFile(preserved, 'preserved\n');
  const moved = join(fixtureRoot, 'moved-optional');
  await rename(join(fixtureRoot, 'optional'), moved);
  await symlink(moved, join(fixtureRoot, 'optional'), 'dir');

  const result = await runBuild(fixtureRoot);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /source.*symbolic link|symbolic link.*source/i);
  assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
});

test('build snapshots source bytes before its first output mutation', async (t) => {
  const fixtureRoot = await createBuildFixture(t);
  const source = join(fixtureRoot, 'mandatory', 'skills', 'agentic-status.md');
  const replacement = join(fixtureRoot, 'replacement.md');
  const original = await readFile(source, 'utf8');
  await writeFile(replacement, '# Replaced\n\nlate-source-private-canary\n');

  const result = await runBuildAfterOutputMutation(fixtureRoot, source, replacement);
  assert.equal(result.code, 0, `build failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const output = await readFile(join(fixtureRoot, 'dist', 'mandatory', 'agentic-status', 'SKILL.md'), 'utf8');
  assert.match(output, new RegExp(original.split('\n')[0]));
  assert.doesNotMatch(output, /late-source-private-canary/);
});

test('build rejects a cross-file mixed source snapshot before staging and preserves prior dist', async (t) => {
  for (const mode of ['in-place', 'removed', 'replaced']) {
    await t.test(mode, async (t) => {
      const fixtureRoot = await createBuildFixture(t);
      const early = join(fixtureRoot, 'optional', 'skills', 'aaa-snapshot-early.md');
      const trigger = join(fixtureRoot, 'optional', 'skills', 'mmm-snapshot-trigger.md');
      const late = join(fixtureRoot, 'optional', 'skills', 'zzz-snapshot-late.md');
      const preserved = join(fixtureRoot, 'dist', 'preserved.txt');
      const hook = join(fixtureRoot, 'scripts', 'source-snapshot-hook.cjs');
      const hookLoaded = join(fixtureRoot, 'scripts', 'hook-loaded.txt');
      const hookFired = join(fixtureRoot, 'scripts', 'hook-fired.txt');
      await writeFile(early, '# Early A0\n\nearly-a0-public\n');
      await writeFile(trigger, '# Trigger\n\ntask14-cross-file-trigger\n');
      await writeFile(late, '# Late B0\n\nlate-b0-public\n');
      await mkdir(dirname(preserved), { recursive: true });
      await writeFile(preserved, 'prior-dist-preserved\n');
      await writeFile(hook, `
const fs = require('node:fs');
const originalDecode = TextDecoder.prototype.decode;
fs.writeFileSync(process.env.TASK14_HOOK_LOADED, 'loaded\\n');
let fired = false;
TextDecoder.prototype.decode = function task14SnapshotHook(input, ...args) {
  const value = originalDecode.call(this, input, ...args);
  if (!fired && value.includes('task14-cross-file-trigger')) {
    fired = true;
    fs.writeFileSync(process.env.TASK14_HOOK_FIRED, 'fired\\n');
    if (process.env.TASK14_MUTATION === 'in-place') {
      fs.writeFileSync(process.env.TASK14_EARLY_SOURCE, '# Early A1\\n\\nearly-a1-private-canary\\n');
    } else if (process.env.TASK14_MUTATION === 'removed') {
      fs.unlinkSync(process.env.TASK14_EARLY_SOURCE);
    } else {
      fs.renameSync(process.env.TASK14_EARLY_SOURCE, process.env.TASK14_EARLY_SOURCE + '.prior');
      fs.writeFileSync(process.env.TASK14_EARLY_SOURCE, '# Early A1\\n\\nearly-a1-private-canary\\n');
    }
    fs.writeFileSync(process.env.TASK14_LATE_SOURCE, '# Late B1\\n\\nlate-b1-private-canary\\n');
  }
  return value;
};
`);

      const result = await runBuild(fixtureRoot, {
        execArgv: ['--require', hook],
        env: {
          ...process.env,
          TASK14_EARLY_SOURCE: early,
          TASK14_HOOK_FIRED: hookFired,
          TASK14_HOOK_LOADED: hookLoaded,
          TASK14_LATE_SOURCE: late,
          TASK14_MUTATION: mode,
        },
      });

      assert.equal(await readFile(hookLoaded, 'utf8'), 'loaded\n');
      assert.equal(await readFile(hookFired, 'utf8'), 'fired\n');

      if (result.code === 0) {
        const earlyOutput = await readFile(join(fixtureRoot, 'dist', 'skills', 'rivet-aaa-snapshot-early', 'SKILL.md'), 'utf8');
        const lateOutput = await readFile(join(fixtureRoot, 'dist', 'skills', 'rivet-zzz-snapshot-late', 'SKILL.md'), 'utf8');
        assert.match(earlyOutput, /Early A0/);
        assert.doesNotMatch(earlyOutput, /early-a1-private-canary/);
        assert.match(lateOutput, /late-b1-private-canary/);
        assert.fail('build published the mixed A0/B1 source snapshot');
      }
      assert.equal(result.code, 1);
      assert.match(result.stderr, /source.*changed/i);
      assert.doesNotMatch(result.stderr, /early-a1-private-canary|late-b1-private-canary/);
      assert.equal(await readFile(preserved, 'utf8'), 'prior-dist-preserved\n');
    });
  }
});

test('build enforces portable source names and case-folded namespaces before mutation', async (t) => {
  for (const scenario of ['device name', 'extended device name', 'trailing dot', 'unicode name', 'case-folded collision']) {
    await t.test(scenario, async (t) => {
      const fixtureRoot = await createBuildFixture(t);
      const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
      await mkdir(dirname(preserved), { recursive: true });
      await writeFile(preserved, 'preserved\n');
      if (scenario === 'device name') await writeFile(join(fixtureRoot, 'protocols', 'CON.md'), 'unsafe\n');
      else if (scenario === 'extended device name') await writeFile(join(fixtureRoot, 'protocols', 'CONOUT$.md'), 'unsafe\n');
      else if (scenario === 'trailing dot') await writeFile(join(fixtureRoot, 'templates', 'bad.'), 'unsafe\n');
      else if (scenario === 'unicode name') await writeFile(join(fixtureRoot, 'protocols', 'café.md'), 'unsafe\n');
      else {
        await writeFile(join(fixtureRoot, 'optional', 'skills', 'Portable-Name.md'), '# First\n');
        await writeFile(join(fixtureRoot, 'mandatory', 'skills', 'portable-name.md'), '# Second\n');
      }

      const result = await runBuild(fixtureRoot);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /unsafe asset name|name collision/i);
      assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
    });
  }
});

test('build requires every v2 source family before output mutation', async (t) => {
  for (const family of ['protocols', 'schemas', 'templates']) {
    await t.test(family, async (t) => {
      const fixtureRoot = await createBuildFixture(t);
      const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
      await mkdir(dirname(preserved), { recursive: true });
      await writeFile(preserved, 'preserved\n');
      await rm(join(fixtureRoot, family), { recursive: true });

      const result = await runBuild(fixtureRoot);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`required source.*${family}|${family}.*required source`, 'i'));
      assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
    });
  }
});

test('v2 source families remain required with minimal mutable package metadata', async (t) => {
  for (const family of ['protocols', 'schemas', 'templates']) {
    await t.test(family, async (t) => {
      const fixtureRoot = await createBuildFixture(t);
      const preserved = join(fixtureRoot, 'dist', 'skills', 'rivet-preserved', 'SKILL.md');
      await mkdir(dirname(preserved), { recursive: true });
      await writeFile(preserved, 'preserved\n');
      await writeFile(join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
      await rm(join(fixtureRoot, family), { recursive: true });

      const result = await runBuild(fixtureRoot);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`required source.*${family}|${family}.*required source`, 'i'));
      assert.equal(await readFile(preserved, 'utf8'), 'preserved\n');
    });
  }
});

test('npm package contains each required source and distribution asset once without tests or private data', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'rivet-v2-pack-cache-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rivet-v2-pack-'));
  try {
    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'rivet-v2-pack-fixture',
      version: '1.0.0',
      type: 'module',
      files: ['dist/', 'schemas/', 'protocols/', 'templates/'],
    }) + '\n');
    await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
    await cp(join(REPOSITORY_ROOT, 'scripts', 'build.js'), join(fixtureRoot, 'scripts', 'build.js'));
    for (const directory of ['mandatory', 'optional', 'protocols', 'schemas', 'templates']) {
      await cp(join(REPOSITORY_ROOT, directory), join(fixtureRoot, directory), { recursive: true });
    }
    const build = await runBuild(fixtureRoot);
    assert.equal(build.code, 0, `build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);

    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = await spawnProcess(executable, ['pack', '--dry-run', '--json', '--cache', cache], {
      cwd: fixtureRoot,
      timeoutMs: 30_000,
    });
    assert.equal(packed.code, 0, `npm pack failed\nstdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`);
    const metadata = JSON.parse(packed.stdout);
    const names = metadata[0].files.map(file => file.path);
    const counts = new Map(names.map(name => [name, names.filter(candidate => candidate === name).length]));
    const schemaFiles = await listFiles(join(fixtureRoot, 'schemas'));
    const templateFiles = await listFiles(join(fixtureRoot, 'templates'));

    const required = [
      ...PROTOCOLS.flatMap(name => [`protocols/${name}`, `dist/v2/protocols/${name}`]),
      ...schemaFiles.flatMap(name => [`schemas/${name}`, `dist/v2/schemas/${name}`]),
      ...templateFiles.flatMap(name => [`templates/${name}`, `dist/v2/templates/${name}`]),
      ...MANDATORY_SKILLS.map(name => `dist/mandatory/${name.slice(0, -3)}/SKILL.md`),
      ...ROLE_PROMPTS.map(name => `dist/agents/${name.slice(0, -3)}/SKILL.md`),
    ];
    for (const name of required) assert.equal(counts.get(name), 1, `${name} must be packaged exactly once`);
    for (const name of names) {
      assert.doesNotMatch(name, /(?:^|\/)test(?:\/|$)|test\/fixtures|\.env(?:\.|$)|credential|secret/i);
    }
  } finally {
    await rm(cache, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('tracked clean-checkout package contains generated v2 assets without running build first', async (t) => {
  const listed = await spawnProcess('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT });
  assert.equal(listed.code, 0, listed.stderr);
  const tracked = listed.stdout.split('\0').filter(Boolean);
  const schemaFiles = await listFiles(join(REPOSITORY_ROOT, 'schemas'));
  const templateFiles = await listFiles(join(REPOSITORY_ROOT, 'templates'));
  const requiredTracked = [
    ...PROTOCOLS.flatMap(name => [`protocols/${name}`, `dist/v2/protocols/${name}`]),
    ...MANDATORY_SKILLS.map(name => `dist/mandatory/${name.slice(0, -3)}/SKILL.md`),
    ...ROLE_PROMPTS.map(name => `dist/agents/${name.slice(0, -3)}/SKILL.md`),
    ...schemaFiles.flatMap(name => [`schemas/${name}`, `dist/v2/schemas/${name}`]),
    ...templateFiles.flatMap(name => [`templates/${name}`, `dist/v2/templates/${name}`]),
  ];
  for (const path of requiredTracked) assert.ok(tracked.includes(path), `${path} must be tracked for a clean package`);

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rivet-v2-clean-pack-'));
  const cache = await mkdtemp(join(tmpdir(), 'rivet-v2-clean-pack-cache-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const packagePath = path => path === 'README.md' || path === 'package.json'
    || ['bin/', 'dist/', 'src/', 'schemas/', 'protocols/', 'templates/'].some(prefix => path.startsWith(prefix));
  for (const path of tracked.filter(packagePath)) {
    const destination = join(fixtureRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(REPOSITORY_ROOT, path), destination);
  }

  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = await spawnProcess(executable, ['pack', '--dry-run', '--json', '--cache', cache], {
    cwd: fixtureRoot,
    timeoutMs: 30_000,
  });
  assert.equal(packed.code, 0, `clean npm pack failed\nstdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`);
  const names = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  for (const path of requiredTracked) assert.equal(names.filter(candidate => candidate === path).length, 1, `${path} must be packaged once`);
  assert.equal(names.some(path => path.startsWith('test/')), false);
});

test('v2 mandatory skills and optional roles retain both Claude and Codex install behavior', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rivet-v2-install-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(join(projectRoot, 'package.json'), '{"private":true}\n');
  const fixtureRoot = await createBuildFixture(t);

  const build = await runBuild(fixtureRoot);
  assert.equal(build.code, 0, `build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
  const installed = await main(['install', '--all', '--target=both'], {
    cwd: () => projectRoot,
    packageRoot: fixtureRoot,
    fetch: async () => ({ ok: false }),
    output: { log() {}, error() {}, json() {} },
  });
  assert.equal(installed, 0);

  for (const target of ['.claude', '.codex']) {
    assert.equal(await pathExists(join(projectRoot, target, 'skills', 'rivet-agentic-goal', 'SKILL.md')), true);
    assert.equal(await pathExists(join(projectRoot, target, 'skills', 'rivet-agentic-status', 'SKILL.md')), true);
    assert.equal(await pathExists(join(projectRoot, target, 'skills', 'rivet-feature-workflow', 'SKILL.md')), true);
    assert.equal(await pathExists(join(projectRoot, target, 'skills', 'rivet-boss-agent', 'SKILL.md')), true);
    assert.equal(await pathExists(join(projectRoot, target, 'skills', 'rivet-bounded-worker', 'SKILL.md')), true);
  }
});
