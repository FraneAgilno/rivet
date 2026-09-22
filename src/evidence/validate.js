import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { validateEvidence as validateCanonicalEvidence } from '../config/validate.js';
import { sha256 } from './checksum.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function array(value, maximum) { return Array.isArray(value) && value.length <= maximum; }
function id(value) { return typeof value === 'string' && value.length <= 64 && ID.test(value); }
function sha(value) { return typeof value === 'string' && SHA.test(value); }
function checksum(value) { return typeof value === 'string' && SHA256.test(value); }
function timestamp(value) {
  return typeof value === 'string' && ISO.test(value)
    && Number.isSafeInteger(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function captureOptions(value) {
  if (!record(value)) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.some(key => typeof key !== 'string' || key !== 'runDirectory')) return null;
  const output = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function persistedFile(root, relativePath, maximumBytes) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)
    || relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid persisted path');
  }
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(root + sep)) throw new Error('invalid persisted path');
  let cursor = root;
  for (const part of relativePath.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    const directory = lstatSync(cursor, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe persisted directory');
  }
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error('unsafe persisted file');
  let descriptor;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) throw new Error('persisted file changed');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.length)) throw new Error('persisted file changed');
    const current = lstatSync(absolute, { bigint: true });
    if (!sameIdentity(after, current) || current.isSymbolicLink()) throw new Error('persisted file changed');
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function validatePersisted(manifest, runDirectory, errors) {
  if (typeof runDirectory !== 'string' || !isAbsolute(runDirectory) || resolve(runDirectory) !== runDirectory) {
    errors.push('Persisted evidence validation context is invalid.');
    return;
  }
  const before = lstatSync(runDirectory, { bigint: true });
  const canonical = realpathSync(runDirectory);
  const after = lstatSync(runDirectory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, after) || canonical !== runDirectory) {
    errors.push('Persisted evidence directory identity is invalid.');
    return;
  }
  const rootEntries = readdirSync(runDirectory, { withFileTypes: true });
  if (rootEntries.length < 3 || rootEntries.length > 4
    || rootEntries.some(entry => entry.isSymbolicLink())) {
    errors.push('Persisted evidence directory contains an unexpected entry.');
  }
  const rootByName = new Map(rootEntries.map(entry => [entry.name, entry]));
  const publicationExists = rootByName.has('publication.json');
  const expectedRootNames = new Set(['artifacts', 'manifest.json', 'qa-bundle.json', ...(publicationExists ? ['publication.json'] : [])]);
  if (rootByName.size !== rootEntries.length || rootByName.size !== expectedRootNames.size
    || [...rootByName.keys()].some(name => !expectedRootNames.has(name))
    || !rootByName.get('artifacts')?.isDirectory()
    || !rootByName.get('manifest.json')?.isFile() || !rootByName.get('qa-bundle.json')?.isFile()
    || (publicationExists && !rootByName.get('publication.json')?.isFile())) {
    errors.push('Persisted evidence directory file set is invalid.');
  }
  const artifactNames = manifest.artifacts.map(artifact => {
    const parts = artifact.path.split('/');
    if (parts.length !== 2 || parts[0] !== 'artifacts') throw new Error('invalid artifact path');
    return parts[1];
  });
  const artifactEntries = readdirSync(join(runDirectory, 'artifacts'), { withFileTypes: true });
  const expectedArtifactNames = new Set(artifactNames);
  if (expectedArtifactNames.size !== artifactNames.length || artifactEntries.length !== expectedArtifactNames.size
    || artifactEntries.some(entry => entry.isSymbolicLink() || !entry.isFile() || !expectedArtifactNames.has(entry.name))) {
    errors.push('Persisted artifact directory file set is invalid.');
  }
  const expectedManifest = JSON.stringify(manifest, null, 2) + '\n';
  const manifestBytes = persistedFile(runDirectory, 'manifest.json', 8 * 1024 * 1024);
  if (!manifestBytes.equals(Buffer.from(expectedManifest))) errors.push('Persisted manifest bytes do not match the validated manifest.');
  const archiveBytes = persistedFile(runDirectory, 'qa-bundle.json', 128 * 1024 * 1024);
  let archive;
  try { archive = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(archiveBytes)); }
  catch { errors.push('Persisted archive is invalid.'); return; }
  if (!record(archive) || archive.schemaVersion !== 1 || archive.runId !== manifest.runId
    || archive.commitSha !== manifest.commitSha || !array(archive.files, 257)) {
    errors.push('Persisted archive identity is invalid.');
    return;
  }
  const canonicalFiles = [];
  for (const artifact of manifest.artifacts) {
    const bytes = persistedFile(runDirectory, artifact.path, 128 * 1024 * 1024);
    const actualChecksum = sha256(bytes);
    if (artifact.sha256 !== actualChecksum || artifact.bytes !== bytes.length) {
      errors.push('Persisted evidence file checksum is invalid.');
    }
    canonicalFiles.push({
      path: artifact.path, sha256: actualChecksum, bytes: bytes.length, contentBase64: bytes.toString('base64'),
    });
  }
  canonicalFiles.push({
    path: 'manifest.json', sha256: sha256(manifestBytes), bytes: manifestBytes.length,
    contentBase64: manifestBytes.toString('base64'),
  });
  canonicalFiles.sort((left, right) => left.path.localeCompare(right.path));
  const canonicalArchive = JSON.stringify({
    schemaVersion: 1, runId: manifest.runId, commitSha: manifest.commitSha, files: canonicalFiles,
  }) + '\n';
  if (!archiveBytes.equals(Buffer.from(canonicalArchive))) {
    errors.push('Persisted archive bytes do not match the canonical evidence reconstruction.');
  }
  if (publicationExists) {
    const publicationBytes = persistedFile(runDirectory, 'publication.json', 64 * 1024);
    let publication;
    try { publication = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(publicationBytes)); }
    catch { errors.push('Persisted publication attestation is invalid.'); return; }
    const keys = record(publication) ? Object.keys(publication).sort() : [];
    if (!record(publication)
      || keys.join(',') !== 'approvalReceiptId,approverId,approverPrincipal,checksum,remoteUrl,status'
      || publication.status !== 'published' || !httpsUrl(publication.remoteUrl)
      || publication.checksum !== sha256(archiveBytes) || !id(publication.approvalReceiptId)
      || !id(publication.approverId) || publication.approverPrincipal !== 'human'
      || !publicationBytes.equals(Buffer.from(JSON.stringify(publication, null, 2) + '\n'))) {
      errors.push('Persisted publication is not bound to the exact archive checksum and approval.');
    }
  }
  const final = lstatSync(runDirectory, { bigint: true });
  if (!sameIdentity(before, final) || final.isSymbolicLink() || realpathSync(runDirectory) !== runDirectory) {
    errors.push('Persisted evidence directory changed during validation.');
  }
}

