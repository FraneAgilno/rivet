import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, sameIdentity } from './shared.mjs';

async function fingerprint(value, maximumBytes) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !/\.(?:mp4|mov|webm)$/i.test(value)) fail('recording-path');
  const absolutePath = path.resolve(value);
  let handle;
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 12 || metadata.size > maximumBytes) fail('recording-file');
    const canonical = await realpath(absolutePath);
    const canonicalMetadata = await lstat(canonical);
    if (!sameIdentity(metadata, canonicalMetadata)) fail('recording-file');
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(metadata, opened) || opened.size !== metadata.size) fail('recording-file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const header = Buffer.alloc(12);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) fail('recording-read');
      if (offset < header.length) buffer.copy(header, offset, 0, Math.min(bytesRead, header.length - offset));
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extension = path.extname(absolutePath).toLowerCase();
    const validContainer = extension === '.webm'
      ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : header.subarray(4, 8).toString('ascii') === 'ftyp';
    if (!validContainer) fail('recording-container');
    const finalMetadata = await handle.stat();
    if (!sameIdentity(opened, finalMetadata) || finalMetadata.size !== opened.size) fail('recording-changed');
    return { bytes: opened.size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error?.code === 'ERR_CONFERENCE_DEMO_INVALID') throw error;
    fail('recording-read');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { fail('recording-close'); }
    }
  }
}

export async function verifyRecording(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('recording-input');
  const maximumBytes = input.maximumBytes ?? 4 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 12) fail('recording-bound');
  const primary = await fingerprint(input.recordingPath, maximumBytes);
  const backup = await fingerprint(input.backupPath, maximumBytes);
  if (path.resolve(input.recordingPath) === path.resolve(input.backupPath) || primary.bytes !== backup.bytes || primary.sha256 !== backup.sha256) fail('recording-backup');
  return Object.freeze({ verified: true, bytes: primary.bytes, sha256: primary.sha256, createdByTool: false });
}

async function main() {
  const [recordingPath, backupPath] = process.argv.slice(2);
  const result = await verifyRecording({ recordingPath, backupPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('Conference recording verification failed.\n');
    process.exitCode = 1;
  });
}
