import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

import { containsSecretMaterial } from '../clients/contract.js';
import { assertGitClient } from '../git/client.js';
import { claimApproval } from '../policy/approvals.js';
import { assertQualityRun } from '../quality/runner.js';
import { assertTraceabilityResult } from '../quality/traceability.js';
import { sha256 } from './checksum.js';
import { validateEvidenceManifest } from './validate.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class EvidenceCollectionError extends Error {
  constructor(reason = 'invalid-evidence-input') {
    const messages = {
      'invalid-evidence-input': 'Evidence collection input is invalid.',
      'unsafe-path': 'Evidence artifact path is unsafe.',
      'approval-required': 'Exact human evidence approval is required.',
      'publication-invalid': 'Durable publication requires an approved HTTPS URL and exact archive checksum.',
      'bundle-exists': 'Evidence run already exists and cannot be overwritten.',
      'bundle-write-failed': 'Evidence bundle could not be written safely.',
    };
    super(messages[reason] ?? messages['invalid-evidence-input']);
    this.name = 'EvidenceCollectionError';
    this.code = 'ERR_EVIDENCE_COLLECTION';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new EvidenceCollectionError(reason); }

function capture(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-evidence-input');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail('invalid-evidence-input'); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail('invalid-evidence-input');
  const result = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail('invalid-evidence-input'); }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-evidence-input');
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail('invalid-evidence-input');
  return result;
}

function array(value, maximum, convert) {
  try {
    if (!Array.isArray(value)) fail('invalid-evidence-input');
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(value).length !== length + 1) fail('invalid-evidence-input');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-evidence-input');
      result.push(convert(descriptor.value));
    }
    return result;
  } catch (error) {
    if (error instanceof EvidenceCollectionError) throw error;
    fail('invalid-evidence-input');
  }
}

function id(value) {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)) fail('invalid-evidence-input');
  return value;
}

function relativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500
    || isAbsolute(value) || value.normalize('NFKC') !== value
    || /[\\:\u0000-\u001f\u007f]/.test(value) || value.startsWith('-')
    || value.endsWith('/') || value.includes('//')) fail('unsafe-path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || WINDOWS_RESERVED.test(part) || part.toUpperCase().toLowerCase() === '.git')) fail('unsafe-path');
  return value;
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
  }
  return value;
}

function jsonSnapshot(value) {
  let seen = 0;
  const active = new WeakSet();
  function visit(child, depth) {
    if (depth > 32 || ++seen > 100_000) fail('invalid-evidence-input');
    if (child === null || typeof child === 'boolean') return child;
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) fail('invalid-evidence-input');
      return child;
    }
    if (typeof child === 'string') {
      if (child.length > 16_384 || containsSecretMaterial(child)) fail('invalid-evidence-input');
      return child;
    }
    if (!child || typeof child !== 'object' || active.has(child)) fail('invalid-evidence-input');
    active.add(child);
    try {
      if (Array.isArray(child)) return array(child, 10_000, item => visit(item, depth + 1));
      const prototype = Object.getPrototypeOf(child);
      if (prototype !== Object.prototype && prototype !== null) fail('invalid-evidence-input');
      const keys = Reflect.ownKeys(child);
      if (keys.length > 10_000 || keys.some(key => typeof key !== 'string')) fail('invalid-evidence-input');
      const output = {};
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(child, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-evidence-input');
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally { active.delete(child); }
  }
  try { return visit(value, 0); }
  catch (error) {
    if (error instanceof EvidenceCollectionError) throw error;
    fail('invalid-evidence-input');
  }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.length > 1_024) fail('unsafe-path');
  try {
    const before = lstatSync(path, { bigint: true });
    const canonical = realpathSync(path);
    const after = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
      || !sameIdentity(before, after) || canonical !== path) fail('unsafe-path');
    return Object.freeze({ path, dev: after.dev, ino: after.ino });
  } catch (error) {
    if (error instanceof EvidenceCollectionError) throw error;
    fail('unsafe-path');
  }
}

