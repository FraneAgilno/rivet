import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;

export class EvidenceChecksumError extends Error {
  constructor(reason = 'invalid-file') {
    const messages = {
      'invalid-file': 'Evidence checksum input must be a bounded regular file.',
      'file-changed': 'Evidence file changed while its checksum was calculated.',
    };
    super(messages[reason] ?? messages['invalid-file']);
    this.name = 'EvidenceChecksumError';
    this.code = 'ERR_EVIDENCE_CHECKSUM';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new EvidenceChecksumError(reason); }

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileLimit(options) {
  let keys;
  try { keys = Reflect.ownKeys(options); } catch { fail('invalid-file'); }
  if (keys.some(key => key !== 'maxBytes')) fail('invalid-file');
  let value = DEFAULT_MAX_BYTES;
  if (keys.includes('maxBytes')) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(options, 'maxBytes'); } catch { fail('invalid-file'); }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-file');
    value = descriptor.value;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BYTES) fail('invalid-file');
  return value;
}

export function sha256(value) {
  if (typeof value !== 'string' && !ArrayBuffer.isView(value)) {
    throw new EvidenceChecksumError('invalid-file');
  }
  return createHash('sha256').update(value).digest('hex');
}

export async function readFileWithChecksum(path, options = {}) {
  const maxBytes = fileLimit(options);
  if (typeof path !== 'string' || path.length < 2 || path.length > 1_024
    || !isAbsolute(path) || /[\u0000\r\n]/.test(path)) fail('invalid-file');
  let before;
  try { before = await lstat(path, { bigint: true }); } catch { fail('invalid-file'); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 0n || before.size > BigInt(maxBytes)) fail('invalid-file');

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) fail('file-changed');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || bytes.byteLength !== Number(after.size)) fail('file-changed');
    const current = await lstat(path, { bigint: true });
    if (current.isSymbolicLink() || !sameFile(after, current)) fail('file-changed');
    return Object.freeze({
      bytes,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  } catch (error) {
    if (error instanceof EvidenceChecksumError) throw error;
    fail('invalid-file');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function checksumFile(path, options = {}) {
  const result = await readFileWithChecksum(path, options);
  return Object.freeze({ sha256: result.sha256, bytes: result.size });
}
