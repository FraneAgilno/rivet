import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { readdirSync, renameSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { createEvidence } from '../../src/commands/evidence.js';
import { validateEvidence as validateCanonicalEvidence } from '../../src/config/validate.js';
import { checksumFile, sha256 } from '../../src/evidence/checksum.js';
import { collectEvidenceBundle, EvidenceCollectionError } from '../../src/evidence/collect.js';
import { validateEvidenceManifest } from '../../src/evidence/validate.js';
import { createGitClient } from '../../src/git/client.js';
import { createApprovalReceipt, createApprovalRegistry } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { runQualityGates } from '../../src/quality/runner.js';
import { validateTraceability } from '../../src/quality/traceability.js';

const execFile = promisify(execFileCallback);
const NOW = Date.parse('2029-01-01T00:00:00.000Z');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function insertBeforeIend(bytes, chunk) {
  return Buffer.concat([bytes.subarray(0, bytes.length - 12), chunk, bytes.subarray(bytes.length - 12)]);
}

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

async function git(cwd, ...args) {
  return execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 });
}

function authority() {
  return createAuthorityEnvelope({
    actorId: 'quality-worker', principal: 'agent', actions: ['command.playwright'],
    ownedPaths: [], providers: [], commands: ['playwright'],
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agilno-evidence-')));
  const projectRoot = join(root, 'project');
  const outputRoot = join(root, 'bundles');
  const outsideRoot = join(root, 'outside');
  await execFile('git', ['init', '--quiet', '-b', 'main', projectRoot]);
  await mkdir(join(projectRoot, 'artifacts'), { recursive: true });
  await mkdir(outputRoot);
  await mkdir(outsideRoot);
  await writeFile(join(projectRoot, 'artifacts', 'home.png'), PNG);
  await writeFile(join(projectRoot, 'artifacts', 'playwright.json'), '{"passed":true}\n');
  await writeFile(join(projectRoot, 'artifacts', 'home.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(projectRoot, 'artifacts', 'home.webp'), Buffer.from('RIFF\u0014\0\0\0WEBPVP8 \u0008\0\0\0markers!'));
  await writeFile(join(projectRoot, '.gitignore'), 'artifacts/\n');
  await git(projectRoot, 'add', '--', '.gitignore');
  await execFile('git', ['-C', projectRoot, '-c', 'user.name=Agilno Test', '-c', 'user.email=test@agilno.example', 'commit', '--quiet', '-m', 'fixture']);
  const commitSha = (await git(projectRoot, 'rev-parse', 'HEAD')).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const gateExecutable = join(root, 'gate');
  await writeFile(gateExecutable, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"playwright","tests":[{"id":"e2e-home","status":"passed","acceptanceCriteria":["DEMO-2-AC1"]}]}\' > artifacts/playwright.json.tmp',
    'mv artifacts/playwright.json.tmp artifacts/playwright.json',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const qualityRun = await runQualityGates({
    projectRoot, commitSha, authority: authority(),
    gates: [{
      id: 'playwright', executable: gateExecutable, args: [], cwd: '.', required: true,
      artifactPaths: ['artifacts/home.png', 'artifacts/home.jpg', 'artifacts/home.webp', 'artifacts/playwright.json'],
      resultPath: 'artifacts/playwright.json',
      tests: [{ id: 'e2e-home', acceptanceCriteria: ['DEMO-2-AC1'] }],
    }],
  }, { gitClient, now: (() => { let value = NOW; return () => value++; })() });
  const registry = createApprovalRegistry({ approvers: [
    { id: 'human-owner', principal: 'human' }, { id: 'manager-one', principal: 'agent' },
  ] });
  const traceability = validateTraceability({
    subjectId: 'quality-manager', qualityRun,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [],
  }, { approvalRegistry: registry, nowMs: NOW });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectRoot, outputRoot, outsideRoot, commitSha, gitClient, gateExecutable, qualityRun, traceability, registry };
}

function approval(fields) {
  return createApprovalReceipt({
    decision: 'approved', expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true, ...fields,
  });
}

function evidenceInput(f, overrides = {}) {
  return {
    projectRoot: f.projectRoot, outputRoot: f.outputRoot, runId: 'run-one', graphId: 'graph-demo',
    subjectId: 'quality-manager', approvalRegistry: f.registry, nowMs: NOW, gitClient: f.gitClient,
    qualityRun: f.qualityRun, traceability: f.traceability,
    contexts: [{
      testId: 'e2e-home', route: '/agenda', persona: 'attendee', viewport: { width: 390, height: 844 },
      figmaVersion: 'figma-v42', previewUrl: 'https://preview.example.test/commit/' + f.commitSha,
    }],
    artifacts: [
      { id: 'agenda-mobile', type: 'screenshot', path: 'artifacts/home.png', testId: 'e2e-home' },
      { id: 'playwright-report', type: 'playwright-report', path: 'artifacts/playwright.json', testId: 'e2e-home' },
    ],
    reviews: [{
      id: 'manager-review', reviewerId: 'manager-one', required: true, expectedApproverId: 'manager-one',
      approvalFor: contentHash => approval({
        id: 'review-run-one', approverId: 'manager-one', approverPrincipal: 'agent', subjectId: 'quality-manager',
        action: 'quality.review', resource: 'evidence:run-one:review:manager-review:sha256:' + contentHash,
        policyId: 'quality.review',
      }),
    }],
    finalApproval: {
      expectedApproverId: 'human-owner',
      approvalFor: contentHash => approval({
        id: 'final-run-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'quality-manager',
        action: 'quality.complete', resource: 'evidence:run-one:sha256:' + contentHash, policyId: 'quality.final',
      }),
    },
    ...overrides,
  };
}

function publication(remoteUrl, onChecksum = () => {}) {
  return {
    remoteUrl, expectedApproverId: 'human-owner',
    approvalFor(checksum) {
      onChecksum(checksum);
      return approval({
        id: 'publish-run-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'quality-manager',
        action: 'quality.publish', resource: remoteUrl + '#sha256:' + checksum, policyId: 'quality.publication',
      });
    },
  };
}

test('computes SHA-256 from bounded regular files and rejects symlinks', async t => {
  const f = await fixture(t);
  const path = join(f.projectRoot, 'artifacts', 'home.png');
  const result = await checksumFile(path);
  assert.equal(result.sha256, sha256(PNG));
  const link = join(f.projectRoot, 'artifacts', 'linked.png');
  await symlink(path, link);
  await assert.rejects(() => checksumFile(link), /regular file/i);
});

test('creates an atomic immutable bundle from authenticated quality, traceability, reviews, and content-bound final approval', async t => {
  const f = await fixture(t);
  const result = await collectEvidenceBundle(evidenceInput(f));
  assert.equal(result.manifest.status, 'complete');
  assert.equal(result.manifest.commitSha, f.commitSha);
  assert.match(result.manifest.preapprovalContentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.manifest.reviews[0].approvalReceiptId, 'review-run-one');
  assert.equal(result.manifest.finalApproval.contentHash, result.manifest.preapprovalContentHash);
  assert.equal(result.manifest.durablyPublished, false);
  assert.equal(result.durablyPublished, false);
  assert.equal(validateCanonicalEvidence(result.manifest.evidence), true);
  assert.deepEqual(validateEvidenceManifest(result.manifest), { valid: true, errors: [] });
  assert.equal(JSON.parse(await readFile(result.manifestPath, 'utf8')).runId, 'run-one');
  assert.equal(sha256(await readFile(result.archivePath)), result.archiveChecksum);
  assert.deepEqual(readdirSync(f.outputRoot), ['run-one']);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), EvidenceCollectionError);
});

test('rejects fabricated gate, traceability, review, and legacy commit-only approval assertions', async t => {
  const f = await fixture(t);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { qualityRun: { ...f.qualityRun } })), EvidenceCollectionError);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { traceability: { ...f.traceability } })), EvidenceCollectionError);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
    reviews: [{ id: 'manager-review', reviewerId: 'manager-one', required: true, status: 'approved' }],
  })), EvidenceCollectionError);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
    finalApproval: {
      expectedApproverId: 'human-owner',
      approvalFor: () => approval({
        id: 'legacy-final', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'quality-manager',
        action: 'quality.complete', resource: 'evidence:run-one:' + f.commitSha, policyId: 'quality.final',
      }),
    },
  })), EvidenceCollectionError);
});