function withPinnedDirectory(directory, expected, operation) {
  let original;
  try { original = process.cwd(); } catch { fail('bundle-write-failed'); }
  let changed = false;
  let result;
  let primary = null;
  try {
    process.chdir(directory);
    changed = true;
    const pinned = statSync('.', { bigint: true });
    if (!pinned.isDirectory() || !sameIdentity(pinned, expected)) fail('unsafe-path');
    result = operation();
  } catch (error) {
    primary = error;
  }
  if (changed) {
    try { process.chdir(original); }
    catch (error) { if (primary === null) primary = error; }
  }
  if (primary !== null) {
    if (primary instanceof EvidenceCollectionError) throw primary;
    fail('bundle-write-failed');
  }
  return result;
}

function readPinnedArtifact(project, relative) {
  const components = relative.split('/');
  return withPinnedDirectory(project.path, project, () => {
    for (const component of components.slice(0, -1)) {
      const before = lstatSync(component, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe-path');
      process.chdir(component);
      const pinned = statSync('.', { bigint: true });
      if (!sameIdentity(before, pinned)) fail('unsafe-path');
    }
    const name = components.at(-1);
    const before = lstatSync(name, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 0n || before.size > BigInt(MAX_TOTAL_BYTES)) fail('unsafe-path');
    let descriptor;
    try {
      descriptor = openSync(name, constants.O_RDONLY | NOFOLLOW);
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) fail('unsafe-path');
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.byteLength)) fail('unsafe-path');
      return Object.freeze({ bytes, size: bytes.byteLength, sha256: sha256(bytes) });
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  });
}

function scanSecrets(bytes) {
  const chunkBytes = 512 * 1024;
  const overlap = 4 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes - overlap) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    if (containsSecretMaterial(chunk.toString('latin1')) || containsSecretMaterial(chunk.toString('utf8'))) {
      fail('invalid-evidence-input');
    }
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngPasses(width, height, interlace) {
  if (interlace === 0) return [[width, height]];
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  return passes.map(([x, y, dx, dy]) => [
    width <= x ? 0 : Math.ceil((width - x) / dx),
    height <= y ? 0 : Math.ceil((height - y) / dy),
  ]);
}

function safePngText(type, data) {
  try {
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79) return false;
      scanSecrets(data);
      return true;
    }
    if (type === 'zTXt') {
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79 || separator + 2 > data.length || data[separator + 1] !== 0) return false;
      scanSecrets(data.subarray(0, separator));
      const decoded = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 });
      scanSecrets(decoded);
      return true;
    }
    if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd < 1 || keywordEnd > 79 || keywordEnd + 3 > data.length || ![0, 1].includes(data[keywordEnd + 1])
        || data[keywordEnd + 2] !== 0) return false;
      const languageStart = keywordEnd + 3;
      const languageEnd = data.indexOf(0, languageStart);
      const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
      if (languageEnd < 0 || translatedEnd < 0) return false;
      scanSecrets(data.subarray(0, translatedEnd + 1));
      const encoded = data.subarray(translatedEnd + 1);
      const decoded = data[keywordEnd + 1] === 1
        ? inflateSync(encoded, { maxOutputLength: 1024 * 1024 }) : encoded;
      scanSecrets(decoded);
      return true;
    }
    return true;
  } catch (error) {
    if (error instanceof EvidenceCollectionError) throw error;
    return false;
  }
}

function safePngProfile(data) {
  try {
    const separator = data.indexOf(0);
    if (separator < 1 || separator > 79 || separator + 2 > data.length || data[separator + 1] !== 0) return false;
    scanSecrets(data.subarray(0, separator));
    const decoded = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 });
    if (decoded.length === 0) return false;
    scanSecrets(decoded);
    return true;
  } catch (error) {
    if (error instanceof EvidenceCollectionError) throw error;
    return false;
  }
}

function validPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let first = true;
  let header = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawPlte = false;
  let sawProfile = false;
  const idat = [];
  const safeBinaryAncillary = new Set(['cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'tRNS', 'pHYs', 'tIME']);
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_TOTAL_BYTES || offset + 12 + length > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (first && (type !== 'IHDR' || length !== 13))) return false;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    if (sawIdat && type !== 'IDAT' && type !== 'IEND') idatEnded = true;
    if (type === 'IHDR') {
      if (!first || header !== null) return false;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 10_000 || height > 10_000 || !validDepths[colorType]?.includes(bitDepth)
        || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) return false;
      header = { width, height, bitDepth, colorType, interlace: data[12] };
    } else if (type === 'PLTE') {
      if (!header || sawPlte || sawIdat || [0, 4].includes(header.colorType)
        || length < 3 || length > 768 || length % 3 !== 0
        || (header.colorType === 3 && length / 3 > 2 ** header.bitDepth)) return false;
      sawPlte = true;
    } else if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      if (!safePngText(type, data)) return false;
    } else if (type === 'iCCP') {
      if (sawProfile || sawIdat || !safePngProfile(data)) return false;
      sawProfile = true;
    } else if (type === 'IDAT') {
      if (!header || idatEnded || (header.colorType === 3 && !sawPlte)) return false;
      sawIdat = true;
      idat.push(data);
    } else if (type !== 'IEND') {
      const ancillary = (type.charCodeAt(0) & 0x20) !== 0;
      if (!ancillary || !safeBinaryAncillary.has(type)) return false;
    }
    offset += 12 + length;
    first = false;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !header || !sawIdat) return false;
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
      const bitsPerPixel = channels * header.bitDepth;
      const passes = pngPasses(header.width, header.height, header.interlace);
      const expected = passes.reduce((total, [width, height]) => total
        + (width === 0 || height === 0 ? 0 : height * (1 + Math.ceil(width * bitsPerPixel / 8))), 0);
      if (expected <= 0 || expected > MAX_TOTAL_BYTES) return false;
      let decoded;
      try { decoded = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); }
      catch { return false; }
      if (decoded.length !== expected) return false;
      let decodedOffset = 0;
      for (const [width, height] of passes) {
        if (width === 0 || height === 0) continue;
        const rowBytes = Math.ceil(width * bitsPerPixel / 8);
        for (let row = 0; row < height; row += 1) {
          if (decoded[decodedOffset] > 4) return false;
          decodedOffset += 1 + rowBytes;
        }
      }
      return decodedOffset === decoded.length;
    }
  }
  return false;
}

function validImage(bytes, extension) {
  return extension === '.png' && validPng(bytes);
}

function artifact(value) {
  const input = capture(value, new Set(['id', 'type', 'path', 'testId']), ['id', 'type', 'path', 'testId']);
  if (!['screenshot', 'playwright-report', 'trace', 'report'].includes(input.type)) fail('invalid-evidence-input');
  return Object.freeze({ id: id(input.id), type: input.type, path: relativePath(input.path), testId: id(input.testId) });
}

function reviewInput(value) {
  const input = capture(value, new Set([
    'id', 'reviewerId', 'required', 'expectedApproverId', 'approvalFor',
  ]), ['id', 'reviewerId', 'required', 'expectedApproverId', 'approvalFor']);
  if (typeof input.required !== 'boolean' || typeof input.approvalFor !== 'function') fail('invalid-evidence-input');
  const reviewerId = id(input.reviewerId);
  const expectedApproverId = id(input.expectedApproverId);
  if (reviewerId !== expectedApproverId) fail('invalid-evidence-input');
  return Object.freeze({ id: id(input.id), reviewerId, required: input.required, expectedApproverId, approvalFor: input.approvalFor });
}

function approvalInput(value) {
  const input = capture(value, new Set(['expectedApproverId', 'approvalFor']), ['expectedApproverId', 'approvalFor']);
  if (typeof input.approvalFor !== 'function') fail('invalid-evidence-input');
  return Object.freeze({ expectedApproverId: id(input.expectedApproverId), approvalFor: input.approvalFor });
}

function publicationInput(value) {
  if (value === undefined) return null;
  let input;
  try {
    input = capture(value, new Set(['remoteUrl', 'expectedApproverId', 'approvalFor']), ['remoteUrl', 'expectedApproverId', 'approvalFor']);
  } catch { fail('publication-invalid'); }
  let parsed;
  try { parsed = new URL(input.remoteUrl); } catch { fail('publication-invalid'); }
  if (typeof input.remoteUrl !== 'string' || input.remoteUrl.length > 2_048
    || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || typeof input.approvalFor !== 'function') fail('publication-invalid');
  return Object.freeze({ remoteUrl: input.remoteUrl, expectedApproverId: id(input.expectedApproverId), approvalFor: input.approvalFor });
}

