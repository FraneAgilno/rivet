import { fileURLToPath } from 'node:url';

import {
  checkpointName,
  commitId,
  exactRepository,
  fail,
  git,
  repositoryHead,
  trackedClean,
} from './shared.mjs';

export async function createCheckpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('checkpoint-input');
  const repositoryRoot = await exactRepository(input.repositoryRoot);
  const name = checkpointName(input.name);
  const expectedHead = commitId(input.expectedHead);
  await trackedClean(repositoryRoot);
  const head = await repositoryHead(repositoryRoot);
  if (head !== expectedHead) fail('head-mismatch');
  const ref = `refs/tags/conference-demo/${name}`;
  const existing = await git(repositoryRoot, ['show-ref', '--verify', '--hash', ref], { optional: true });
  if (existing !== null) {
    if (existing !== head) fail('checkpoint-conflict');
    return Object.freeze({ name, ref, commit: head, created: false });
  }
  await git(repositoryRoot, ['update-ref', ref, head, '0'.repeat(40)]);
  if (await git(repositoryRoot, ['show-ref', '--verify', '--hash', ref]) !== head) fail('checkpoint-verification');
  return Object.freeze({ name, ref, commit: head, created: true });
}

async function main() {
  const [repositoryRoot, name, expectedHead] = process.argv.slice(2);
  const result = await createCheckpoint({ repositoryRoot, name, expectedHead });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('Conference checkpoint failed.\n');
    process.exitCode = 1;
  });
}