test('validates screenshot media and secret-scans its bytes and metadata', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectRoot, 'artifacts', 'home.png'), 'not-an-image');
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), EvidenceCollectionError);
  await writeFile(join(f.projectRoot, 'artifacts', 'home.png'), Buffer.concat([
    PNG.subarray(0, PNG.length - 12), Buffer.from('DEMO_API_TOKEN=super-secret-value-123456'), PNG.subarray(PNG.length - 12),
  ]));
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), EvidenceCollectionError);
});

test('binds durable publication to the exact generated archive checksum without archive self-reference', async t => {
  const f = await fixture(t);
  let approvedChecksum;
  const remoteUrl = 'https://evidence.example.test/run-one.qa-bundle.json';
  const result = await collectEvidenceBundle(evidenceInput(f, {
    publication: publication(remoteUrl, checksum => { approvedChecksum = checksum; }),
  }));
  assert.equal(approvedChecksum, result.archiveChecksum);
  assert.equal(sha256(await readFile(result.archivePath)), result.archiveChecksum);
  assert.equal(result.durablyPublished, true);
  assert.equal(result.manifest.durablyPublished, false);
  assert.deepEqual(result.publication, {
    status: 'published', remoteUrl, checksum: result.archiveChecksum,
    approvalReceiptId: 'publish-run-one', approverId: 'human-owner', approverPrincipal: 'human',
  });
  assert.deepEqual(JSON.parse(await readFile(join(result.runDirectory, 'publication.json'), 'utf8')), result.publication);
});