function claimExact(receipt, request, registry, expectedApproverId, nowMs, requireHuman, reason) {
  let claim;
  try {
    claim = claimApproval(receipt, request, {
      registry, expectedApproverId, requireHumanApprover: requireHuman, requireSingleUse: true, nowMs,
    });
  } catch { fail(reason); }
  if (!claim.valid) fail(reason);
  return claim;
}

function invokeApproval(provider, binding, reason) {
  try { return provider(binding); } catch { fail(reason); }
}

function canonicalEvidenceLedger({ runId, graphId, commitSha, createdAt, traceability, prepared, reviews, finalReceipt }) {
  const criteria = [...new Set(traceability.coverage.map(item => item.acceptanceCriterion))].sort();
  const base = (itemId, type, requirementRefs, producer) => ({
    id: itemId, type, requirementRefs, source: { commit: commitSha }, producer, timestamp: createdAt,
    classification: 'internal-redacted', approvalState: 'approved',
  });
  const items = [base('commit', 'commit', criteria, { role: 'system', id: 'quality-runner' })];
  const testCoverage = new Map();
  for (const coverage of traceability.coverage) {
    if (coverage.method === 'test') {
      const requirements = testCoverage.get(coverage.evidenceId) ?? [];
      requirements.push(coverage.acceptanceCriterion);
      testCoverage.set(coverage.evidenceId, requirements);
    } else {
      items.push(base(coverage.evidenceId, 'review', [coverage.acceptanceCriterion], { role: 'human', id: coverage.approverId }));
      items.push({
        ...base(coverage.approvalReceiptId, 'human-approval', [coverage.acceptanceCriterion], { role: 'human', id: coverage.approverId }),
        approval: { actorId: coverage.approverId, decision: 'approved' },
      });
    }
  }
  for (const [evidenceId, requirementRefs] of testCoverage) {
    items.push({
      ...base(evidenceId, 'test', [...new Set(requirementRefs)].sort(), { role: 'system', id: 'quality-runner' }),
      details: { command: 'test', status: 'passed' },
    });
  }
  for (const { item, contents, destination } of prepared) {
    const requirementRefs = traceability.coverage.filter(entry => entry.evidenceId === item.testId).map(entry => entry.acceptanceCriterion);
    items.push({
      ...base(item.id, item.type === 'screenshot' ? 'screenshot' : 'report', requirementRefs, { role: 'system', id: 'quality-runner' }),
      location: destination, checksum: 'sha256:' + contents.sha256,
    });
  }
  for (const review of reviews) items.push(base(review.id, 'review', criteria, { role: 'manager', id: review.reviewerId }));
  items.push({
    ...base(finalReceipt.id, 'human-approval', criteria, { role: 'human', id: finalReceipt.approverId }),
    approval: { actorId: finalReceipt.approverId, decision: 'approved' },
  });
  return { schemaVersion: 1, id: runId, graphId, approvalState: 'approved', publicationState: 'draft', items: items.sort((a, b) => a.id.localeCompare(b.id)) };
}

function writeExclusive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o400);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function assertPublicDirectory(output) {
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(output.path, { bigint: true });
    canonical = realpathSync(output.path);
  } catch { fail('bundle-write-failed'); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameIdentity(metadata, output)
    || canonical !== output.path) fail('bundle-write-failed');
}