function validateGate(gate, manifest, errors) {
  if (!record(gate) || !id(gate.id) || !['passed', 'failed'].includes(gate.status)
    || typeof gate.required !== 'boolean' || gate.commitSha !== manifest.commitSha
    || !timestamp(gate.startedAt) || !timestamp(gate.endedAt) || Date.parse(gate.endedAt) < Date.parse(gate.startedAt)
    || typeof gate.cwd !== 'string' || !record(gate.command) || typeof gate.command.executable !== 'string'
    || !Array.isArray(gate.command.args) || gate.command.args.some(arg => typeof arg !== 'string')
    || !Number.isInteger(gate.exitCode) || !record(gate.output) || !array(gate.artifacts, 256)
    || gate.artifacts.some(artifact => !record(artifact) || typeof artifact.path !== 'string'
      || !checksum(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) {
    errors.push('A quality gate lacks deterministic command provenance.');
    return;
  }
  if ((gate.status === 'passed' && (gate.exitCode !== 0 || gate.executionStatus !== 'success'))
    || (gate.status === 'failed' && gate.exitCode === 0 && gate.executionStatus === 'success')) {
    errors.push('Quality gate status contradicts its deterministic exit provenance.');
  }
}

export function validateEvidenceManifest(manifest, options = {}) {
  const errors = [];
  try {
    const configured = captureOptions(options);
    if (!configured) return { valid: false, errors: ['Evidence validation context is invalid.'] };
    if (!record(manifest) || manifest.schemaVersion !== 1 || !id(manifest.runId)
      || manifest.status !== 'complete' || !sha(manifest.commitSha) || !timestamp(manifest.createdAt)
      || !checksum(manifest.preapprovalContentHash)) {
      return { valid: false, errors: ['Manifest identity or commit provenance is invalid.'] };
    }
    if (!array(manifest.gates, 64) || manifest.gates.length === 0) errors.push('At least one quality gate is required.');
    else {
      for (const gate of manifest.gates) validateGate(gate, manifest, errors);
      if (new Set(manifest.gates.map(gate => String(gate?.id).toLowerCase())).size !== manifest.gates.length) {
        errors.push('Quality gate identifiers must be unique.');
      }
      if (manifest.gates.some(gate => gate.required && gate.status !== 'passed')) errors.push('Every required quality gate must pass.');
    }

    const traceability = manifest.traceability;
    if (!record(traceability) || traceability.valid !== true || !array(traceability.coverage, 10_000)
      || traceability.coverage.length === 0 || !array(traceability.errors, 10_000) || traceability.errors.length !== 0) {
      errors.push('Acceptance traceability is incomplete.');
    }
    if (!array(manifest.contexts, 10_000) || manifest.contexts.length === 0) {
      errors.push('Route, persona, viewport, Figma version, and preview context are required.');
    } else {
      for (const context of manifest.contexts) {
        if (!record(context) || !id(context.testId)
          || typeof context.route !== 'string' || !context.route.startsWith('/') || context.route.length > 500
          || !id(context.persona) || !record(context.viewport)
          || !Number.isSafeInteger(context.viewport.width) || context.viewport.width < 200 || context.viewport.width > 10_000
          || !Number.isSafeInteger(context.viewport.height) || context.viewport.height < 200 || context.viewport.height > 10_000
          || typeof context.figmaVersion !== 'string' || context.figmaVersion.length < 1 || context.figmaVersion.length > 200
          || !httpsUrl(context.previewUrl)) {
          errors.push('Evidence execution context is invalid.');
          break;
        }
      }
    }

    const contextTestIds = new Set(array(manifest.contexts, 10_000) ? manifest.contexts.filter(record).map(context => context.testId) : []);
    const gateIds = new Set(array(manifest.gates, 64) ? manifest.gates.filter(record).map(gate => gate.id) : []);
    const passedGateIds = new Set(array(manifest.gates, 64)
      ? manifest.gates.filter(gate => record(gate) && gate.status === 'passed').map(gate => gate.id) : []);
    if (record(traceability) && array(traceability.coverage, 10_000)) {
      for (const coverage of traceability.coverage) {
        if (!record(coverage) || !['test', 'manual-review'].includes(coverage.method) || !id(coverage.evidenceId)
          || (coverage.method === 'test' && (!contextTestIds.has(coverage.evidenceId)
            || !gateIds.has(coverage.gateId) || !passedGateIds.has(coverage.gateId)
            || typeof coverage.resultPath !== 'string' || !checksum(coverage.resultSha256)
            || !manifest.gates.some(gate => gate.id === coverage.gateId
              && gate.artifacts.some(artifact => artifact.path === coverage.resultPath
                && artifact.sha256 === coverage.resultSha256))
            || !manifest.artifacts.some(artifact => artifact.sourcePath === coverage.resultPath
              && artifact.sha256 === coverage.resultSha256)))) {
          errors.push('Traceability evidence is not linked to its authenticated gate result and execution context.');
          break;
        }
      }
    }

    if (!array(manifest.artifacts, 256) || manifest.artifacts.length === 0) errors.push('Evidence artifacts are required.');
    else {
      const types = new Set();
      for (const artifact of manifest.artifacts) {
        if (!record(artifact) || !id(artifact.id) || !id(artifact.testId)
          || !['screenshot', 'playwright-report', 'trace', 'report'].includes(artifact.type)
          || typeof artifact.sourcePath !== 'string' || isAbsolute(artifact.sourcePath)
          || artifact.sourcePath.includes('\\') || artifact.sourcePath.split('/').some(part => !part || part === '.' || part === '..')
          || typeof artifact.path !== 'string' || !artifact.path.startsWith('artifacts/')
          || !checksum(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)
          || artifact.bytes < 0 || artifact.bytes > 128 * 1024 * 1024 || !contextTestIds.has(artifact.testId)
          || (artifact.type === 'screenshot' ? artifact.mediaType !== 'image/png' : artifact.mediaType !== undefined)) {
          errors.push('Evidence artifact metadata, checksum, or test binding is invalid.');
          break;
        }
        const coverage = manifest.traceability.coverage.find(entry => entry.method === 'test' && entry.evidenceId === artifact.testId);
        const gate = manifest.gates.find(entry => entry.id === coverage?.gateId && entry.status === 'passed');
        if (!gate?.artifacts.some(entry => entry.path === artifact.sourcePath
          && entry.sha256 === artifact.sha256 && entry.bytes === artifact.bytes)) {
          errors.push('Evidence artifact is not bound to an authenticated gate artifact.');
          break;
        }
        types.add(artifact.type);
      }
      if (new Set(manifest.artifacts.map(artifact => String(artifact?.id).toLowerCase())).size !== manifest.artifacts.length
        || new Set(manifest.artifacts.map(artifact => String(artifact?.path).toLowerCase())).size !== manifest.artifacts.length) {
        errors.push('Evidence artifact identifiers and paths must be unique.');
      }
      if (!types.has('screenshot')) errors.push('A screenshot is required.');
      if (!types.has('playwright-report')) errors.push('A Playwright report is required.');
    }

    if (!array(manifest.reviews, 256) || manifest.reviews.length === 0
      || !manifest.reviews.some(review => record(review) && review.required === true)
      || manifest.reviews.some(review => !record(review) || !id(review.id) || !id(review.reviewerId)
        || typeof review.required !== 'boolean' || review.status !== 'approved'
        || !id(review.approvalReceiptId) || !['human', 'agent'].includes(review.approverPrincipal)
        || !checksum(review.contentHash))) errors.push('Every required review must have an authenticated content binding.');
    if (!record(manifest.finalApproval) || !id(manifest.finalApproval.approvalReceiptId)
      || !id(manifest.finalApproval.approverId) || manifest.finalApproval.approverPrincipal !== 'human'
      || manifest.finalApproval.decision !== 'approved' || !checksum(manifest.finalApproval.contentHash)) {
      errors.push('Exact content-bound human final approval is required.');
    }

    const core = {
      schemaVersion: 1, runId: manifest.runId, graphId: manifest.evidence?.graphId, commitSha: manifest.commitSha,
      gates: manifest.gates, traceability: manifest.traceability, contexts: manifest.contexts, artifacts: manifest.artifacts,
    };
    const reviewContentHash = sha256(JSON.stringify(core));
    if (manifest.reviews.some(review => review.contentHash !== reviewContentHash)) {
      errors.push('Review approvals are not bound to the canonical evidence content.');
    }
    const preapprovalContentHash = sha256(JSON.stringify({ core, reviews: manifest.reviews }));
    if (manifest.preapprovalContentHash !== preapprovalContentHash
      || manifest.finalApproval?.contentHash !== preapprovalContentHash) {
      errors.push('Final approval is not bound to the canonical preapproval content.');
    }

    try {
      validateCanonicalEvidence(manifest.evidence);
      const evidenceItems = new Map(manifest.evidence.items.map(item => [item.id, item]));
      const commitItem = manifest.evidence.items.find(item => item.type === 'commit');
      if (manifest.evidence.id !== manifest.runId || !commitItem || commitItem.source.commit !== manifest.commitSha
        || manifest.evidence.publicationState !== (manifest.durablyPublished ? 'approved' : 'draft')) {
        errors.push('Canonical evidence ledger is not bound to this manifest.');
      }
      for (const artifact of manifest.artifacts ?? []) {
        const item = evidenceItems.get(artifact.id);
        const expectedType = artifact.type === 'screenshot' ? 'screenshot' : 'report';
        if (!item || item.type !== expectedType || item.location !== artifact.path || item.checksum !== 'sha256:' + artifact.sha256) {
          errors.push('Artifact checksum is not bound to the canonical evidence ledger.');
          break;
        }
      }
      for (const review of manifest.reviews ?? []) {
        const item = evidenceItems.get(review.id);
        if (!item || item.type !== 'review' || item.approvalState !== review.status) {
          errors.push('Review is not bound to the canonical evidence ledger.');
          break;
        }
      }
      const approvalItem = evidenceItems.get(manifest.finalApproval?.approvalReceiptId);
      if (!approvalItem || approvalItem.type !== 'human-approval'
        || approvalItem.producer.id !== manifest.finalApproval.approverId
        || approvalItem.approval.actorId !== manifest.finalApproval.approverId
        || approvalItem.approval.decision !== 'approved') errors.push('Final approval is not bound to the canonical evidence ledger.');
      for (const coverage of manifest.traceability?.coverage ?? []) {
        const item = evidenceItems.get(coverage.evidenceId);
        if (!item || (coverage.method === 'test' && (item.type !== 'test' || item.details.status !== 'passed'))
          || (coverage.method === 'manual-review' && item.type !== 'review')) {
          errors.push('Traceability is not bound to the canonical evidence ledger.');
          break;
        }
      }
    } catch { errors.push('Canonical evidence ledger is invalid.'); }

    if (!record(manifest.publication) || typeof manifest.durablyPublished !== 'boolean') errors.push('Publication state is invalid.');
    else if (manifest.durablyPublished || manifest.publication.status !== 'local-only') {
      errors.push('The immutable archive manifest must remain local-only; publication is an external checksum attestation.');
    }
    if (Object.hasOwn(configured, 'runDirectory')) validatePersisted(manifest, configured.runDirectory, errors);
  } catch {
    errors.push('Manifest validation failed safely.');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
