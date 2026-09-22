import { execFileSync } from 'node:child_process';

import { CliError, EXIT_CODES } from '../cli/output.js';
import { createStatusServer } from '../status/server.js';

const INSTANCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_FIXTURE_BYTES = 512 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const reflectApply = Reflect.apply;

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function fixturePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')
    || value.startsWith('/') || value.includes('\\') || !/^[a-zA-Z0-9._/-]+$/.test(value)) fail('Status fixture path is invalid.');
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment === '.git')) fail('Status fixture must be a repository-relative tracked file.');
  return value;
}

function runGit(cwd, args, maximum = MAX_FIXTURE_BYTES + 1_024) {
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: null,
    maxBuffer: maximum,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    windowsHide: true,
  });
}

function readFixture(cwd, path) {
  try {
    const commit = runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 256).toString('ascii').trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) fail('Status fixture could not be read.', 'MISSING_CONFIGURATION');
    const entry = runGit(cwd, ['ls-tree', '-z', '--full-tree', commit, '--', path], 4_096);
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/.exec(entry.toString('utf8'));
    if (!match || match[3] !== path) fail('Status fixture could not be read.', 'MISSING_CONFIGURATION');
    const sizeText = runGit(cwd, ['cat-file', '-s', match[2]], 128).toString('ascii').trim();
    if (!/^[1-9][0-9]{0,6}$/.test(sizeText)) fail('Status fixture is invalid.');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > MAX_FIXTURE_BYTES) fail('Status fixture is invalid.');
    const bytes = runGit(cwd, ['cat-file', 'blob', match[2]], MAX_FIXTURE_BYTES + 1);
    if (bytes.length !== size) fail('Status fixture is invalid.');
    return JSON.parse(UTF8.decode(bytes));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Status fixture could not be read.', 'MISSING_CONFIGURATION');
  }
}

function validScript(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return input.version === 1 && ['success', 'retry', 'failed', 'blocked', 'budget-exhausted'].includes(input.kind)
    && input.output && typeof input.output === 'object' && !Array.isArray(input.output)
    && Array.isArray(input.output.evidence) && input.output.evidence.length <= 64
    && input.output.evidence.every(value => typeof value === 'string' && INSTANCE_ID.test(value) && value.length <= 96)
    && input.usage && typeof input.usage === 'object' && !Array.isArray(input.usage)
    && Number.isSafeInteger(input.usage.tokens) && input.usage.tokens >= 0
    && typeof input.usage.costUsd === 'number' && Number.isFinite(input.usage.costUsd) && input.usage.costUsd >= 0;
}

function fixtureState(instanceId, input, nowMs) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1
    || !Array.isArray(input.scripts) || input.scripts.length === 0 || input.scripts.length > 64
    || !input.scripts.every(validScript)) fail('Status fixture has an unsupported shape.');
  const workerNodes = input.scripts.map((script, index) => {
    const id = `fixture-worker-${index + 1}`;
    const status = script.kind === 'success' ? 'completed' : script.kind === 'retry' ? 'corrective' : script.kind;
    return {
      id, parentId: 'manager-plan', owner: { role: 'worker', id: `${id}-owner` }, dependencies: ['manager-plan'],
      requiredEvidenceTypes: script.output.evidence.map(() => 'test'), evidenceRefs: [...script.output.evidence], status,
    };
  });
  const events = input.scripts.map((script, index) => ({
    schemaVersion: 1,
    eventId: `fixture-event-${index + 1}`,
    graphId: instanceId,
    nodeId: `fixture-worker-${index + 1}`,
    sequence: index + 1,
    timestamp: new Date(nowMs - ((input.scripts.length - index) * 1_000)).toISOString(),
    actor: { role: 'worker', id: `fixture-worker-${index + 1}-owner` },
    ...(script.kind === 'retry'
      ? { type: 'retry', retryReason: 'fixture-retry' }
      : { type: 'state-transition', priorState: 'running', newState: workerNodes[index].status }),
  }));
  const evidence = input.scripts.flatMap((script, index) => script.output.evidence.map(id => ({
    id, nodeId: `fixture-worker-${index + 1}`, type: 'test', approvalState: script.kind === 'success' ? 'approved' : 'pending',
  })));
  const tokens = input.scripts.reduce((sum, script) => sum + script.usage.tokens, 0);
  const costUsd = input.scripts.reduce((sum, script) => sum + script.usage.costUsd, 0).toFixed(2);
  return Object.freeze({
    schemaVersion: 1, version: 1, activated: true, terminal: null, startedAtMs: nowMs - (input.scripts.length * 1_000),
    graph: {
      schemaVersion: 1, id: instanceId, status: workerNodes.every(node => node.status === 'completed') ? 'completed' : 'running',
      nodes: [
        { id: 'boss-plan', owner: { role: 'boss', id: 'portfolio-boss' }, dependencies: [], requiredEvidenceTypes: [], evidenceRefs: [], status: 'completed' },
        { id: 'manager-plan', parentId: 'boss-plan', owner: { role: 'manager', id: 'engineering-manager' }, dependencies: ['boss-plan'], requiredEvidenceTypes: [], evidenceRefs: [], status: 'completed' },
        ...workerNodes,
        { id: 'human-final', parentId: 'boss-plan', owner: { role: 'boss', id: 'portfolio-boss' }, dependencies: workerNodes.map(node => node.id), requiredEvidenceTypes: ['human-approval'], evidenceRefs: ['final-approval'], approvalGate: 'final-delivery', status: 'ready' },
      ],
    },
    events, attempts: Object.fromEntries(workerNodes.map(node => [node.id, node.status === 'corrective' ? 2 : 1])),
    launchIntents: {}, heartbeats: {}, evidence,
    usage: { tokens, costUsd, retries: workerNodes.filter(node => node.status === 'corrective').length, timeMinutes: 0, taskLimit: input.scripts.length },
    limits: { tokens: Math.max(tokens, 1), costUsd: String(Math.max(Number(costUsd), 1)), retries: 3, timeMinutes: 60, taskLimit: Math.max(input.scripts.length, 1) },
  });
}