test('identity-pins outputRoot so a symlink swap cannot redirect publication', async t => {
  const f = await fixture(t);
  const original = f.outputRoot + '-original';
  const input = evidenceInput(f, {
    finalApproval: {
      expectedApproverId: 'human-owner',
      approvalFor(contentHash) {
        renameSync(f.outputRoot, original);
        symlinkSync(f.outsideRoot, f.outputRoot, 'dir');
        return approval({
          id: 'final-run-one', approverId: 'human-owner', approverPrincipal: 'human', subjectId: 'quality-manager',
          action: 'quality.complete', resource: 'evidence:run-one:sha256:' + contentHash, policyId: 'quality.final',
        });
      },
    },
  });
  await assert.rejects(() => collectEvidenceBundle(input), EvidenceCollectionError);
  assert.deepEqual(readdirSync(f.outsideRoot), []);
  assert.deepEqual(readdirSync(original), []);
});

test('cleans private staging when publication approval or a late write fails', async t => {
  const f = await fixture(t);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
    publication: {
      remoteUrl: 'https://evidence.example.test/run-one.qa-bundle.json', expectedApproverId: 'human-owner',
      approvalFor() { throw new Error('approval provider failed'); },
    },
  })), EvidenceCollectionError);
  assert.deepEqual(readdirSync(f.outputRoot), []);
});

test('createEvidence exposes publication separately from the immutable archive manifest', async t => {
  const f = await fixture(t);
  const result = await createEvidence(evidenceInput(f));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.bundle.manifest.runId, 'run-one');
});

test('collection rejects gate artifacts changed after the authenticated quality run', async t => {
  const f = await fixture(t);
  const changed = Buffer.from(PNG);
  changed[changed.length - 20] ^= 0x01;
  await writeFile(join(f.projectRoot, 'artifacts', 'home.png'), changed);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), EvidenceCollectionError);
});

