import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cp, lstat, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadProjectConfig } from '../../src/config/load.js';
import { DEFAULT_CONFIG, CONFIG_FILES, MAX_CONFIG_FILE_BYTES } from '../../src/config/defaults.js';
import {
  ConfigurationError,
  validateProjectConfiguration,
  validateEvent,
  validateEvidence,
  validateGoalGraph,
} from '../../src/config/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => join(here, '..', 'fixtures', 'config', name);

async function temporaryProject() {
  const root = await mkdtemp(join(tmpdir(), 'agilno-config-'));
  await cp(join(fixture('valid'), '.rivet'), join(root, '.rivet'), { recursive: true });
  return root;
}

async function editConfig(root, filename, edit) {
  const path = join(root, '.rivet', filename);
  const source = await readFile(path, 'utf8');
  await writeFile(path, edit(source), 'utf8');
}

async function rejectsMutation(filename, edit) {
  const root = await temporaryProject();
  await editConfig(root, filename, edit);
  await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
}

function withChangedIdentity(metadata) {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === 'ino') return typeof target.ino === 'bigint' ? target.ino + 1n : target.ino + 1;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function validGraph() {
  return {
    schemaVersion: 1,
    id: 'graph-demo',
    goal: 'Deliver a verified conference planner change',
    providerRefs: ['jira-main', 'git-ci-main'],
    maxDelegationDepth: 3,
    status: 'approved',
    nodes: [
      {
        id: 'boss-plan',
        objective: 'Own the approved delivery goal',
        owner: { role: 'boss', id: 'portfolio-boss' },
        dependencies: [],
        authorityScopes: ['plan', 'implement', 'delegate', 'verify'],
        budget: { timeMinutes: 120, tokenLimit: 10000, costUsd: 10, taskLimit: 10 },
        completionProfile: 'delivery',
        requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'],
        evidenceRefs: ['evidence-approval'],
        status: 'completed',
      },
      {
        id: 'manager-plan',
        parentId: 'boss-plan',
        objective: 'Coordinate implementation',
        owner: { role: 'manager', id: 'engineering-manager' },
        dependencies: ['boss-plan'],
        authorityScopes: ['implement', 'delegate'],
        budget: { timeMinutes: 90, tokenLimit: 8000, costUsd: 8, taskLimit: 8 },
        completionProfile: 'engineering',
        requiredEvidenceTypes: ['commit', 'test'],
        evidenceRefs: ['evidence-review'],
        status: 'completed',
      },
      {
        id: 'worker-code',
        parentId: 'manager-plan',
        objective: 'Implement the bounded change',
        owner: { role: 'worker', id: 'implementation-worker' },
        dependencies: ['manager-plan'],
        authorityScopes: ['implement'],
        budget: { timeMinutes: 60, tokenLimit: 5000, costUsd: 5, taskLimit: 3 },
        completionProfile: 'engineering',
        requiredEvidenceTypes: ['commit', 'test'],
        evidenceRefs: ['evidence-test'],
        status: 'verifying',
      },
      {
        id: 'human-final',
        parentId: 'boss-plan',
        objective: 'Approve final delivery',
        owner: { role: 'boss', id: 'portfolio-boss' },
        dependencies: ['worker-code'],
        authorityScopes: ['verify'],
        budget: { timeMinutes: 30, tokenLimit: 1000, costUsd: 1, taskLimit: 1 },
        completionProfile: 'delivery',
        requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'],
        evidenceRefs: ['evidence-approval'],
        status: 'ready',
        approvalGate: 'final-delivery',
      },
    ],
  };
}

function validEvent() {
  return {
    schemaVersion: 1,
    eventId: 'event-001',
    graphId: 'graph-demo',
    nodeId: 'worker-code',
    sequence: 1,
    timestamp: '2026-08-13T12:00:00.000Z',
    actor: { role: 'worker', id: 'implementation-worker' },
    type: 'state-transition',
    priorState: 'running',
    newState: 'verifying',
  };
}

function validEvidence() {
  return {
    schemaVersion: 1,
    id: 'bundle-demo',
    graphId: 'graph-demo',
    approvalState: 'pending',
    publicationState: 'draft',
    items: [
      {
        id: 'evidence-test',
        type: 'test',
        requirementRefs: ['AC-1'],
        source: { commit: '0123456789abcdef0123456789abcdef01234567' },
        producer: { role: 'worker', id: 'implementation-worker' },
        timestamp: '2026-08-13T12:00:00.000Z',
        classification: 'internal-redacted',
        approvalState: 'pending',
        details: { command: 'test', status: 'passed' },
      },
    ],
  };
}

async function mutableValidConfig() {
  return structuredClone(await loadProjectConfig(fixture('valid')));
}

function humanApprovalEvidence({
  bundleState = 'approved',
  itemState = 'approved',
  decision = 'approved',
  producerRole = 'human',
  producerId = 'human-owner',
  actorId = 'human-owner',
  classification = 'internal-redacted',
} = {}) {
  return {
    schemaVersion: 1,
    id: 'bundle-approval',
    graphId: 'graph-demo',
    approvalState: bundleState,
    publicationState: bundleState === 'approved' ? 'approved' : bundleState === 'rejected' ? 'rejected' : 'draft',
    items: [
      {
        id: 'evidence-approval',
        type: 'human-approval',
        requirementRefs: ['AC-1'],
        source: { commit: '0123456789abcdef0123456789abcdef01234567' },
        producer: { role: producerRole, id: producerId },
        timestamp: '2026-08-13T12:00:00.000Z',
        classification,
        approvalState: itemState,
        approval: { actorId, decision },
      },
    ],
  };
}

test('RED group 1: rejects cross-platform unsafe tracked and evidence paths', async t => {
  for (const candidate of ['..\\private', 'C:\\private', '\\\\server\\share', '.', 'file:relative', 'config/file:stream']) {
    await t.test(`project path ${JSON.stringify(candidate)}`, async () => {
      const root = await temporaryProject();
      await editConfig(root, 'project.yaml', source => source.replace('    - .env', `    - '${candidate}'`));
      await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
    });
    await t.test(`provider ref ${JSON.stringify(candidate)}`, async () => {
      const root = await temporaryProject();
      await editConfig(root, 'providers.yaml', source => source.replace('resourceIds: [AGILNO]', `resourceIds: ['${candidate}']`));
      await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
    });
    await t.test(`evidence location ${JSON.stringify(candidate)}`, () => {
      const evidence = validEvidence();
      evidence.items[0] = {
        ...evidence.items[0],
        type: 'screenshot',
        location: candidate,
        checksum: `sha256:${'0'.repeat(64)}`,
      };
      delete evidence.items[0].details;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    });
  }
});

