import { isAbsolute, resolve } from 'node:path';

export function parsePackageSmokeOptions(args) {
  if (args.length === 0) return { mode: 'checkout' };
  const values = {};
  for (const arg of args) {
    const match = /^--(artifact-dir|source-sha|artifact-sha256|tag|report)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error('Invalid package smoke arguments.');
    values[match[1]] = match[2];
  }
  for (const key of ['artifact-dir', 'source-sha', 'artifact-sha256', 'tag', 'report']) {
    if (!values[key]) throw new Error('External artifact smoke requires directory, source SHA, artifact checksum, tag and report.');
  }
  if (!/^[a-f0-9]{40}$/.test(values['source-sha']) || !/^[a-f0-9]{64}$/.test(values['artifact-sha256']) ||
      !/^v\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(values.tag)) throw new Error('Invalid artifact identity.');
  for (const key of ['artifact-dir', 'report']) {
    if (!isAbsolute(values[key]) || resolve(values[key]) !== values[key] || /[\x00-\x1f\x7f]/.test(values[key])) throw new Error('Artifact paths must be absolute and normalized.');
  }
  return { mode: 'artifact', directory: values['artifact-dir'], expectedSourceSha: values['source-sha'],
    expectedArtifactSha256: values['artifact-sha256'], tag: values.tag, report: values.report };
}
