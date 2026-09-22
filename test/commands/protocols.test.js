import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_PROTOCOL_BYTES, protocolsCommand } from '../../src/commands/protocols.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { main } from '../../src/cli/main.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const here = dirname(fileURLToPath(import.meta.url));
const validConfig = join(here, '..', 'fixtures', 'config', 'valid', '.rivet');

function capture() {
  const writes = [];
  return {
    output: createOutput({
      stdout: { write: value => writes.push(['stdout', value]) },
      stderr: { write: value => writes.push(['stderr', value]) },
    }),
    writes,
  };
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-protocols-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(validConfig, join(root, '.rivet'), { recursive: true });
  return root;
}

function parsed(root, subcommand, operands = [], flags = {}) {
  return {
    command: 'protocols',
    subcommand,
    operands,
    flags: { project: root, json: true, ...flags },
  };
}

async function run(root, subcommand, operands = [], flags = {}) {
  const result = capture();
  const code = await protocolsCommand(parsed(root, subcommand, operands, flags), {
    cwd: () => root,
    fs: undefined,
    output: result.output,
  });
  return { code, payload: JSON.parse(result.writes.at(-1)[1]) };
}

test('add creates a bounded draft protocol with revision one and a digest', async t => {
  const root = await project(t);
  const result = await run(root, 'add', ['database-changes']);

  assert.equal(result.code, EXIT_CODES.SUCCESS);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.result.protocol.id, 'database-changes');
  assert.equal(result.payload.result.protocol.status, 'draft');
  assert.equal(result.payload.result.protocol.revision, 1);
  assert.match(result.payload.result.protocol.digest, /^sha256:[a-f0-9]{64}$/);
  const source = await readFile(join(root, '.rivet', 'protocols', 'database-changes.md'), 'utf8');
  assert.match(source, /status: draft/);
  assert.equal((await loadProjectConfig(root)).project.id, 'conference-planner');
});

test('import stores external Markdown as a draft without executing or modifying the source', async t => {
  const root = await project(t);
  const sourcePath = join(root, 'deployment-guide.md');
  const source = '# Deployment Guide\n\nRun the reviewed deployment checklist.\n';
  await writeFile(sourcePath, source);

  const result = await run(root, 'import', ['deployment'], { from: 'deployment-guide.md' });

  assert.equal(result.code, EXIT_CODES.SUCCESS);
  assert.equal(result.payload.result.protocol.status, 'draft');
  assert.equal(await readFile(sourcePath, 'utf8'), source);
  assert.match(await readFile(join(root, '.rivet', 'protocols', 'deployment.md'), 'utf8'), /Run the reviewed deployment checklist/);
});

test('import canonicalizes a source without a trailing newline and remains discoverable', async t => {
  const root = await project(t);
  await writeFile(join(root, 'plain.md'), '# Plain Protocol');
  await run(root, 'import', ['plain-protocol'], { from: 'plain.md' });
  const validated = await run(root, 'validate', ['plain-protocol']);
  assert.equal(validated.code, EXIT_CODES.SUCCESS);
  assert.equal(validated.payload.result.protocols[0].id, 'plain-protocol');
});

test('find excludes drafts by default while show and explicit discovery can include them', async t => {
  const root = await project(t);
  await run(root, 'add', ['draft-procedure']);
  const hidden = await run(root, 'find', ['procedure']);
  assert.deepEqual(hidden.payload.result.protocols, []);

  const shown = await run(root, 'show', ['draft-procedure'], { 'include-drafts': true });
  assert.equal(shown.payload.result.protocol.status, 'draft');
  const included = await run(root, 'find', ['procedure'], { 'include-drafts': true });
  assert.equal(included.payload.result.protocols.length, 1);
});