test('RED group 2: accepts only bounded non-shell command argv', async t => {
  await t.test('free-form command string', async () => {
    const root = await temporaryProject();
    await editConfig(root, 'project.yaml', source => source.replace('  build: [npm, run, build]', '  build: "npm run build"'));
    await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
  });
  for (const command of [
    '[sh, -c, echo]',
    '[bash, -c, echo]',
    '[zsh, -c, echo]',
    '[cmd, /c, echo]',
    '[powershell, -Command, echo]',
    '[pwsh, -c, echo]',
    '[dash, -c, echo]',
    '[mksh, -c, echo]',
    '[yash, -c, echo]',
    '[nu, -c, echo]',
    '[elvish, -c, echo]',
    '[env, sh, -c, echo]',
  ]) {
    await t.test(`shell ${command}`, async () => {
      const root = await temporaryProject();
      await editConfig(root, 'project.yaml', source => source.replace('[npm, run, build]', command));
      await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
    });
  }
  await t.test('shell control token', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[npm, run, build, "&&"]')));
  await t.test('environment expansion token', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[npm, run, build, "$INERT_VALUE"]')));
  await t.test('Windows environment expansion token', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[npm, run, build, "%INERT_VALUE%"]')));
  await t.test('special shell expansion token', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[npm, run, build, "$@"]')));
  await t.test('unsafe executable path', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[../bin/build]')));
  await t.test('ambiguous executable whitespace', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '["npm tool", run, build]')));
  await t.test('absolute path argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', '[npm, run, build, "--output=/tmp/inert"]')));
  await t.test('colon-delimited Windows path argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', "[npm, run, build, '--output:C:\\inert']")));
  await t.test('colon-delimited parent path argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', "[npm, run, build, '--output:..\\inert']")));
  await t.test('colon-delimited drive-relative argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', "[npm, run, build, '--output:C:inert']")));
  await t.test('equals-delimited parent path argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', "[npm, run, build, '--output=..\\inert']")));
  await t.test('equals-delimited drive-relative argument', () => rejectsMutation('project.yaml', source => source.replace('[npm, run, build]', "[npm, run, build, '--output=C:inert']")));
});

test('RED correction: constrains package-manager runner grammar', async t => {
  for (const command of [
    '[npm, exec, inert-tool]',
    '[npm, x, inert-tool]',
    '[pnpm, exec, inert-tool]',
    '[pnpm, dlx, inert-tool]',
    '[yarn, dlx, inert-tool]',
    '[bun, x, inert-tool]',
    '[npx, inert-tool]',
    '[bunx, inert-tool]',
    '[npm, run, build, inert-tool]',
    '[npm, exec, sh]',
    '[npm, run, bash]',
    '[npm, run, bash.exe]',
    '[npm, run, python]',
    '[npm, run, python3.12]',
    '[npm, run, node.exe]',
    '[npm, run, ruby3.2]',
    '[npm, run, php8.3]',
    '[npm, run, perl5.40]',
    '[npm, run, java21]',
    '[npm, run, bash.cmd]',
    '[npm, run, pwsh.com]',
  ]) {
    await t.test(command, () => rejectsMutation(
      'project.yaml',
      source => source.replace('[npm, run, build]', command),
    ));
  }
});

test('RED correction: rejects compact option payloads', async t => {
  for (const command of [
    "['npm', 'run', '-o/tmp/inert']",
    "['npm', 'run', '-o../inert']",
    "['npm', 'run', '--output=name:stream']",
    "['npm', 'run', '--output=file:relative']",
    "['npm', 'run', 'build..inert']",
    "['npm', 'run', 'C:\\inert']",
    "['npm', 'run', '\\\\server\\share']",
  ]) {
    await t.test(command, () => rejectsMutation(
      'project.yaml',
      source => source.replace('[npm, run, build]', command),
    ));
  }
});

test('RED structural correction: binds scripts to command registry keys', async t => {
  for (const [commandKey, mismatchedScript] of [
    ['build', 'compile'],
    ['test', 'verify'],
    ['lint', 'style'],
    ['typecheck', 'types'],
    ['dev', 'serve'],
  ]) {
    await t.test(`${commandKey} cannot run ${mismatchedScript}`, () => rejectsMutation(
      'project.yaml',
      source => source.replace(
        `[npm, run, ${commandKey}]`,
        `[npm, run, ${mismatchedScript}]`,
      ),
    ));
  }
});