async function readPrivateInstance(instance, options = {}) {
  if (!instance || typeof instance !== 'object' || typeof instance.acquire !== 'function' || typeof instance.read !== 'function') fail('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
  if (options.signal?.aborted) fail('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
  const lock = await instance.acquire({ signal: options.signal });
  if (!lock || typeof lock.release !== 'function') fail('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
  try {
    if (options.signal?.aborted) fail('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
    return await instance.read({ signal: options.signal });
  } finally { await lock.release(); }
}

function serverSurface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || !['start', 'close'].includes(key))) return null;
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return null;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function validAddress(value, requestedPort) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['host', 'port', 'url'].includes(key))) return null;
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy.host === '127.0.0.1' && Number.isSafeInteger(copy.port) && copy.port >= 1 && copy.port <= 65_535
    && (requestedPort === 0 || copy.port === requestedPort)
    && copy.url === `http://127.0.0.1:${copy.port}` ? Object.freeze(copy) : null;
}

async function closeServer(close) {
  try { await Reflect.apply(close, undefined, []); } catch { /* public CLI reports one fixed failure */ }
}

function waitForProcessSignal(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolvePromise => {
    const finish = () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      signal?.removeEventListener?.('abort', finish);
      resolvePromise();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

export async function statusCommand(parsed, dependencies) {
  if (!parsed || parsed.command !== 'status' || parsed.subcommand !== null || !Array.isArray(parsed.operands)
    || parsed.operands.length !== 1 || !INSTANCE_ID.test(parsed.operands[0]) || parsed.operands[0].length > 64
    || !parsed.flags || Object.keys(parsed.flags).some(key => !['fixture', 'port', 'json'].includes(key))) fail('Status requires one explicit orchestration instance ID.');
  const instanceId = parsed.operands[0];
  const portValue = parsed.flags.port ?? '0';
  if (typeof portValue !== 'string' || !/^(?:0|[1-9][0-9]{0,4})$/.test(portValue) || Number(portValue) > 65_535) fail('Status port is invalid.');
  const context = dependencies?.status ?? {};
  const now = typeof context.now === 'function' ? context.now : Date.now;
  let readState;
  if (parsed.flags.fixture !== undefined) {
    const path = fixturePath(parsed.flags.fixture);
    const fixture = readFixture(dependencies.cwd(), path);
    const state = fixtureState(instanceId, fixture, now());
    readState = async () => state;
  } else {
    if (typeof context.resolveInstance !== 'function') fail('Private orchestration is not configured.', 'MISSING_CONFIGURATION');
    const instance = await context.resolveInstance(instanceId);
    if (!instance || instance.id !== instanceId) fail('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
    readState = options => readPrivateInstance(instance, options);
  }
  const factory = typeof context.createServer === 'function' ? context.createServer : createStatusServer;
  let server;
  try {
    server = serverSurface(factory({ readState, now, limits: context.limits, pollIntervalMs: context.pollIntervalMs, readTimeoutMs: context.readTimeoutMs, maxSseClients: context.maxSseClients }));
  } catch { fail('Status server is unavailable.', 'MISSING_CONFIGURATION'); }
  if (!server) fail('Status server is unavailable.', 'MISSING_CONFIGURATION');
  const requestedPort = Number(portValue);
  let address;
  try {
    address = validAddress(await Reflect.apply(server.start, undefined, [{ port: requestedPort }]), requestedPort);
    if (!address) throw new Error('invalid status address');
  } catch {
    await closeServer(server.close);
    fail('Status server is unavailable.', 'MISSING_CONFIGURATION');
  }
  const waitFunction = typeof context.wait === 'function' ? context.wait : waitForProcessSignal;
  const waitReceiver = typeof context.wait === 'function' ? context : undefined;
  const wait = signal => reflectApply(waitFunction, waitReceiver, [signal]);
  if (parsed.flags.json) {
    try {
      dependencies.output.json({ ok: true, command: 'status', instanceId, url: address.url });
      if (typeof dependencies.registerStatusJsonLifecycle !== 'function') throw new Error('missing status lifecycle owner');
      dependencies.registerStatusJsonLifecycle(wait, context.signal, server.close);
    } catch {
      await closeServer(server.close);
      throw new CliError('Status server is unavailable.', 'MISSING_CONFIGURATION');
    }
    return EXIT_CODES.SUCCESS;
  }
  try {
    dependencies.output.log(`Status: ${address.url}`);
    await wait(context.signal);
  } finally { await closeServer(server.close); }
  return EXIT_CODES.SUCCESS;
}