test('update requires the current revision, increments it, and publishes only explicitly', async t => {
  const root = await project(t);
  await writeFile(join(root, 'protocol-source.md'), '# Deployment\n\nUpdated procedure.\n');
  await run(root, 'import', ['deployment'], { from: 'protocol-source.md' });

  const updated = await run(root, 'update', ['deployment'], {
    from: 'protocol-source.md',
    'expected-revision': '1',
    publish: true,
  });
  assert.equal(updated.code, EXIT_CODES.SUCCESS);
  assert.equal(updated.payload.result.protocol.status, 'active');
  assert.equal(updated.payload.result.protocol.revision, 2);

  const stale = await run(root, 'update', ['deployment'], {
    from: 'protocol-source.md',
    'expected-revision': '1',
  });
  assert.equal(stale.code, EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(stale.payload.error.code, 'REPOSITORY_CONFLICT');
});

test('active discovery sees a protocol added after installation without reinstalling a skill', async t => {
  const root = await project(t);
  await writeFile(join(root, 'protocol-source.md'), '# Database Migration\n\nRun migrations in order.\n');
  await run(root, 'import', ['database-migrations'], { from: 'protocol-source.md' });
  await run(root, 'update', ['database-migrations'], {
    from: 'protocol-source.md',
    'expected-revision': '1',
    publish: true,
  });

  const result = await run(root, 'find', ['migration']);
  assert.equal(result.payload.result.protocols.length, 1);
  assert.equal(result.payload.result.protocols[0].id, 'database-migrations');
});

test('protocol imports reject traversal and symlinked source files without creating protocol files', async t => {
  const root = await project(t);
  const external = await mkdtemp(join(tmpdir(), 'rivet-protocol-source-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'guide.md'), '# Unsafe\n');
  await symlink(join(external, 'guide.md'), join(root, 'linked.md'));

  const traversal = await run(root, 'import', ['unsafe'], { from: '../guide.md' });
  assert.equal(traversal.code, EXIT_CODES.INVALID_INPUT);
  const linked = await run(root, 'import', ['unsafe'], { from: 'linked.md' });
  assert.equal(linked.code, EXIT_CODES.REPOSITORY_CONFLICT);
  await assert.rejects(() => lstat(join(root, '.rivet', 'protocols', 'unsafe.md')));
});

test('protocol imports reject symlinked parent directories and invalid generated documents', async t => {
  const root = await project(t);
  const external = await mkdtemp(join(tmpdir(), 'rivet-protocol-parent-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'guide.md'), '# Escaped\n');
  await symlink(external, join(root, 'linked-directory'));

  const linked = await run(root, 'import', ['escaped'], { from: 'linked-directory/guide.md' });
  assert.equal(linked.code, EXIT_CODES.REPOSITORY_CONFLICT);

  await writeFile(join(root, 'preamble.md'), 'untrusted preamble\n# Heading\n');
  const invalid = await run(root, 'import', ['invalid-preamble'], { from: 'preamble.md' });
  assert.equal(invalid.code, EXIT_CODES.INVALID_INPUT);
  await assert.rejects(() => lstat(join(root, '.rivet', 'protocols', 'invalid-preamble.md')));
});

test('concurrent updates cannot both publish the same expected revision', async t => {
  const root = await project(t);
  await writeFile(join(root, 'one.md'), '# Procedure\n\nFirst update.\n');
  await writeFile(join(root, 'two.md'), '# Procedure\n\nSecond update.\n');
  await run(root, 'import', ['procedure'], { from: 'one.md' });

  const results = await Promise.all([
    run(root, 'update', ['procedure'], { from: 'one.md', 'expected-revision': '1', publish: true }),
    run(root, 'update', ['procedure'], { from: 'two.md', 'expected-revision': '1', publish: true }),
  ]);
  assert.deepEqual(results.map(result => result.code).sort((a, b) => a - b), [
    EXIT_CODES.SUCCESS,
    EXIT_CODES.REPOSITORY_CONFLICT,
  ].sort((a, b) => a - b));
  const validated = await run(root, 'validate', ['procedure']);
  assert.equal(validated.payload.result.protocols[0].revision, 2);
});

test('protocol imports enforce the bounded source read before writing', async t => {
  const root = await project(t);
  await writeFile(join(root, 'oversized.md'), `# Oversized\n\n${'x'.repeat(MAX_PROTOCOL_BYTES)}\n`);

  const result = await run(root, 'import', ['oversized'], { from: 'oversized.md' });

  assert.equal(result.code, EXIT_CODES.REPOSITORY_CONFLICT);
  await assert.rejects(() => lstat(join(root, '.rivet', 'protocols', 'oversized.md')));
});

test('protocol parser exposes nested verbs and rejects unsupported positional/flag forms', () => {
  assert.deepEqual(parseArgs(['protocols', 'import', 'deployment', '--from=guide.md', '--project=/repo', '--json']), {
    command: 'protocols',
    subcommand: 'import',
    operands: ['deployment'],
    flags: { from: 'guide.md', project: '/repo', json: true },
  });
  assert.throws(() => parseArgs(['protocols', 'unknown']), /Unsupported protocol subcommand/);
  assert.throws(() => parseArgs(['protocols', 'import', 'deployment', '--unknown']), /Unknown option/);
});

test('main dispatches the protocols command through the CLI boundary', async t => {
  const root = await project(t);
  const result = capture();
  const code = await main(['protocols', 'add', 'from-main', '--project', root, '--json'], {
    output: result.output,
    cwd: () => root,
  });
  assert.equal(code, EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(result.writes.at(-1)[1]).result.protocol.id, 'from-main');
});

test('config loader accepts only the optional protocols directory among extra .rivet entries', async t => {
  const root = await project(t);
  await mkdir(join(root, '.rivet', 'protocols'));
  await loadProjectConfig(root);
  await writeFile(join(root, '.rivet', 'unexpected.txt'), 'unsafe\n');
  await assert.rejects(() => loadProjectConfig(root), /invalid/i);
});

test('config loader rejects a symlink in place of the optional protocols directory', async t => {
  const root = await project(t);
  const external = await mkdtemp(join(tmpdir(), 'rivet-protocol-directory-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, join(root, '.rivet', 'protocols'));

  await assert.rejects(() => loadProjectConfig(root), /invalid/i);
});