test('collection rejects caller artifacts unrelated to any authenticated gate artifact', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectRoot, 'artifacts', 'unrelated.json'), '{"passed":true}\n');
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
    artifacts: [
      { id: 'agenda-mobile', type: 'screenshot', path: 'artifacts/home.png', testId: 'e2e-home' },
      { id: 'playwright-report', type: 'playwright-report', path: 'artifacts/unrelated.json', testId: 'e2e-home' },
    ],
  })), EvidenceCollectionError);
});

test('validator recomputes preapproval and review content hashes and gate status consistency', async t => {
  const f = await fixture(t);
  const result = await collectEvidenceBundle(evidenceInput(f));
  const contextTamper = {
    ...result.manifest,
    contexts: result.manifest.contexts.map(context => ({ ...context, route: '/tampered' })),
  };
  assert.equal(validateEvidenceManifest(contextTamper).valid, false);
  const gateTamper = {
    ...result.manifest,
    gates: result.manifest.gates.map(gate => ({ ...gate, status: 'passed', exitCode: 3, executionStatus: 'failed' })),
  };
  assert.equal(validateEvidenceManifest(gateTamper).valid, false);
});

test('validator re-reads and re-hashes persisted manifest, artifacts, and archive', async t => {
  const f = await fixture(t);
  const result = await collectEvidenceBundle(evidenceInput(f));
  assert.deepEqual(validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory }), { valid: true, errors: [] });
  await chmod(join(result.runDirectory, 'artifacts', 'playwright-report.json'), 0o600);
  await writeFile(join(result.runDirectory, 'artifacts', 'playwright-report.json'), '{"tampered":true}\n');
  const validation = validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test('media validation rejects structurally valid PNG markers with corrupt compressed pixels', async t => {
  const f = await fixture(t);
  const corrupt = Buffer.from(PNG);
  const idat = corrupt.indexOf(Buffer.from('IDAT'));
  assert.ok(idat > 0);
  corrupt[idat + 6] ^= 0xff;
  await writeFile(join(f.projectRoot, 'artifacts', 'home.png'), corrupt);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), EvidenceCollectionError);
});

test('screenshot evidence narrows fail-closed to fully decoded PNG and rejects JPEG or WebP markers', async t => {
  const f = await fixture(t);
  for (const path of ['artifacts/home.jpg', 'artifacts/home.webp']) {
    await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
      artifacts: [
        { id: 'agenda-mobile', type: 'screenshot', path, testId: 'e2e-home' },
        { id: 'playwright-report', type: 'playwright-report', path: 'artifacts/playwright.json', testId: 'e2e-home' },
      ],
    })), EvidenceCollectionError);
  }
});

test('validator options and collection records sanitize hostile reflection traps', async t => {
  const f = await fixture(t);
  const result = await collectEvidenceBundle(evidenceInput(f));
  const hostileOptions = new Proxy({}, {
    ownKeys() { throw new Error('hostile-options-secret'); },
  });
  const validation = validateEvidenceManifest(result.manifest, hostileOptions);
  assert.equal(validation.valid, false);
  assert.doesNotMatch(validation.errors.join(' '), /hostile-options-secret/);

  const hostileArtifact = new Proxy({}, {
    ownKeys() { throw new Error('hostile-artifact-secret'); },
  });
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { artifacts: [hostileArtifact] })), error => {
    assert.equal(error.name, 'EvidenceCollectionError');
    assert.doesNotMatch(error.message, /hostile-artifact-secret/);
    return true;
  });
});

