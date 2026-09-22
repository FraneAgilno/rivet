import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { checkpointName, commitId, exactDirectory, fail } from './shared.mjs';

async function ensureStateDirectory(demoRoot) {
  const stateRoot = path.join(demoRoot, '.state');
  try {
    const metadata = await lstat(stateRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('state-directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(stateRoot, { mode: 0o700 });
  }
  return stateRoot;
}

export async function selectFixtureMode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('mode-input');
  const demoRoot = await exactDirectory(input.demoRoot, 'demo-root');
  const commit = commitId(input.commit);
  let record;
  if (input.mode === 'fixture') {
    record = { schemaVersion: 1, mode: 'fixture', provenance: 'sanitized-read-only-fixtures', commit };
  } else if (input.mode === 'checkpoint') {
    record = { schemaVersion: 1, mode: 'checkpoint', provenance: `git-checkpoint:${checkpointName(input.checkpoint)}`, commit };
  } else if (input.mode === 'recording') {
    if (typeof input.recordingSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.recordingSha256)
      || input.recordingSha256 !== input.backupSha256) fail('recording-proof');
    record = { schemaVersion: 1, mode: 'recording', provenance: `sha256:${input.recordingSha256}`, commit };
  } else {
    fail('unsupported-mode');
  }
  const stateRoot = await ensureStateDirectory(demoRoot);
  const temporary = path.join(stateRoot, `.mode-${randomUUID()}.tmp`);
  const destination = path.join(stateRoot, 'mode.json');
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, destination);
  } catch {
    await rm(temporary, { force: true });
    fail('mode-write');
  }
  return Object.freeze(record);
}

async function main() {
  const [demoRoot, mode, commit, checkpoint] = process.argv.slice(2);
  const result = await selectFixtureMode({ demoRoot, mode, commit, checkpoint });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('Conference fixture mode selection failed.\n');
    process.exitCode = 1;
  });
}

