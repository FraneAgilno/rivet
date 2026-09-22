#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const provider = basename(process.argv[1]).includes('codex') ? 'codex' : 'claude';
const version = provider === 'codex' ? 'codex-cli 0.148.0-alpha.9' : '2.1.207 (Claude Code)';
const logPath = process.env.TMPDIR ? join(process.env.TMPDIR, 'rivet-fake-client.log') : null;
const record = value => { if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`); };
process.on('uncaughtException', error => { record({ provider, failure: error.name, message: error.message }); process.exit(70); });
process.on('unhandledRejection', error => { record({ provider, failure: error?.name ?? 'Error', message: error?.message ?? 'rejection' }); process.exit(71); });
if (process.argv[2] === '--version') {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

const args = process.argv.slice(2);
const mode = provider === 'codex'
  ? args[args.indexOf('--sandbox') + 1]
  : args[args.indexOf('--permission-mode') + 1];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const planning = payload.kind === 'agilno.feature-planning';
const expectedMode = planning ? (provider === 'codex' ? 'read-only' : 'dontAsk')
  : (provider === 'codex' ? 'workspace-write' : 'acceptEdits');
if (mode !== expectedMode) process.exit(41);
if (planning && provider === 'claude') {
  if (args[args.indexOf('--tools') + 1] !== 'Read,Glob,Grep'
    || !args[args.indexOf('--json-schema') + 1]?.includes('agilno.feature-decomposition')) process.exit(45);
}
record({ provider, mode, kind: payload.kind });

if (planning) {
  if (payload.resultContract?.kind !== 'agilno.feature-decomposition'
    || payload.resultContract?.schema?.properties?.kind?.const !== 'agilno.feature-decomposition') process.exit(44);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement the approved recording agenda feature.',
        ownedPaths: ['app/agenda.js'],
        acceptanceCriterionIndexes: [1],
      },
    ],
  })}\n`);
  process.exit(0);
}

const contract = payload.contract;
for (const relative of contract.ownedPaths) {
  const target = join(process.cwd(), relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "export const recordingAgenda = 'ready';\n");
}
const git = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find(existsSync);
const run = args => spawnSync(git, args, { cwd: process.cwd(), encoding: 'utf8' });
let result = run(['add', '--', ...contract.ownedPaths]);
if (result.status !== 0) process.exit(42);
result = run(['-c', 'user.name=Fixture Worker', '-c', 'user.email=worker@example.invalid', 'commit', '--quiet', '-m', `implement ${contract.nodeId}`]);
if (result.status !== 0) process.exit(43);
process.stdout.write(`${JSON.stringify({
  version: 1,
  status: 'success',
  output: { summary: `Completed ${contract.nodeId}.`, evidence: contract.evidence },
  usage: { tokens: 10, costUsd: 0 },
})}\n`);