test('final publication revalidates the absolute output pathname after a native rename swap', async t => {
  const f = await fixture(t);
  const original = f.outputRoot + '-native-original';
  const watcher = spawn(process.execPath, ['-e', [
    "const fs=require('node:fs');",
    "const [root, original, outside]=process.argv.slice(1);",
    "process.stdout.write('ready\\n');",
    "const deadline=Date.now()+10000;",
    "while(Date.now()<deadline){",
    " let entries=[]; try{entries=fs.readdirSync(root)}catch{}",
    " if(entries.some(name=>name.startsWith('.run-one.stage-'))){",
    "  fs.renameSync(root, original); fs.symlinkSync(outside, root, 'dir'); process.exit(0);",
    " }",
    "}",
    "process.exit(2);",
  ].join(''), f.outputRoot, original, f.outsideRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  const watcherExit = once(watcher, 'exit');
  await once(watcher.stdout, 'data');
  const artifacts = [
    ...Array.from({ length: 250 }, (_, index) => ({
      id: 'screen-' + index, type: 'screenshot', path: 'artifacts/home.png', testId: 'e2e-home',
    })),
    { id: 'playwright-report', type: 'playwright-report', path: 'artifacts/playwright.json', testId: 'e2e-home' },
  ];
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { artifacts })), EvidenceCollectionError);
  const [code] = await watcherExit;
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(f.outsideRoot), []);
  assert.deepEqual(readdirSync(original), []);
});

test('canonical evidence deduplicates one test item reused across exact per-AC coverage rows', async t => {
  const f = await fixture(t);
  const multiGate = join(f.root, 'multi-ac-gate');
  await writeFile(multiGate, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"schemaVersion":1,"gateId":"playwright","tests":[{"id":"e2e-home","status":"passed","acceptanceCriteria":["DEMO-2-AC1","DEMO-2-AC2"]}]}\' > artifacts/playwright.json.tmp',
    'mv artifacts/playwright.json.tmp artifacts/playwright.json',
    '',
  ].join('\n'), { mode: 0o700 });
  const qualityRun = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(),
    gates: [{
      id: 'playwright', executable: multiGate, args: [], cwd: '.', required: true,
      artifactPaths: ['artifacts/home.png', 'artifacts/home.jpg', 'artifacts/home.webp', 'artifacts/playwright.json'],
      resultPath: 'artifacts/playwright.json',
      tests: [{ id: 'e2e-home', acceptanceCriteria: ['DEMO-2-AC1', 'DEMO-2-AC2'] }],
    }],
  }, { gitClient: f.gitClient, now: (() => { let value = NOW + 100; return () => value++; })() });
  const traceability = validateTraceability({
    subjectId: 'quality-manager', qualityRun,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }, { id: 'DEMO-2-AC2', inScope: true }], manualReviews: [],
  }, { approvalRegistry: f.registry, nowMs: NOW });
  const result = await collectEvidenceBundle(evidenceInput(f, { qualityRun, traceability }));
  assert.deepEqual(traceability.coverage.map(row => row.acceptanceCriterion), ['DEMO-2-AC1', 'DEMO-2-AC2']);
  const testItems = result.manifest.evidence.items.filter(item => item.id === 'e2e-home');
  assert.equal(testItems.length, 1);
  assert.deepEqual(testItems[0].requirementRefs, ['DEMO-2-AC1', 'DEMO-2-AC2']);
});

test('persisted validation rejects extra or missing files and noncanonical archive bytes', async t => {
  const f = await fixture(t);
  const result = await collectEvidenceBundle(evidenceInput(f));
  const rootExtra = join(result.runDirectory, 'unexpected.txt');
  await writeFile(rootExtra, 'unexpected\n');
  assert.equal(validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory }).valid, false);
  await rm(rootExtra);

  const artifactExtra = join(result.runDirectory, 'artifacts', 'unexpected.txt');
  await writeFile(artifactExtra, 'unexpected\n');
  assert.equal(validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory }).valid, false);
  await rm(artifactExtra);

  const expectedArtifact = join(result.runDirectory, 'artifacts', 'playwright-report.json');
  const expectedBytes = await readFile(expectedArtifact);
  await rm(expectedArtifact);
  assert.equal(validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory }).valid, false);
  await writeFile(expectedArtifact, expectedBytes, { mode: 0o400 });

  const archivePath = join(result.runDirectory, 'qa-bundle.json');
  const archive = JSON.parse(await readFile(archivePath, 'utf8'));
  await chmod(archivePath, 0o600);
  await writeFile(archivePath, JSON.stringify({ ...archive, unexpected: true }) + '\n');
  assert.equal(validateEvidenceManifest(result.manifest, { runDirectory: result.runDirectory }).valid, false);
});

