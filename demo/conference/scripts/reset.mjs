import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkpointName,
  commitId,
  exactRepository,
  fail,
  git,
  repositoryHead,
  sameIdentity,
  trackedClean,
} from './shared.mjs';

const STATE_ENTRIES = Object.freeze(['events.jsonl', 'instance.json', 'mode.json']);

async function exactChildDirectory(parent, child, { optional = false } = {}) {
  const target = path.join(parent, child);
  try {
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(target) !== target) fail('state-directory');
    return { target, metadata };
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ERR_CONFERENCE_DEMO_INVALID') throw error;
    fail('state-directory');
  }
}

export async function resetConferenceDemo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('reset-input');
  const repositoryRoot = await exactRepository(input.repositoryRoot);
  const checkpoint = checkpointName(input.checkpoint);
  const expectedHead = commitId(input.expectedHead);
  if (input.confirmation !== `RESET conference demo ${checkpoint}`) fail('confirmation');
  await trackedClean(repositoryRoot, { allowDemoState: true });
  const head = await repositoryHead(repositoryRoot);
  if (head !== expectedHead) fail('head-mismatch');
  const checkpointCommit = await git(repositoryRoot, ['show-ref', '--verify', '--hash', `refs/tags/conference-demo/${checkpoint}`], { optional: true });
  if (checkpointCommit !== head) fail('checkpoint-mismatch');

  const demo = await exactChildDirectory(repositoryRoot, 'demo');
  const conference = await exactChildDirectory(demo.target, 'conference');
  const state = await exactChildDirectory(conference.target, '.state', { optional: true });
  const archiveRootPath = path.join(conference.target, '.state-archive');
  if (!state) {
    return Object.freeze({ checkpoint, commit: head, archived: false, archive: `demo/conference/.state-archive/${checkpoint}` });
  }
  const entries = (await readdir(state.target)).sort();
  if (entries.length > STATE_ENTRIES.length || entries.some(entry => !STATE_ENTRIES.includes(entry))) fail('state-entry');
  for (const entry of entries) {
    const metadata = await lstat(path.join(state.target, entry));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) fail('state-entry');
  }
  let archiveRoot;
  try {
    archiveRoot = await exactChildDirectory(conference.target, '.state-archive', { optional: true });
    if (!archiveRoot) {
      await mkdir(archiveRootPath, { mode: 0o700 });
      archiveRoot = await exactChildDirectory(conference.target, '.state-archive');
    }
  } catch (error) {
    if (error?.code === 'ERR_CONFERENCE_DEMO_INVALID') throw error;
    fail('archive-directory');
  }
  const destination = path.join(archiveRoot.target, checkpoint);
  try {
    await lstat(destination);
    fail('archive-exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rename(state.target, destination);
  const archived = await lstat(destination);
  if (!archived.isDirectory() || !sameIdentity(state.metadata, archived)) fail('archive-verification');
  return Object.freeze({ checkpoint, commit: head, archived: true, archive: `demo/conference/.state-archive/${checkpoint}` });
}

async function main() {
  const [repositoryRoot, checkpoint, expectedHead, confirmation] = process.argv.slice(2);
  const result = await resetConferenceDemo({ repositoryRoot, checkpoint, expectedHead, confirmation });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('Conference reset failed.\n');
    process.exitCode = 1;
  });
}