function publishAtomically(output, runId, files, claims, manifest) {
  return withPinnedDirectory(output.path, output, () => {
    const stageName = '.' + runId + '.stage-' + randomUUID();
    let stageIdentity;
    let published = false;
    let finalized = false;
    let insideStage = false;
    try {
      try { lstatSync(runId); fail('bundle-exists'); } catch (error) {
        if (error instanceof EvidenceCollectionError) throw error;
        if (error?.code !== 'ENOENT') fail('bundle-write-failed');
      }
      mkdirSync(stageName, { mode: 0o700 });
      stageIdentity = lstatSync(stageName, { bigint: true });
      if (!stageIdentity.isDirectory() || stageIdentity.isSymbolicLink()) fail('bundle-write-failed');
      process.chdir(stageName);
      insideStage = true;
      const pinnedStage = statSync('.', { bigint: true });
      if (!sameIdentity(stageIdentity, pinnedStage)) fail('bundle-write-failed');
      mkdirSync('artifacts', { mode: 0o700 });
      for (const file of files) writeExclusive(file.path, file.bytes);
      process.chdir('..');
      insideStage = false;
      const rootAgain = statSync('.', { bigint: true });
      if (!sameIdentity(rootAgain, output)) fail('bundle-write-failed');
      const stageAgain = lstatSync(stageName, { bigint: true });
      if (!sameIdentity(stageIdentity, stageAgain) || !stageAgain.isDirectory() || stageAgain.isSymbolicLink()) fail('bundle-write-failed');
      assertPublicDirectory(output);
      const persistedValidation = validateEvidenceManifest(manifest, { runDirectory: join(output.path, stageName) });
      if (!persistedValidation.valid) fail('bundle-write-failed');
      for (const claim of claims) if (!claim.finalize()) fail('bundle-write-failed');
      finalized = true;
      renameSync(stageName, runId);
      published = true;
      const finalIdentity = lstatSync(runId, { bigint: true });
      if (!sameIdentity(stageIdentity, finalIdentity) || !finalIdentity.isDirectory() || finalIdentity.isSymbolicLink()) fail('bundle-write-failed');
      assertPublicDirectory(output);
      for (const claim of claims) if (!claim.publish()) fail('bundle-write-failed');
      return join(output.path, runId);
    } catch (error) {
      if (insideStage) {
        try { process.chdir('..'); } catch {}
        insideStage = false;
      }
      if (finalized) for (const claim of claims) claim.rollback();
      else for (const claim of claims) claim.release();
      const residue = published ? runId : stageName;
      try {
        const current = lstatSync(residue, { bigint: true });
        if (stageIdentity && sameIdentity(current, stageIdentity) && current.isDirectory() && !current.isSymbolicLink()) {
          rmSync(residue, { recursive: true });
        }
      } catch {}
      if (error instanceof EvidenceCollectionError) throw error;
      fail('bundle-write-failed');
    }
  });
}

