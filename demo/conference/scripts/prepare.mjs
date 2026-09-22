import { fileURLToPath } from 'node:url';

import {
  exactRepository,
  fail,
  regularFile,
  repositoryHead,
  trackedClean,
} from './shared.mjs';

const PLATFORM_FILES = Object.freeze([
  'demo/conference/goal-graph.yaml',
  'demo/conference/authority.yaml',
  'demo/conference/completion-profile.yaml',
  'demo/conference/fixtures/jira/issues.json',
  'demo/conference/fixtures/confluence/pages.json',
]);
const APPLICATION_FILES = Object.freeze([
  'package.json',
  'bitbucket-pipelines.yml',
  '.rivet/acceptance.yaml',
  'design/design-system-manifest.json',
]);

export async function prepareConferenceDemo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('prepare-input');
  const minimumNodeMajor = input.minimumNodeMajor ?? 22;
  if (!Number.isSafeInteger(minimumNodeMajor) || minimumNodeMajor < 18 || minimumNodeMajor > 100) fail('node-version');
  const currentNodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(currentNodeMajor) || currentNodeMajor < minimumNodeMajor) fail('node-version');

  const platformRoot = await exactRepository(input.platformRoot);
  const applicationRoot = await exactRepository(input.applicationRoot);
  if (platformRoot === applicationRoot) fail('repository-separation');
  await trackedClean(platformRoot);
  await trackedClean(applicationRoot);
  for (const relativePath of PLATFORM_FILES) await regularFile(platformRoot, relativePath);
  for (const relativePath of APPLICATION_FILES) await regularFile(applicationRoot, relativePath);

  return Object.freeze({
    ready: true,
    mode: 'local-fixture',
    platformCommit: await repositoryHead(platformRoot),
    applicationCommit: await repositoryHead(applicationRoot),
    nodeMajor: currentNodeMajor,
  });
}

async function main() {
  const [platformRoot, applicationRoot] = process.argv.slice(2);
  const result = await prepareConferenceDemo({ platformRoot, applicationRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('Conference preparation failed.\n');
    process.exitCode = 1;
  });
}

