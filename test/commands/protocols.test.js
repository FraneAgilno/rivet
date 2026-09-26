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
  await writeFile(join(root, 'protocol-source.md'), complete('Updated procedure.'));
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
  await writeFile(join(root, 'protocol-source.md'), complete('Run migrations in order.'));
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
  await writeFile(join(root, 'one.md'), complete('First update.'));
  await writeFile(join(root, 'two.md'), complete('Second update.'));
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

const complete = (procedure = 'Apply the approved migration.') => `# Database changes\n\n## Owner\nDatabase team\n\n## Purpose\nKeep database changes reviewable.\n\n## Applies when\nA database schema changes.\n\n## Procedure\n${procedure}\n\n## Required checks and evidence\nRecord the migration test and rollback instructions.\n`;
test('publication requires complete non-placeholder sections and leaves incomplete drafts unchanged', async t => {
 const root=await project(t);await writeFile(join(root,'source.md'),'# Incomplete\n\n## Owner\nTODO\n');
 const added=await run(root,'add',['incomplete'],{from:'source.md'});assert.equal(added.code,0);
 assert.equal(added.payload.result.protocol.completeness.ready,false);
 const path=join(root,'.rivet/protocols/incomplete.md'),before=await readFile(path,'utf8');
 const result=await run(root,'update',['incomplete'],{from:'source.md','expected-revision':'1',publish:true});
 assert.equal(result.code,EXIT_CODES.INVALID_INPUT);assert.match(result.payload.error.message,/Owner.*Purpose.*Applies when.*Procedure.*Required checks/s);
 assert.equal(await readFile(path,'utf8'),before);
});
test('retirement retains history, exact show guards bytes, and only explicit complete publication reactivates', async t => {
 const root=await project(t);await writeFile(join(root,'source.md'),complete());
 await run(root,'import',['database'],{from:'source.md'});
 const published=await run(root,'update',['database'],{from:'source.md','expected-revision':'1',publish:true});assert.equal(published.code,0);
 const selected=published.payload.result.protocol;
 assert.equal((await run(root,'show',['database'],{'expected-revision':'2','expected-digest':selected.digest})).code,0);
 const retired=await run(root,'retire',['database'],{'expected-revision':'2'});assert.equal(retired.code,0);assert.equal(retired.payload.result.protocol.status,'retired');assert.equal(retired.payload.result.protocol.revision,3);
 assert.deepEqual((await run(root,'find',['database'],{'include-drafts':true})).payload.result.protocols,[]);
 assert.equal((await run(root,'show',['database'],{'include-retired':true})).code,0);
 const stale=await run(root,'show',['database'],{'include-retired':true,'expected-revision':'2','expected-digest':selected.digest});assert.notEqual(stale.code,0);assert.equal(stale.payload.result,undefined);
 assert.equal((await run(root,'update',['database'],{from:'source.md','expected-revision':'3'})).payload.result.protocol.status,'draft');
 assert.equal((await run(root,'update',['database'],{from:'source.md','expected-revision':'4',publish:true})).payload.result.protocol.status,'active');
});
test('fenced headings do not satisfy completeness and duplicate sections cannot publish',async t=>{
 const root=await project(t);await writeFile(join(root,'source.md'),'# Fenced\n\n```markdown\n'+complete()+'\n```\n');
 await run(root,'import',['fenced'],{from:'source.md'});assert.notEqual((await run(root,'update',['fenced'],{from:'source.md','expected-revision':'1',publish:true})).code,0);
 await writeFile(join(root,'source.md'),complete()+'\n## Owner\nOther owner\n');
 assert.notEqual((await run(root,'update',['fenced'],{from:'source.md','expected-revision':'1',publish:true})).code,0);
});

test('human publication errors name missing sections and their correction command',async t=>{
 const root=await project(t);await writeFile(join(root,'source.md'),complete().replace('Database team','TODO: add owner'));
 await run(root,'import',['human-guide'],{from:'source.md'});const output=capture();
 const code=await main(['protocols','update','human-guide','--project='+root,'--from=source.md','--expected-revision=1','--publish'],{cwd:()=>root,output:output.output});
 assert.equal(code,EXIT_CODES.INVALID_INPUT);const text=output.writes.map(([,text])=>text).join('');assert.match(text,/Owner/);assert.match(text,/--from=<file>/);assert.match(text,/Do not invent team policy/);
});
test('show expectation flags require a pair, remain show-only, and parse through main',async t=>{
 const root=await project(t);await writeFile(join(root,'source.md'),complete());await run(root,'import',['exact-guide'],{from:'source.md'});
 const result=await run(root,'update',['exact-guide'],{from:'source.md','expected-revision':'1',publish:true}),digest=result.payload.result.protocol.digest;
 const output=capture();assert.equal(await main(['protocols','show','exact-guide','--project='+root,'--expected-revision=2','--expected-digest='+digest,'--json'],{output:output.output}),0);
 assert.notEqual((await run(root,'show',['exact-guide'],{'expected-revision':'2'})).code,0);
 assert.notEqual((await run(root,'validate',[],{'expected-digest':digest})).code,0);
});

test('HTML-comment-only metadata cannot make an incomplete protocol publishable',async t=>{
 const root=await project(t);await writeFile(join(root,'source.md'),'# Hidden\n\n<!--\n'+complete()+'-->\n');
 await run(root,'import',['hidden'],{from:'source.md'});const file=join(root,'.rivet/protocols/hidden.md'),before=await readFile(file,'utf8');
 const result=await run(root,'update',['hidden'],{from:'source.md','expected-revision':'1',publish:true});
 assert.equal(result.code,EXIT_CODES.INVALID_INPUT);assert.match(result.payload.error.message,/Owner/);assert.equal(await readFile(file,'utf8'),before);
});

test('exact selected lookup ignores unrelated malformed drafts without replacing the approved body',async t=>{
 const root=await project(t);await writeFile(join(root,'source.md'),complete());await run(root,'import',['selected'],{from:'source.md'});
 const published=await run(root,'update',['selected'],{from:'source.md','expected-revision':'1',publish:true});
 await writeFile(join(root,'.rivet/protocols/unrelated.md'),'unfinished unrelated draft');
 const result=await run(root,'show',['selected'],{'expected-revision':'2','expected-digest':published.payload.result.protocol.digest});
 assert.equal(result.code,0);assert.equal(result.payload.result.protocol.body,complete());
});