test('RED hardening 1: enforces authority ceilings and Boss-rooted final gates', async t => {
  for (const permission of ['externalWrites', 'merge', 'deploy']) {
    await t.test(`Worker permission ${permission}`, async () => {
      const config = await mutableValidConfig();
      config.orchestration.roles.find(role => role.kind === 'worker').permissions[permission] = true;
      assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
    });
  }
  for (const scope of ['public-write', 'approve-gate', 'change-authority', 'change-budget']) {
    await t.test(`Worker authority ${scope}`, async () => {
      const config = await mutableValidConfig();
      config.orchestration.roles.find(role => role.kind === 'worker').authorityScopes.push(scope);
      assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
    });
  }
  for (const scope of ['deploy', 'public-write', 'approve-gate', 'change-authority', 'change-budget']) {
    await t.test(`Manager authority ${scope}`, async () => {
      const config = await mutableValidConfig();
      config.orchestration.roles.find(role => role.kind === 'manager').authorityScopes.push(scope);
      assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
    });
  }
  for (const scope of ['public-write', 'approve-gate']) {
    await t.test(`Boss authority ${scope}`, async () => {
      const config = await mutableValidConfig();
      config.orchestration.roles.find(role => role.kind === 'boss').authorityScopes.push(scope);
      assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
    });
  }
  const config = await mutableValidConfig();
  config.orchestration.approvalGates.push('publication');
  await t.test('Manager-root graph', () => {
    const graph = validGraph();
    graph.nodes = [{ ...graph.nodes[1], parentId: undefined, dependencies: [], approvalGate: 'activation' }];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('Worker-root graph', () => {
    const graph = validGraph();
    graph.nodes = [{ ...graph.nodes[2], parentId: undefined, dependencies: [], approvalGate: 'activation' }];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('rootless Manager', () => {
    const graph = validGraph();
    delete graph.nodes[1].parentId;
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('rootless Worker', () => {
    const graph = validGraph();
    delete graph.nodes[2].parentId;
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  for (const [role, roleId, profile] of [
    ['manager', 'engineering-manager', 'engineering'],
    ['worker', 'implementation-worker', 'engineering'],
  ]) {
    await t.test(`${role} cannot own final delivery`, () => {
      const graph = validGraph();
      const finalNode = graph.nodes[3];
      finalNode.owner = { role, id: roleId };
      finalNode.authorityScopes = ['verify'];
      finalNode.completionProfile = profile;
      finalNode.requiredEvidenceTypes = ['commit', 'test'];
      assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
    });
  }
  await t.test('Worker cannot own publication approval', () => {
    const graph = validGraph();
    const finalNode = graph.nodes[3];
    finalNode.owner = { role: 'worker', id: 'implementation-worker' };
    finalNode.authorityScopes = ['verify'];
    finalNode.completionProfile = 'engineering';
    finalNode.requiredEvidenceTypes = ['commit', 'test'];
    finalNode.approvalGate = 'publication';
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('Boss final gate cannot bypass a Worker parent', () => {
    const graph = validGraph();
    const finalNode = graph.nodes[3];
    finalNode.parentId = 'worker-code';
    finalNode.authorityScopes = ['implement'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('Worker cannot own an approval gate', () => {
    const graph = validGraph();
    graph.nodes[2].approvalGate = 'activation';
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('RED hardening 2: binds bounded reads to verified directory and file identities', async t => {
  await t.test('directory identity changes before relative open', async () => {
    const root = await temporaryProject();
    await assert.rejects(
      () => loadProjectConfig(root, {
        fs: {
          statSync(path) {
            const metadata = nodeFs.statSync(path);
            return path === '.' ? withChangedIdentity(metadata) : metadata;
          },
        },
      }),
      ConfigurationError,
    );
  });
  await t.test('file identity changes between lstat and open', async () => {
    const root = await temporaryProject();
    await assert.rejects(
      () => loadProjectConfig(root, {
        fs: { fstatSync: descriptor => withChangedIdentity(nodeFs.fstatSync(descriptor)) },
      }),
      ConfigurationError,
    );
  });
  await t.test('opened file grows beyond the read limit', async () => {
    const root = await temporaryProject();
    await assert.rejects(
      () => loadProjectConfig(root, {
        fs: {
          readSync(_descriptor, buffer, offset, length) {
            buffer.fill(0x20, offset, offset + length);
            return Math.min(length, MAX_CONFIG_FILE_BYTES + 1);
          },
        },
      }),
      ConfigurationError,
    );
  });
  await t.test('unexpected tracked YAML is rejected', async () => {
    const root = await temporaryProject();
    await writeFile(join(root, '.rivet', 'unexpected.yaml'), 'schemaVersion: 1\n', 'utf8');
    await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
  });
});

test('RED hardening 3: uses one canonical internal ID and separate external refs', async t => {
  const canonicalId = {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  };
  for (const filename of Object.values({
    project: 'project.schema.json',
    providers: 'providers.schema.json',
    orchestration: 'orchestration.schema.json',
    quality: 'quality.schema.json',
    goalGraph: 'goal-graph.schema.json',
    event: 'event.schema.json',
    evidence: 'evidence.schema.json',
  })) {
    await t.test(filename, async () => {
      const schema = JSON.parse(await readFile(join(here, '..', '..', 'schemas', filename), 'utf8'));
      assert.deepEqual(schema.$defs.id, canonicalId);
    });
  }
  await t.test('evidence bundle and item IDs are internal IDs', () => {
    for (const mutation of [
      evidence => { evidence.id = 'Bundle_Demo'; },
      evidence => { evidence.items[0].id = 'Evidence_Test'; },
    ]) {
      const evidence = validEvidence();
      mutation(evidence);
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    }
  });
  await t.test('event actors use the external reference grammar', () => {
    const event = validEvent();
    event.actor = { role: 'human', id: 'Human.Owner_1' };
    assert.equal(validateEvent(event), true);
  });
  await t.test('overlong graph/event internal IDs are rejected consistently', () => {
    const event = validEvent();
    event.eventId = `e${'a'.repeat(64)}`;
    assert.throws(() => validateEvent(event), ConfigurationError);
  });
  await t.test('requirement references remain external references', () => {
    const evidence = validEvidence();
    evidence.items[0].requirementRefs = ['AC_1'];
    assert.equal(validateEvidence(evidence), true);
  });
});

test('RED hardening 4: rejects secret-shaped URL path components without value leakage', async t => {
  for (const pathname of [
    '/api/sk-inert-placeholder',
    '/api/%73%6b%2Dinert-placeholder',
    '/api/%2Fsk-inert-placeholder',
    '/api/%5Csk-inert-placeholder',
    '/api/%252Fsk-inert-placeholder',
    '/api/%2525252573%252525256b%252525252Dinert-placeholder',
    '/api/%2525252541',
    '/api/token=sk-inert-placeholder',
    '/api/%ZZ',
  ]) {
    await t.test(pathname, async () => {
      const root = await temporaryProject();
      await editConfig(root, 'providers.yaml', source => source.replace(
        '    capabilities: [issues-read, issues-write]',
        `    capabilities: [issues-read, issues-write]\n    endpoint: https://example.invalid${pathname}`,
      ));
      await assert.rejects(
        () => loadProjectConfig(root),
        error => {
          assert.equal(error instanceof ConfigurationError, true);
          assert.doesNotMatch(error.message, /inert-placeholder|%73|%ZZ/i);
          return true;
        },
      );
    });
  }
});

test('RED hardening 5: rejects Windows-ambiguous local path components', async t => {
  for (const candidate of [
    'CON', 'con.txt', 'CONIN$', 'conout$.txt', 'PrN', 'aux.json', 'NUL',
    'com1.log', 'COM¹.log', 'lpt².txt', 'LPT³', 'LPT9',
    'folder/CON.txt', 'folder/name.', 'folder/name ',
  ]) {
    await t.test(`project ${JSON.stringify(candidate)}`, () => rejectsMutation(
      'project.yaml',
      source => source.replace('    - .env', `    - '${candidate}'`),
    ));
    await t.test(`provider ${JSON.stringify(candidate)}`, () => rejectsMutation(
      'providers.yaml',
      source => source.replace('resourceIds: [AGILNO]', `resourceIds: ['${candidate}']`),
    ));
    await t.test(`evidence location ${JSON.stringify(candidate)}`, () => {
      const evidence = validEvidence();
      evidence.items[0] = {
        ...evidence.items[0],
        type: 'screenshot',
        location: candidate,
        checksum: `sha256:${'0'.repeat(64)}`,
      };
      delete evidence.items[0].details;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    });
    await t.test(`evidence source ${JSON.stringify(candidate)}`, () => {
      const evidence = validEvidence();
      evidence.items[0].source.resourceId = candidate;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    });
  }
});

test('RED group 3: tracked configuration cannot activate orchestration', async () => {
  const root = await temporaryProject();
  await editConfig(root, 'orchestration.yaml', source => source.replace('enabled: false', 'enabled: true'));
  await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
});

test('RED group 4: binds final human approval to exactly one Boss profile', async t => {
  await t.test('duplicate Boss role', async () => {
    const config = await mutableValidConfig();
    config.orchestration.roles.push({ ...structuredClone(config.orchestration.roles[0]), id: 'portfolio-boss-two' });
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('unused human profile cannot satisfy Boss approval', async () => {
    const config = await mutableValidConfig();
    const delivery = config.orchestration.completionProfiles.find(profile => profile.id === 'delivery');
    delivery.requiredApprovals = ['manager'];
    delivery.requiredEvidence = ['commit', 'test', 'review'];
    config.orchestration.completionProfiles.push({
      id: 'unused-human',
      requiredEvidence: ['human-approval'],
      requiredApprovals: ['human'],
    });
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
});

test('RED group 5: enforces connected delegation authority and budgets', async t => {
  await t.test('non-delegating parent', async () => {
    const config = await mutableValidConfig();
    config.orchestration.roles.find(role => role.id === 'engineering-manager').canDelegate = false;
    assert.throws(() => validateGoalGraph(validGraph(), config), ConfigurationError);
  });
  await t.test('disallowed child owner role', async () => {
    const config = await mutableValidConfig();
    const graph = validGraph();
    graph.nodes[3].parentId = 'manager-plan';
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('Worker cannot parent another node', async () => {
    const config = await mutableValidConfig();
    const graph = validGraph();
    graph.nodes[3].parentId = 'worker-code';
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('child authority exceeds parent node', async () => {
    const config = await mutableValidConfig();
    config.orchestration.roles.find(role => role.id === 'implementation-worker').authorityScopes.push('verify');
    const graph = validGraph();
    graph.nodes[2].authorityScopes.push('verify');
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('child budget exceeds parent node', async () => {
    const config = await mutableValidConfig();
    const graph = validGraph();
    graph.nodes[2].budget.timeMinutes = 91;
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('RED group 6: connects quality providers, profiles, and canonical evidence types', async t => {
  await t.test('accepts explicit valid quality references and graph evidence types', async () => {
    const config = await mutableValidConfig();
    config.quality.providerRefs = ['figma-main', 'git-ci-main'];
    config.quality.completionProfileRefs = ['engineering', 'delivery'];
    assert.equal(validateProjectConfiguration(config), true);
    const graph = validGraph();
    assert.equal(validateGoalGraph(graph, config), true);
  });
  await t.test('unsupported quality evidence type', async () => {
    const config = await mutableValidConfig();
    config.quality.evidence.requiredTypes.push('unsupported-evidence');
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('unsupported completion evidence type', async () => {
    const config = await mutableValidConfig();
    config.orchestration.completionProfiles[0].requiredEvidence.push('unsupported-evidence');
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('role profile evidence missing from quality', async () => {
    const config = await mutableValidConfig();
    config.orchestration.completionProfiles.find(profile => profile.id === 'engineering').requiredEvidence.push('external-update');
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('unknown quality provider reference', async () => {
    const config = await mutableValidConfig();
    config.quality.providerRefs.push('missing-provider');
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('role-used profile omitted from quality', async () => {
    const config = await mutableValidConfig();
    config.quality.completionProfileRefs = ['delivery'];
    assert.throws(() => validateProjectConfiguration(config), ConfigurationError);
  });
  await t.test('unsupported goal evidence type', async () => {
    const config = await mutableValidConfig();
    const graph = validGraph();
    graph.nodes[2].requiredEvidenceTypes.push('unsupported-evidence');
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('goal evidence weaker than completion profile', async () => {
    const config = await mutableValidConfig();
    const graph = validGraph();
    graph.nodes[2].requiredEvidenceTypes = ['commit'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('RED group 7: keeps evidence approval and publication state consistent', async t => {
  await t.test('pending bundle models draft publication explicitly', () => {
    const evidence = { ...validEvidence(), publicationState: 'draft' };
    assert.equal(validateEvidence(evidence), true);
  });
  await t.test('approved bundle requires approved items and a human decision', () => {
    const evidence = validEvidence();
    evidence.approvalState = 'approved';
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
  await t.test('rejected human decision contradicts approved bundle', () => {
    assert.throws(
      () => validateEvidence(humanApprovalEvidence({ itemState: 'rejected', decision: 'rejected' })),
      ConfigurationError,
    );
  });
  await t.test('approved human decision requires matching human producer', () => {
    assert.throws(
      () => validateEvidence(humanApprovalEvidence({ producerRole: 'manager', producerId: 'manager-one' })),
      ConfigurationError,
    );
  });
  await t.test('approved human decision requires matching actor', () => {
    assert.throws(
      () => validateEvidence(humanApprovalEvidence({ actorId: 'different-human' })),
      ConfigurationError,
    );
  });
  await t.test('approved human decision requires its evidence timestamp', () => {
    const evidence = humanApprovalEvidence();
    delete evidence.items[0].timestamp;
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
  await t.test('approved human decision forms a consistent final bundle', () => {
    assert.equal(validateEvidence(humanApprovalEvidence()), true);
  });
  await t.test('rejected human decision forms a consistent rejected bundle', () => {
    assert.equal(
      validateEvidence(humanApprovalEvidence({ bundleState: 'rejected', itemState: 'rejected', decision: 'rejected' })),
      true,
    );
  });
  await t.test('public evidence cannot remain pending', () => {
    const evidence = validEvidence();
    evidence.items[0].classification = 'public';
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
  await t.test('rejected publication requires explicit human rejection evidence', () => {
    const evidence = validEvidence();
    evidence.approvalState = 'rejected';
    evidence.publicationState = 'rejected';
    evidence.items[0].approvalState = 'rejected';
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
  await t.test('rejects control and non-HTTP URI evidence locations', () => {
    for (const location of ['file:/private/tmp/inert', 'reports/inert\nname', 'reports/inert\u0000name']) {
      const evidence = validEvidence();
      evidence.items[0] = {
        ...evidence.items[0],
        type: 'screenshot',
        location,
        checksum: `sha256:${'0'.repeat(64)}`,
      };
      delete evidence.items[0].details;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    }
  });
  await t.test('rejects unsafe evidence source resource paths', () => {
    for (const resourceId of ['../private', '..\\private', 'C:\\private', '\\\\server\\share', 'file:relative', 'file:C:\\private', 'ssh:opaque-reference']) {
      const evidence = validEvidence();
      evidence.items[0].source.resourceId = resourceId;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    }
  });
});

test('loads a valid tracked project configuration', async () => {
  const config = await loadProjectConfig(fixture('valid'));

  assert.equal(config.project.id, 'conference-planner');
  assert.equal(config.orchestration.enabled, false);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.project.commands.build));
});

test('applies immutable fail-closed defaults', async () => {
  const root = await temporaryProject();
  await editConfig(root, 'orchestration.yaml', source => source.replace('enabled: false\n', ''));

  const config = await loadProjectConfig(root);
  assert.equal(config.orchestration.enabled, false);
  assert.equal(DEFAULT_CONFIG.orchestration.enabled, false);
  assert.equal(DEFAULT_CONFIG.externalWrites.requireHumanApproval, true);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.throws(() => { DEFAULT_CONFIG.orchestration.enabled = true; }, TypeError);
});

test('rejects credential values in tracked provider config without exposing them', async () => {
  const controlledPlaceholder = 'placeholder-credential-value-do-not-use';

  await assert.rejects(
    () => loadProjectConfig(fixture('invalid')),
    error => {
      assert.match(error.message, /configuration is invalid/i);
      assert.doesNotMatch(error.message, new RegExp(controlledPlaceholder));
      return true;
    },
  );
});

test('requires exactly all four tracked configuration files', async t => {
  for (const filename of Object.values(CONFIG_FILES)) {
    await t.test(filename, async () => {
      const root = await temporaryProject();
      await unlink(join(root, '.rivet', filename));
      await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
    });
  }
});

test('rejects unknown keys at top and nested object boundaries', async t => {
  await t.test('top level', () => rejectsMutation('project.yaml', source => `${source}unknown: true\n`));
  await t.test('nested', () => rejectsMutation('project.yaml', source => source.replace('  framework: nextjs\n', '  framework: nextjs\n  unknown: true\n')));
});

test('requires build and test commands', async t => {
  await t.test('build', () => rejectsMutation('project.yaml', source => source.replace('  build: [npm, run, build]\n', '')));
  await t.test('test', () => rejectsMutation('project.yaml', source => source.replace('  test: [npm, run, test]\n', '')));
});

test('rejects shell expansion in safe command strings', async () => {
  await rejectsMutation('project.yaml', source => source.replace('  build: [npm, run, build]', '  build: "npm $(inert-placeholder)"'));
});

test('rejects secret-like provider keys and values', async t => {
  await t.test('password key', () => rejectsMutation('providers.yaml', source => source.replace('      apiTokenEnv: ATLASSIAN_API_TOKEN', '      password: inert-placeholder')));
  await t.test('value-shaped environment reference', () => rejectsMutation('providers.yaml', source => source.replace('ATLASSIAN_API_TOKEN', 'placeholder-value-do-not-use')));
});

test('rejects invalid credential environment references and credential files', async t => {
  await t.test('lowercase env ref', () => rejectsMutation('providers.yaml', source => source.replace('FIGMA_ACCESS_TOKEN', 'figma_token')));
  await t.test('credential file', () => rejectsMutation('providers.yaml', source => source.replace('      accessTokenEnv: FIGMA_ACCESS_TOKEN', '      credentialFile: ./credentials.json')));
  await t.test('absolute credential path', () => rejectsMutation('providers.yaml', source => source.replace('      accessTokenEnv: FIGMA_ACCESS_TOKEN', '      credentialFile: /tmp/inert.json')));
});

test('rejects unsafe sensitive paths', async t => {
  await t.test('absolute', () => rejectsMutation('project.yaml', source => source.replace('    - .env', '    - /etc/passwd')));
  await t.test('parent escaping', () => rejectsMutation('project.yaml', source => source.replace('    - .env', '    - ../private')));
});

test('rejects URLs with embedded user information', async () => {
  await rejectsMutation('providers.yaml', source => source.replace('    capabilities: [issues-read, issues-write]', '    capabilities: [issues-read, issues-write]\n    endpoint: https://user:placeholder@example.invalid/api'));
});

test('rejects embedded URL user information outside endpoint fields', async () => {
  await rejectsMutation('providers.yaml', source => source.replace('resourceIds: [AGILNO]', 'resourceIds: [https://user:placeholder@example.invalid/resource]'));
});

test('rejects secret-bearing provider URL query and fragment metadata without exposing values', async t => {
  await t.test('query', async () => {
    const root = await temporaryProject();
    await editConfig(root, 'providers.yaml', source => source.replace('    capabilities: [issues-read, issues-write]', '    capabilities: [issues-read, issues-write]\n    endpoint: https://example.invalid/api?api_token=controlled-inert-value'));
    await assert.rejects(
      () => loadProjectConfig(root),
      error => {
        assert.doesNotMatch(error.message, /controlled-inert-value/);
        return error instanceof ConfigurationError;
      },
    );
  });
  await t.test('fragment', () => rejectsMutation('providers.yaml', source => source.replace('    capabilities: [issues-read, issues-write]', '    capabilities: [issues-read, issues-write]\n    endpoint: https://example.invalid/api#credential-metadata')));
});

test('rejects invalid capacities, budgets, and delegation depths', async t => {
  await t.test('zero capacity', () => rejectsMutation('orchestration.yaml', source => source.replace('    capacity: 4', '    capacity: 0')));
  await t.test('negative budget', () => rejectsMutation('orchestration.yaml', source => source.replace('      timeMinutes: 240', '      timeMinutes: -1')));
  await t.test('zero budget', () => rejectsMutation('orchestration.yaml', source => source.replace('      tokenLimit: 250000', '      tokenLimit: 0')));
  await t.test('excessive budget', () => rejectsMutation('orchestration.yaml', source => source.replace('      taskLimit: 40', '      taskLimit: 1000000')));
  await t.test('unbounded delegation', () => rejectsMutation('orchestration.yaml', source => source.replace('maxDelegationDepth: 3', 'maxDelegationDepth: 999')));
});

test('requires unique Boss, Manager, and Worker roles', async t => {
  await t.test('missing worker', () => rejectsMutation('orchestration.yaml', source => source.replace(/  - id: implementation-worker[\s\S]*?    completionProfile: engineering\n/, '')));
  await t.test('duplicate role id', () => rejectsMutation('orchestration.yaml', source => source.replace('  - id: engineering-manager', '  - id: portfolio-boss')));
});

test('requires mandatory human approval gates', async t => {
  await t.test('activation', () => rejectsMutation('orchestration.yaml', source => source.replace('  - activation\n', '')));
  await t.test('external write', () => rejectsMutation('orchestration.yaml', source => source.replace('  - external-write\n', '')));
  await t.test('final delivery', () => rejectsMutation('orchestration.yaml', source => source.replace('  - final-delivery\n', '')));
});

test('rejects missing and unknown quality command references', async t => {
  await t.test('missing test gate', () => rejectsMutation('quality.yaml', source => source.replace(/  - id: test\n    command: test\n    required: true\n/, '')));
  await t.test('unknown command', () => rejectsMutation('quality.yaml', source => source.replace('    command: lint', '    command: arbitrary-shell-command')));
});

test('rejects missing and unknown provider references', async t => {
  await t.test('missing referenced provider', () => rejectsMutation('providers.yaml', source => source.replace(/  - id: git-ci-main[\s\S]*$/, '')));
  await t.test('unknown provider', () => rejectsMutation('orchestration.yaml', source => source.replace('providerRefs: [git-ci-main]', 'providerRefs: [missing-provider]')));
});

test('validates a goal graph against project references', async () => {
  const config = await loadProjectConfig(fixture('valid'));
  assert.equal(validateGoalGraph(validGraph(), config), true);
});

test('rejects duplicate, dangling, self, and cyclic goal dependencies', async t => {
  const config = await loadProjectConfig(fixture('valid'));
  await t.test('duplicate', () => {
    const graph = validGraph();
    graph.nodes[1].id = graph.nodes[0].id;
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('dangling', () => {
    const graph = validGraph();
    graph.nodes[2].dependencies = ['missing-node'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('self', () => {
    const graph = validGraph();
    graph.nodes[2].dependencies = ['worker-code'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('cycle', () => {
    const graph = validGraph();
    graph.nodes[0].dependencies = ['worker-code'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('validates the maximum bounded dependency chain without recursive traversal', () => {
  const graph = validGraph();
  const workerTemplate = graph.nodes.find(node => node.id === 'worker-code');
  let dependency = workerTemplate.id;
  for (let index = 0; index < 996; index += 1) {
    const id = `chain-${index}`;
    graph.nodes.push({
      ...structuredClone(workerTemplate),
      id,
      objective: `Validate bounded dependency node ${index}`,
      dependencies: [dependency],
      evidenceRefs: [`evidence-chain-${index}`],
    });
    dependency = id;
  }
  graph.nodes.find(node => node.id === 'human-final').dependencies = [dependency];
  assert.equal(graph.nodes.length, 1000);
  assert.equal(validateGoalGraph(graph), true);
});

test('preserves dependency and parent relationship error paths and reasons', async t => {
  await t.test('dependency cycle', () => {
    const graph = validGraph();
    graph.nodes[0].dependencies = ['worker-code'];
    assert.throws(() => validateGoalGraph(graph), error => (
      error instanceof ConfigurationError
      && error.details.reason === 'dependency-cycle'
      && error.details.path === '/nodes/boss-plan/dependencies'
    ));
  });
  await t.test('dangling dependency', () => {
    const graph = validGraph();
    graph.nodes.find(node => node.id === 'worker-code').dependencies = ['missing-node'];
    assert.throws(() => validateGoalGraph(graph), error => (
      error instanceof ConfigurationError
      && error.details.reason === 'dangling-dependency'
      && error.details.path === '/nodes/worker-code/dependencies'
    ));
  });
  await t.test('parent cycle', () => {
    const graph = validGraph();
    graph.nodes.find(node => node.id === 'manager-plan').parentId = 'worker-code';
    graph.nodes.find(node => node.id === 'worker-code').parentId = 'manager-plan';
    assert.throws(() => validateGoalGraph(graph), error => (
      error instanceof ConfigurationError
      && error.details.reason === 'parent-cycle'
      && error.details.path === '/nodes/manager-plan/parentId'
    ));
  });
  await t.test('dangling parent', () => {
    const graph = validGraph();
    graph.nodes.find(node => node.id === 'worker-code').parentId = 'missing-parent';
    assert.throws(() => validateGoalGraph(graph), error => (
      error instanceof ConfigurationError
      && error.details.reason === 'dangling-parent'
      && error.details.path === '/nodes/worker-code/parentId'
    ));
  });
});

test('validates the maximum configured parent depth without recursive traversal', () => {
  const graph = validGraph();
  graph.maxDelegationDepth = 8;
  const template = graph.nodes.find(node => node.id === 'worker-code');
  let parentId = template.id;
  for (let depth = 3; depth <= 8; depth += 1) {
    const id = `depth-${depth}`;
    graph.nodes.push({
      ...structuredClone(template),
      id,
      parentId,
      objective: `Validate bounded parent depth ${depth}`,
      dependencies: ['manager-plan'],
      evidenceRefs: [`evidence-depth-${depth}`],
    });
    parentId = id;
  }
  assert.equal(validateGoalGraph(graph), true);
});

test('rejects unknown graph provider and completion references', async t => {
  const config = await loadProjectConfig(fixture('valid'));
  await t.test('provider', () => {
    const graph = validGraph();
    graph.providerRefs = ['missing-provider'];
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('completion profile', () => {
    const graph = validGraph();
    graph.nodes[1].completionProfile = 'missing-profile';
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('rejects completion profiles that differ from the owning role contract', async () => {
  const config = await loadProjectConfig(fixture('valid'));
  const graph = validGraph();
  graph.nodes[0].completionProfile = 'engineering';
  assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
});

test('rejects graph delegation beyond its configured limit', async () => {
  const config = await loadProjectConfig(fixture('valid'));
  const graph = validGraph();
  graph.maxDelegationDepth = 1;
  assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
});

test('rejects graph authority and budget beyond the owning role', async t => {
  const config = await loadProjectConfig(fixture('valid'));
  await t.test('authority', () => {
    const graph = validGraph();
    graph.nodes[2].authorityScopes.push('deploy');
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
  await t.test('budget', () => {
    const graph = validGraph();
    graph.nodes[2].budget.timeMinutes = 121;
    assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
  });
});

test('requires an approval node in a goal graph', async () => {
  const config = await loadProjectConfig(fixture('valid'));
  const graph = validGraph();
  delete graph.nodes[3].approvalGate;
  assert.throws(() => validateGoalGraph(graph, config), ConfigurationError);
});

test('validates event shapes and type-specific requirements', () => {
  assert.equal(validateEvent(validEvent()), true);
  const retry = { ...validEvent(), type: 'retry', retryReason: 'Transient test runner failure' };
  delete retry.priorState;
  delete retry.newState;
  assert.equal(validateEvent(retry), true);
  delete retry.retryReason;
  assert.throws(() => validateEvent(retry), ConfigurationError);
});

test('heartbeat events carry independently replayable bounded lease facts', () => {
  const heartbeat = { ...validEvent(), type: 'heartbeat', instanceId: 'instance-one', leaseId: 'lease-one', heartbeatSequence: 1, heartbeatIntervalMs: 100 };
  delete heartbeat.priorState; delete heartbeat.newState;
  assert.equal(validateEvent(heartbeat), true);
});

test('approval events carry an independently replayable receipt identity', () => {
  const approval = { ...validEvent(), actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded', evidenceRefs: ['approval-one'], approvalReceiptId: 'approval-one' };
  delete approval.priorState; delete approval.newState;
  assert.equal(validateEvent(approval), true);
  assert.throws(() => validateEvent({ ...approval, actor: { role: 'worker', id: 'implementation-worker' } }), ConfigurationError);
  assert.throws(() => validateEvent({ ...approval, approvalReceiptId: 'approval-two' }), ConfigurationError);
  delete approval.approvalReceiptId;
  assert.throws(() => validateEvent(approval), ConfigurationError);
});

test('event validation snapshots approval facts and nested getters exactly once', () => {
  const accesses = {};
  const actorValues = { role: 'human', id: 'human-owner' };
  const actor = {};
  for (const [key, value] of Object.entries(actorValues)) Object.defineProperty(actor, key, { enumerable: true, get() { accesses[`actor.${key}`] = (accesses[`actor.${key}`] ?? 0) + 1; return value; } });
  const evidenceRefs = new Proxy(['approval-one'], { get(target, property, receiver) { if (property === 'length' || property === '0') accesses[`evidenceRefs.${String(property)}`] = (accesses[`evidenceRefs.${String(property)}`] ?? 0) + 1; return Reflect.get(target, property, receiver); } });
  const values = { ...validEvent(), actor, type: 'approval-recorded', evidenceRefs, approvalReceiptId: 'approval-one' };
  delete values.priorState; delete values.newState;
  const approval = {};
  for (const [key, value] of Object.entries(values)) Object.defineProperty(approval, key, { enumerable: true, get() { accesses[`event.${key}`] = (accesses[`event.${key}`] ?? 0) + 1; return value; } });
  assert.equal(validateEvent(approval), true);
  assert.ok(Object.keys(accesses).length > 0);
  assert.ok(Object.values(accesses).every(count => count === 1));
});

test('event validation sanitizes a hostile getter after one access', () => {
  const canary = 'event-validator-private-canary'; let accesses = 0;
  const event = Object.defineProperty({}, 'type', { enumerable: true, get() { accesses += 1; throw new Error(canary); } });
  assert.throws(() => validateEvent(event), error => error instanceof ConfigurationError && !JSON.stringify(error).includes(canary));
  assert.equal(accesses, 1);
});

test('event validation rejects non-enumerable and prototype-mutating own keys', () => {
  const hidden = validEvent();
  Object.defineProperty(hidden, 'type', { enumerable: false, value: hidden.type });
  assert.throws(() => validateEvent(hidden), ConfigurationError);

  const prototypeKey = validEvent();
  Object.defineProperty(prototypeKey, '__proto__', { enumerable: true, value: { polluted: true } });
  assert.throws(() => validateEvent(prototypeKey), ConfigurationError);
  assert.equal({}.polluted, undefined);
});

test('event validation rejects symbol keys', () => {
  const event = validEvent(); event[Symbol('hidden')] = 'inert';
  assert.throws(() => validateEvent(event), ConfigurationError);
});

test('event validation snapshots authority delta arrays exactly once', () => {
  const accesses = { added: 0, removed: 0 };
  const authorityDelta = {};
  Object.defineProperty(authorityDelta, 'added', { enumerable: true, get() { accesses.added += 1; return ['verify']; } });
  Object.defineProperty(authorityDelta, 'removed', { enumerable: true, get() { accesses.removed += 1; return []; } });
  const event = { ...validEvent(), type: 'authority-adjusted', authorityDelta };
  delete event.priorState; delete event.newState;
  assert.equal(validateEvent(event), true);
  assert.deepEqual(accesses, { added: 1, removed: 1 });
});

test('event validation sanitizes hostile budget delta getters', () => {
  const canary = 'budget-delta-private-canary'; let accesses = 0;
  const budgetDelta = Object.defineProperty({}, 'tokenLimit', { enumerable: true, get() { accesses += 1; throw new Error(canary); } });
  const event = { ...validEvent(), type: 'budget-adjusted', budgetDelta };
  delete event.priorState; delete event.newState;
  assert.throws(() => validateEvent(event), error => error instanceof ConfigurationError && !JSON.stringify(error).includes(canary));
  assert.equal(accesses, 1);
});

test('event validation rejects sparse and non-enumerable array elements', () => {
  const base = { ...validEvent(), actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded', approvalReceiptId: 'approval-one' };
  delete base.priorState; delete base.newState;
  assert.throws(() => validateEvent({ ...base, evidenceRefs: new Array(1) }), ConfigurationError);
  const hidden = ['approval-one'];
  Object.defineProperty(hidden, '0', { enumerable: false, value: 'approval-one' });
  assert.throws(() => validateEvent({ ...base, evidenceRefs: hidden }), ConfigurationError);
});

test('event validation sanitizes an enumerable hostile array index after one access', () => {
  const canary = 'event-array-index-private-canary'; let accesses = 0;
  const evidenceRefs = [];
  Object.defineProperty(evidenceRefs, '0', { enumerable: true, get() { accesses += 1; throw new Error(canary); } });
  const event = { ...validEvent(), actor: { role: 'human', id: 'human-owner' }, type: 'approval-recorded', evidenceRefs, approvalReceiptId: 'approval-one' };
  delete event.priorState; delete event.newState;
  assert.throws(() => validateEvent(event), error => error instanceof ConfigurationError && !JSON.stringify(error).includes(canary));
  assert.equal(accesses, 1);
});

test('event snapshot failure never inspects an attacker-thrown Proxy', () => {
  const canary = 'event-thrown-proxy-private-canary'; let getterAccesses = 0; let prototypeAccesses = 0;
  const thrown = new Proxy({}, { getPrototypeOf() { prototypeAccesses += 1; throw new Error(canary); } });
  const event = Object.defineProperty({}, 'type', { enumerable: true, get() { getterAccesses += 1; throw thrown; } });
  assert.throws(() => validateEvent(event), error => error instanceof ConfigurationError
    && error.details.reason === 'event-snapshot' && error.cause === undefined && !JSON.stringify(error).includes(canary));
  assert.equal(getterAccesses, 1);
  assert.equal(prototypeAccesses, 0);
});

test('event snapshot failure replaces a caller-forged ConfigurationError', () => {
  const canary = 'forged-event-error-private-canary';
  const forged = new ConfigurationError('/', canary);
  const event = Object.defineProperty({}, 'type', { enumerable: true, get() { throw forged; } });
  assert.throws(() => validateEvent(event), error => error instanceof ConfigurationError && error !== forged
    && error.details.reason === 'event-snapshot' && error.cause === undefined && !JSON.stringify(error).includes(canary));
});

test('internal event snapshot failures return a fresh fixed error', () => {
  const event = validEvent(); event[Symbol('hidden')] = 'inert';
  let observed;
  assert.throws(() => validateEvent(event), error => {
    observed = error;
    return error instanceof ConfigurationError && error.details.reason === 'event-snapshot' && error.cause === undefined;
  });
  assert.notEqual(observed, undefined);
});

test('rejects arbitrary event payloads and secret-like event keys', () => {
  assert.throws(() => validateEvent({ ...validEvent(), payload: { token: 'inert-placeholder' } }), ConfigurationError);
});

test('rejects fields belonging to a different event type', () => {
  const event = validEvent();
  event.type = 'heartbeat';
  delete event.priorState;
  delete event.newState;
  event.budgetDelta = { tokenLimit: 1 };
  assert.throws(() => validateEvent(event), ConfigurationError);
});

test('rejects impossible event timestamps', () => {
  const event = validEvent();
  event.timestamp = '2026-02-30T12:00:00.000Z';
  assert.throws(() => validateEvent(event), ConfigurationError);
});

test('validates evidence bundles and type-specific requirements', () => {
  assert.equal(validateEvidence(validEvidence()), true);
  const evidence = validEvidence();
  delete evidence.items[0].details;
  assert.throws(() => validateEvidence(evidence), ConfigurationError);
});

test('requires commit evidence to name its commit source', () => {
  const evidence = validEvidence();
  evidence.items[0] = {
    ...evidence.items[0],
    type: 'commit',
    source: { providerRef: 'git-ci-main' },
  };
  delete evidence.items[0].details;
  assert.throws(() => validateEvidence(evidence), ConfigurationError);
});

test('rejects fields belonging to a different evidence type', () => {
  const evidence = validEvidence();
  evidence.items[0].approval = { actorId: 'human-owner', decision: 'approved' };
  assert.throws(() => validateEvidence(evidence), ConfigurationError);
});

test('uses the goal graph identifier grammar for evidence graph references', () => {
  const evidence = validEvidence();
  evidence.graphId = 'Graph_Demo';
  assert.throws(() => validateEvidence(evidence), ConfigurationError);
});

test('rejects impossible evidence timestamps', () => {
  const evidence = validEvidence();
  evidence.items[0].timestamp = '2026-13-01T12:00:00.000Z';
  assert.throws(() => validateEvidence(evidence), ConfigurationError);
});

test('requires screenshot locations and human approval decisions', async t => {
  await t.test('screenshot', () => {
    const evidence = validEvidence();
    evidence.items[0] = { ...evidence.items[0], type: 'screenshot' };
    delete evidence.items[0].details;
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
  await t.test('human approval', () => {
    const evidence = validEvidence();
    evidence.items[0] = { ...evidence.items[0], type: 'human-approval' };
    delete evidence.items[0].details;
    assert.throws(() => validateEvidence(evidence), ConfigurationError);
  });
});

test('rejects absolute and parent-escaping local evidence locations', async t => {
  for (const location of ['/private/tmp/inert.png', '../inert.png', '..\\inert.png', 'file:///private/tmp/inert.png']) {
    await t.test(location, () => {
      const evidence = validEvidence();
      evidence.items[0] = {
        ...evidence.items[0],
        type: 'screenshot',
        location,
        checksum: `sha256:${'0'.repeat(64)}`,
      };
      delete evidence.items[0].details;
      assert.throws(() => validateEvidence(evidence), ConfigurationError);
    });
  }
});

test('rejects YAML duplicate keys, multiple documents, aliases, and merge keys', async t => {
  await t.test('duplicate keys', () => rejectsMutation('project.yaml', source => `${source}name: Duplicate\n`));
  await t.test('multiple documents', () => rejectsMutation('project.yaml', source => `${source}---\nschemaVersion: 1\n`));
  await t.test('alias', () => rejectsMutation('project.yaml', source => source.replace('  build: [npm, run, build]', '  build: &build [npm, run, build]\n  copied: *build')));
  await t.test('merge key', () => rejectsMutation('project.yaml', source => source.replace('stack:\n', 'shared: &shared\n  framework: nextjs\nstack:\n  <<: *shared\n')));
});

test('rejects oversized and symlinked configuration files', async t => {
  await t.test('oversized', async () => {
    const root = await temporaryProject();
    await writeFile(join(root, '.rivet', 'project.yaml'), `# ${'x'.repeat(300_000)}\n`, 'utf8');
    await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
  });
  await t.test('symlink', async () => {
    const root = await temporaryProject();
    const path = join(root, '.rivet', 'project.yaml');
    const target = join(root, 'project-target.yaml');
    await cp(path, target);
    await unlink(path);
    await symlink(target, path);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
  });
  await t.test('symlinked config directory', async () => {
    const root = await temporaryProject();
    const configPath = join(root, '.rivet');
    const target = join(root, 'tracked-config');
    await rename(configPath, target);
    await symlink(target, configPath);
    await assert.rejects(() => loadProjectConfig(root), ConfigurationError);
  });
});
