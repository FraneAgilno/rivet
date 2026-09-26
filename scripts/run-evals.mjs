import { spawn } from 'node:child_process';
import { readFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { catalog } from '../evals/catalog.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const IDS = new Set(catalog.scenarios.map(s => s.id));
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 1024 * 1024;
function invalid() { throw new Error('Invalid evaluation arguments or manifest. Use --mode=fixture [--scenario=<known-id>] [--json].'); }
export function parseArguments(args) {
  const result = { mode: 'fixture', json: false };
  const seen = new Set();
  for (const arg of args) {
    const [key, ...parts] = arg.split('=');
    if (seen.has(key)) invalid();
    seen.add(key);
    if (key === '--json' && parts.length === 0) result.json = true;
    else if (key === '--mode' && parts.length === 1 && ['fixture', 'live'].includes(parts[0])) result.mode = parts[0];
    else if (key === '--scenario' && parts.length === 1 && IDS.has(parts[0])) result.scenario = parts[0];
    else invalid();
  }
  return result;
}
export function validateManifest(value) {
  if (!isDeepStrictEqual(value, catalog)) invalid();
  return value;
}

export async function runBounded(command, args, { timeoutMs = TIMEOUT_MS, cwd = ROOT, env = process.env, signal } = {}) {
  const start = performance.now();
  return new Promise(resolvePromise => {
    let child;
    let output = '';
    let bytes = 0;
    let reason = null;
    let settled = false;
    let timer;
    let finalizationTimer;
    let cleanup = 'not-required';
    const kill = why => {
      if (reason) return;
      reason = why;
      cleanup = 'uncertain';
      // A descendant can escape the process group and retain inherited pipes.
      // Bound our wait independently of close; killing the group cannot prove
      // every descendant stopped. Never present this as confirmed cleanup.
      finalizationTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish();
      }, 100);
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const finish = (code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(finalizationTimer);
      signal?.removeEventListener('abort', abort);
      resolvePromise({ exitCode: code, reason, cleanup, durationMs: Math.round(performance.now() - start), ...(reason ? {} : { stdout: output }) });
    };
    const abort = () => kill('cancelled');
    if (signal?.aborted) { reason = 'cancelled'; finish(); return; }
    try { child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reason = 'launch-failed'; finish(); return; }
    timer = setTimeout(() => kill('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { if (reason) return; bytes += data.length; if (bytes > MAX_OUTPUT) kill('output-limit'); else output += data.toString('utf8'); });
    child.stderr.on('data', data => { if (reason) return; bytes += data.length; if (bytes > MAX_OUTPUT) kill('output-limit'); });
    child.on('error', () => { reason = 'launch-failed'; finish(); });
    child.on('close', code => finish(code));
  });
}

export function summarizeScenario(scenario, observation) {
  const records = observation.records ?? [];
  const criteria = scenario.criteria.map(criterion => {
    const matches = records.filter(record => record.name === criterion.test);
    return { id: criterion.id, outcome: matches.length === 1 && matches[0].status === 'passed' ? 'passed' : 'failed',
      evidence: { suite: scenario.file, test: criterion.test, observed: matches.length === 1 ? matches[0].status : 'missing-or-duplicate' } };
  });
  const passed = criteria.filter(c => c.outcome === 'passed').length;
  const unexpected = records.some(record => !scenario.criteria.some(c => c.test === record.name));
  return { id: scenario.id, scope: 'fixture-mechanics',
    outcome: observation.exitCode === 0 && !observation.reason && !unexpected && passed === criteria.length ? 'passed' : 'failed',
    reason: observation.reason ?? (unexpected ? 'unexpected-test-evidence' : null),
    durationMs: observation.durationMs, cleanup: observation.cleanup ?? null, criteria,
    testCounts: { expected: criteria.length, observed: records.length, passed: records.filter(r => r.status === 'passed').length,
      failed: records.filter(r => r.status === 'failed').length, skipped: records.filter(r => ['skipped', 'todo'].includes(r.status)).length },
    metrics: { acceptanceCoverage: null, actualGateResults: null, unsupportedClaims: null, humanInterventions: null,
      modelCostUsd: 0, modelDispatches: 0, retries: null },
  };
}

async function loadManifest() {
  const path = join(ROOT, 'evals', 'scenarios.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) invalid();
  return validateManifest(JSON.parse(await readFile(path, 'utf8')));
}
export async function runEvaluations(options, { execute = runBounded, signal } = {}) {
  // Revalidate programmatic options too; no caller-controlled argv or suite paths.
  if (!options || !['fixture', 'live'].includes(options.mode) || (options.scenario !== undefined && !IDS.has(options.scenario))) invalid();
  const base = { schemaVersion: 1, mode: options.mode, liveModelQualityEvaluated: false, pilotEvaluated: false };
  if (options.mode === 'live') return { exitCode: 2, report: { ...base, outcome: 'blocked', reason: 'live-execution-not-implemented',
    requirements: ['Approved built-in harness/model profile', 'Enforceable cost policy and timeout before launch', 'Version, outcome and verification evidence capture', 'Independent pilot participants'],
    scenarios: [], deferred: catalog.deferred } };
  const manifest = await loadManifest();
  const scratch = await mkdtemp(join(tmpdir(), 'rivet-evals-'));
  const environment = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc'),
    npm_config_globalconfig: join(scratch, 'global-npmrc'), npm_config_update_notifier: 'false' };
  try {
    const revision = await execute('git', ['rev-parse', 'HEAD'], { cwd: ROOT, env: environment, timeoutMs: 3000, signal });
    const sourceCommit = /^[a-f0-9]{40,64}\s*$/.test(revision.stdout ?? '') ? revision.stdout.trim() : null;
    const scenarios = [];
    for (const scenario of manifest.scenarios.filter(s => !options.scenario || s.id === options.scenario)) {
      const pattern = `^(?:${scenario.criteria.map(c => c.test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
      const observed = await execute(process.execPath, ['--test', '--test-concurrency=1',
        `--test-reporter=${join(ROOT, 'evals', 'reporter.mjs')}`, `--test-name-pattern=${pattern}`, scenario.file],
      { cwd: ROOT, env: environment, timeoutMs: TIMEOUT_MS, signal });
      let records = [];
      try {
        records = (observed.stdout ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (records.some(r => !r || typeof r.name !== 'string' || !['passed', 'failed', 'skipped', 'todo'].includes(r.status))) throw new Error();
      } catch { observed.reason = 'invalid-test-report'; records = []; }
      scenarios.push(summarizeScenario(scenario, { ...observed, records }));
      if (signal?.aborted) break;
    }
    const passed = !signal?.aborted && scenarios.every(s => s.outcome === 'passed');
    return { exitCode: passed ? 0 : 1, report: { ...base, sourceCommit, sourceScope: 'current-working-tree',
      outcome: passed ? 'passed' : 'failed', coverage: 'selected named mechanics assertions only',
      scenarios, deferred: manifest.deferred } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const options = parseArguments(process.argv.slice(2));
    const { report, exitCode } = await runEvaluations(options, { signal: controller.signal });
    if (options.json) console.log(JSON.stringify(report));
    else {
      console.log(`Evaluation: ${report.outcome} (${report.mode}; mechanics only).`);
      for (const s of report.scenarios) console.log(`${s.id}: ${s.outcome} (${s.testCounts.passed}/${s.testCounts.expected} named tests).`);
      for (const item of report.deferred) console.log(`${item.id}: ${item.status}.`);
      if (report.requirements) console.log(report.requirements.join('\n'));
      console.log('Live model quality and independent pilot readiness were not evaluated.');
    }
    process.exitCode = exitCode;
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'invalid-evaluation-input-or-environment' }));
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