test('outputRoot cannot be the project root or any descendant publication path', async t => {
  const f = await fixture(t);
  const nested = join(f.projectRoot, 'artifacts', 'bundles');
  await mkdir(nested);
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { outputRoot: nested })), EvidenceCollectionError);
  assert.deepEqual(readdirSync(nested), []);
});

test('PNG validation decodes and secret-scans compressed iCCP metadata', async t => {
  const f = await fixture(t);
  const profile = Buffer.concat([
    Buffer.from('demo-profile\0\0'),
    deflateSync(Buffer.from('DEMO_API_TOKEN=compressed-profile-secret-123456')),
  ]);
  await writeFile(join(f.projectRoot, 'artifacts', 'home.png'), insertBeforeIend(PNG, pngChunk('iCCP', profile)));
  const qualityRun = await runQualityGates({
    projectRoot: f.projectRoot, commitSha: f.commitSha, authority: authority(),
    gates: [{
      id: 'playwright', executable: f.gateExecutable, args: [], cwd: '.', required: true,
      artifactPaths: ['artifacts/home.png', 'artifacts/home.jpg', 'artifacts/home.webp', 'artifacts/playwright.json'],
      resultPath: 'artifacts/playwright.json', tests: [{ id: 'e2e-home', acceptanceCriteria: ['DEMO-2-AC1'] }],
    }],
  }, { gitClient: f.gitClient, now: (() => { let value = NOW + 200; return () => value++; })() });
  const traceability = validateTraceability({
    subjectId: 'quality-manager', qualityRun,
    acceptanceCriteria: [{ id: 'DEMO-2-AC1', inScope: true }], manualReviews: [],
  }, { approvalRegistry: f.registry, nowMs: NOW });
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, { qualityRun, traceability })), EvidenceCollectionError);
});

test('nested context reflection and cwd capture or restore failures stay sanitized domain errors', async t => {
  const f = await fixture(t);
  const hostileViewport = new Proxy({}, { ownKeys() { throw new Error('nested-context-secret'); } });
  await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
    contexts: [{
      testId: 'e2e-home', route: '/agenda', persona: 'attendee', viewport: hostileViewport,
      figmaVersion: 'figma-v42', previewUrl: 'https://preview.example.test/commit/' + f.commitSha,
    }],
  })), error => {
    assert.equal(error.name, 'EvidenceCollectionError');
    assert.doesNotMatch(error.message, /nested-context-secret/);
    return true;
  });

  const original = process.cwd();
  const originalChdir = process.chdir;
  let rejectRestore = true;
  process.chdir = function hostileRestore(path) {
    if (rejectRestore && path === original && process.cwd() !== original) {
      rejectRestore = false;
      throw new Error('cwd-restore-secret');
    }
    return originalChdir.call(process, path);
  };
  try {
    await assert.rejects(() => collectEvidenceBundle(evidenceInput(f, {
      artifacts: [{ id: 'missing-report', type: 'report', path: 'artifacts/missing.json', testId: 'e2e-home' }],
    })), error => {
      assert.equal(error.name, 'EvidenceCollectionError');
      assert.doesNotMatch(error.message, /cwd-restore-secret/);
      return true;
    });
  } finally {
    process.chdir = originalChdir;
    originalChdir.call(process, original);
  }

  const originalCwd = process.cwd;
  process.cwd = function hostileCwd() { throw new Error('cwd-capture-secret'); };
  try {
    await assert.rejects(() => collectEvidenceBundle(evidenceInput(f)), error => {
      assert.equal(error.name, 'EvidenceCollectionError');
      assert.doesNotMatch(error.message, /cwd-capture-secret/);
      return true;
    });
  } finally {
    process.cwd = originalCwd;
  }
});