export async function collectEvidenceBundle(input) {
  const value = capture(input, new Set([
    'projectRoot', 'outputRoot', 'runId', 'graphId', 'subjectId', 'approvalRegistry', 'nowMs', 'gitClient',
    'qualityRun', 'traceability', 'contexts', 'artifacts', 'reviews', 'finalApproval', 'publication',
  ]), [
    'projectRoot', 'outputRoot', 'runId', 'graphId', 'subjectId', 'approvalRegistry', 'nowMs', 'gitClient',
    'qualityRun', 'traceability', 'contexts', 'artifacts', 'reviews', 'finalApproval',
  ]);
  const runId = id(value.runId);
  const graphId = id(value.graphId);
  const subjectId = id(value.subjectId);
  if (!Number.isSafeInteger(value.nowMs) || value.nowMs < 0) fail('invalid-evidence-input');
  try {
    assertGitClient(value.gitClient);
    assertQualityRun(value.qualityRun);
    assertTraceabilityResult(value.traceability);
  } catch { fail('invalid-evidence-input'); }
  if (!value.traceability.valid || value.traceability.commitSha !== value.qualityRun.commitSha
    || value.qualityRun.status !== 'pass') fail('invalid-evidence-input');

  const project = canonicalDirectory(value.projectRoot);
  const output = canonicalDirectory(value.outputRoot);
  const projectAlias = project.path.split(sep).map(part => part.normalize('NFKC').toLowerCase()).join(sep);
  const outputAlias = output.path.split(sep).map(part => part.normalize('NFKC').toLowerCase()).join(sep);
  if (outputAlias === projectAlias || outputAlias.startsWith(projectAlias + sep)) fail('unsafe-path');
  if (value.qualityRun.projectRoot !== project.path) fail('invalid-evidence-input');
  let repository;
  try { repository = await value.gitClient.inspectRepository(project.path); } catch { fail('invalid-evidence-input'); }
  if (repository.root !== project.path || repository.headSha !== value.qualityRun.commitSha
    || repository.dirty || repository.dirtyPaths.length !== 0) fail('invalid-evidence-input');

  const contexts = jsonSnapshot(value.contexts);
  const artifacts = array(value.artifacts, 256, artifact);
  const reviewsInput = array(value.reviews, 256, reviewInput);
  if (artifacts.length === 0 || reviewsInput.length === 0
    || !reviewsInput.some(review => review.required)
    || new Set(artifacts.map(item => item.id.toLowerCase())).size !== artifacts.length
    || new Set(reviewsInput.map(item => item.id.toLowerCase())).size !== reviewsInput.length) fail('invalid-evidence-input');
  const finalApproval = approvalInput(value.finalApproval);
  const publication = publicationInput(value.publication);

  const gateArtifacts = new Map();
  for (const gate of value.qualityRun.gates) {
    if (gate.status !== 'passed') continue;
    for (const gateArtifact of gate.artifacts) {
      if (gateArtifact.status === 'missing-or-unsafe' || gateArtifacts.has(gateArtifact.path)) fail('invalid-evidence-input');
      gateArtifacts.set(gateArtifact.path, Object.freeze({ gateId: gate.id, ...gateArtifact }));
    }
  }

  const prepared = [];
  let totalBytes = 0;
  for (const item of [...artifacts].sort((left, right) => left.id.localeCompare(right.id))) {
    const contents = readPinnedArtifact(project, item.path);
    const authoritative = gateArtifacts.get(item.path);
    const coverage = value.traceability.coverage.find(entry => entry.method === 'test' && entry.evidenceId === item.testId);
    if (!authoritative || !coverage || authoritative.gateId !== coverage.gateId
      || authoritative.sha256 !== contents.sha256 || authoritative.bytes !== contents.size) fail('invalid-evidence-input');
    totalBytes += contents.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail('invalid-evidence-input');
    const extension = extname(item.path).toLowerCase();
    if (item.type === 'screenshot') {
      if (!validImage(contents.bytes, extension)) fail('invalid-evidence-input');
      scanSecrets(contents.bytes);
    } else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents.bytes); } catch { fail('invalid-evidence-input'); }
      if (containsSecretMaterial(text)) fail('invalid-evidence-input');
    }
    prepared.push({ item, contents, destination: 'artifacts/' + item.id + (/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin') });
  }
  for (const coverage of value.traceability.coverage) {
    if (coverage.method === 'test' && !prepared.some(entry => entry.item.path === coverage.resultPath
      && entry.contents.sha256 === coverage.resultSha256)) fail('invalid-evidence-input');
  }

  const core = immutable({
    schemaVersion: 1, runId, graphId, commitSha: value.qualityRun.commitSha,
    gates: value.qualityRun.gates, traceability: value.traceability, contexts,
    artifacts: prepared.map(({ item, contents, destination }) => ({
      id: item.id, type: item.type, testId: item.testId, sourcePath: item.path,
      path: destination, sha256: contents.sha256, bytes: contents.size,
      ...(item.type === 'screenshot' ? { mediaType: 'image/png' } : {}),
    })),
  });
  const reviewContentHash = sha256(JSON.stringify(core));
  const claims = [];
  const reviewProofs = [];
  try {
    for (const review of reviewsInput) {
      const receipt = invokeApproval(review.approvalFor, reviewContentHash, 'invalid-evidence-input');
      const claim = claimExact(receipt, {
        subjectId, action: 'quality.review',
        resource: 'evidence:' + runId + ':review:' + review.id + ':sha256:' + reviewContentHash,
        policyId: 'quality.review',
      }, value.approvalRegistry, review.expectedApproverId, value.nowMs, false, 'invalid-evidence-input');
      claims.push(claim);
      reviewProofs.push(immutable({
        id: review.id, reviewerId: receipt.approverId, status: 'approved', required: review.required,
        approvalReceiptId: receipt.id, approverPrincipal: receipt.approverPrincipal, contentHash: reviewContentHash,
      }));
    }
    const preapprovalContentHash = sha256(JSON.stringify({ core, reviews: reviewProofs }));
    const finalReceipt = invokeApproval(finalApproval.approvalFor, preapprovalContentHash, 'approval-required');
    claims.push(claimExact(finalReceipt, {
      subjectId, action: 'quality.complete', resource: 'evidence:' + runId + ':sha256:' + preapprovalContentHash,
      policyId: 'quality.final',
    }, value.approvalRegistry, finalApproval.expectedApproverId, value.nowMs, true, 'approval-required'));

    const createdAt = new Date(value.nowMs).toISOString();
    const evidence = canonicalEvidenceLedger({
      runId, graphId, commitSha: core.commitSha, createdAt, traceability: value.traceability,
      prepared, reviews: reviewProofs, finalReceipt,
    });
    const manifest = immutable({
      ...core, status: 'complete', createdAt, preapprovalContentHash,
      reviews: reviewProofs,
      finalApproval: {
        approvalReceiptId: finalReceipt.id, approverId: finalReceipt.approverId,
        approverPrincipal: finalReceipt.approverPrincipal, decision: 'approved', contentHash: preapprovalContentHash,
      },
      evidence, publication: { status: 'local-only' }, durablyPublished: false,
    });
    const validation = validateEvidenceManifest(manifest);
    if (!validation.valid) fail('invalid-evidence-input');

    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    const manifestChecksum = sha256(manifestText);
    const archiveFiles = [
      ...prepared.map(item => ({
        path: item.destination, sha256: item.contents.sha256, bytes: item.contents.size,
        contentBase64: item.contents.bytes.toString('base64'),
      })),
      {
        path: 'manifest.json', sha256: manifestChecksum, bytes: Buffer.byteLength(manifestText),
        contentBase64: Buffer.from(manifestText).toString('base64'),
      },
    ].sort((left, right) => left.path.localeCompare(right.path));
    const archiveText = JSON.stringify({ schemaVersion: 1, runId, commitSha: core.commitSha, files: archiveFiles }) + '\n';
    const archiveChecksum = sha256(archiveText);

    let publicationRecord = Object.freeze({ status: 'local-only' });
    let publicationText = null;
    if (publication) {
      const receipt = invokeApproval(publication.approvalFor, archiveChecksum, 'publication-invalid');
      claims.push(claimExact(receipt, {
        subjectId, action: 'quality.publish', resource: publication.remoteUrl + '#sha256:' + archiveChecksum,
        policyId: 'quality.publication',
      }, value.approvalRegistry, publication.expectedApproverId, value.nowMs, true, 'publication-invalid'));
      publicationRecord = immutable({
        status: 'published', remoteUrl: publication.remoteUrl, checksum: archiveChecksum,
        approvalReceiptId: receipt.id, approverId: receipt.approverId, approverPrincipal: receipt.approverPrincipal,
      });
      publicationText = JSON.stringify(publicationRecord, null, 2) + '\n';
    }

    let after;
    try { after = await value.gitClient.inspectRepository(project.path); } catch { fail('invalid-evidence-input'); }
    if (after.repositoryId !== repository.repositoryId || after.root !== repository.root
      || after.headSha !== repository.headSha || after.dirty || after.dirtyPaths.length !== 0) fail('invalid-evidence-input');

    const filesToWrite = [
      ...prepared.map(item => ({ path: item.destination, bytes: item.contents.bytes })),
      { path: 'manifest.json', bytes: manifestText }, { path: 'qa-bundle.json', bytes: archiveText },
      ...(publicationText === null ? [] : [{ path: 'publication.json', bytes: publicationText }]),
    ];
    const runDirectory = publishAtomically(output, runId, filesToWrite, claims, manifest);
    return immutable({
      manifest, publication: publicationRecord, durablyPublished: publication !== null,
      runDirectory, manifestPath: join(runDirectory, 'manifest.json'), manifestChecksum,
      archivePath: join(runDirectory, 'qa-bundle.json'), archiveChecksum,
      files: [
        ...archiveFiles.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
        { path: 'qa-bundle.json', sha256: archiveChecksum, bytes: Buffer.byteLength(archiveText) },
        ...(publicationText === null ? [] : [{ path: 'publication.json', sha256: sha256(publicationText), bytes: Buffer.byteLength(publicationText) }]),
      ],
    });
  } catch (error) {
    for (const claim of claims) claim.release();
    if (error instanceof EvidenceCollectionError) throw error;
    fail('invalid-evidence-input');
  }
}
