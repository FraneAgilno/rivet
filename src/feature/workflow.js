import { isAbsolute, relative, resolve, sep } from 'node:path';

import { assertGitClient } from '../git/client.js';
import { immutableJson } from '../clients/contract.js';
import { activeProtocolContextRefs } from '../commands/protocols.js';
import { loadProjectConfig } from '../config/load.js';
import { resolveFeatureRunPaths } from '../state/paths.js';
import { createWorkRequest } from '../work-request/contract.js';
import { resolveInlineWorkRequest, resolveMarkdownWorkRequest } from '../work-request/local.js';
import { resolveHostWorkRequest } from '../work-request/host.js';
import { resolveTrackerWorkRequest } from '../work-request/tracker.js';
import { createFeaturePlan, featurePlanDigest } from './plan-contract.js';
import { createFeaturePlanner, createHostFeaturePlan } from './planner.js';
import { createFeatureRunStore } from './run-store.js';
import { acquireHostRunLock } from './host-run-lock.js';

const INPUT_KEYS = new Set([
  'gitClient', 'planningClientFor', 'trackerAdapterFor', 'executeFeature', 'now', 'loadConfig', 'protocolsFor',
]);
const CLIENTS = new Set(['claude', 'codex', 'host']);
const TRACKERS = new Set(['jira', 'linear']);
const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REF = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROTOCOL_REF = /^protocol:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[1-9][0-9]*:sha256:[a-f0-9]{64}$/;

export class FeatureWorkflowError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Feature workflow input is invalid.',
      'configuration': 'Feature workflow configuration is missing or invalid.',
      'repository': 'Feature workflow requires a clean checked-out default branch.',
      'run-missing': 'Feature run was not found.',
      'state-conflict': 'Feature run state changed or does not permit this operation.',
      'proposal-mismatch': 'Feature activation does not match the exact stored proposal.',
      'execution-result': 'Feature execution returned an invalid bounded result.',
      'host-use-work': 'Host runs use work status and work next; blocked host work requires a new reviewed corrective proposal.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'FeatureWorkflowError';
    this.code = `ERR_FEATURE_WORKFLOW_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new FeatureWorkflowError(reason); }

function capture(input, allowed, required = allowed) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-input');
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || [...required].some(key => !keys.includes(key))) fail('invalid-input');
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-input');
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof FeatureWorkflowError) throw error;
    fail('invalid-input');
  }
}

function absolute(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || !isAbsolute(value)
    || resolve(value) !== value || /[\u0000\r\n]/.test(value)) fail('invalid-input');
  return value;
}

function exactRunId(value) {
  if (typeof value !== 'string' || value.length > 64 || !RUN_ID.test(value)) fail('invalid-input');
  return value;
}

function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid-input');
  return value;
}

function executionSignal(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => key !== 'signal')
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('invalid-input');
  return options.signal;
}

function workerExecutionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => !['signal', 'confirmDependencyInstall'].includes(key))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.confirmDependencyInstall !== undefined && typeof options.confirmDependencyInstall !== 'function')) fail('invalid-input');
  return Object.freeze({
    signal: options.signal,
    ...(options.confirmDependencyInstall ? { confirmDependencyInstall: options.confirmDependencyInstall } : {}),
  });
}

function sourcePath(project, value) {
  const request = absolute(value);
  const path = relative(project, request);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) fail('invalid-input');
  return path.replaceAll(sep, '/');
}

function selectedTracker(config, requested) {
  if (requested !== undefined && !TRACKERS.has(requested)) fail('invalid-input');
  const candidates = config.providers.providers.filter(provider => TRACKERS.has(provider.kind)
    && (provider.transport === undefined || provider.transport === 'direct-api')
    && (!provider.projectIds?.length || provider.projectIds.includes(config.project.id))
    && provider.mode !== 'disabled' && provider.capabilities.includes('issues-read'));
  if (requested !== undefined) {
    if (!candidates.some(provider => provider.kind === requested)) fail('configuration');
    return requested;
  }
  const kinds = [...new Set(candidates.map(provider => provider.kind))];
  if (kinds.length !== 1) fail('configuration');
  return kinds[0];
}

function runIdentifier(plan, request) {
  const suffix = request.digest.slice(0, 12);
  const prefix = plan.id.slice(0, 64 - suffix.length - 1).replace(/-+$/, '');
  return exactRunId(`${prefix}-${suffix}`);
}

function proposalView(record) {
  const profile = record.featurePlan.clientProfile;
  const summary = profile === undefined
    ? `${record.featurePlan.nodes.length} governed nodes; activation and final delivery require human approval.`
    : `${record.featurePlan.nodes.length} governed nodes; Claude ${profile.model}, ${profile.planning.timeoutMs / 1000}s/$${profile.planning.maxCostUsd} planning, $${profile.execution.maxCostUsd} execution cap, no fallback; activation and final delivery require human approval.`;
  return immutableJson({
    runId: record.runId,
    version: record.version,
    status: record.status,
    proposalDigest: record.proposalDigest,
    summary,
    workRequest: record.workRequest,
    featurePlan: record.featurePlan,
  });
}

function lifecycleView(record, summary) {
  return immutableJson({ ...record, ...(summary === undefined ? {} : { summary }) });
}

function executionResult(value) {
  const input = capture(value, new Set(['status', 'summary', 'runtimeRefs', 'evidenceRefs']));
  if (!['blocked', 'awaiting-final-approval'].includes(input.status)
    || typeof input.summary !== 'string' || input.summary.length < 1 || input.summary.length > 4000
    || !Array.isArray(input.runtimeRefs) || !Array.isArray(input.evidenceRefs)
    || input.runtimeRefs.length > 256 || input.evidenceRefs.length > 256
    || [...input.runtimeRefs, ...input.evidenceRefs].some(ref => typeof ref !== 'string' || !REF.test(ref))) {
    fail('execution-result');
  }
  return immutableJson(input);
}

export function createFeatureWorkflow(input) {
  let configured;
  try {
    configured = capture(input, INPUT_KEYS, new Set(['gitClient', 'planningClientFor', 'executeFeature']));
    assertGitClient(configured.gitClient);
  } catch (error) {
    if (error instanceof FeatureWorkflowError) throw error;
    fail('configuration');
  }
  const gitClient = configured.gitClient;
  const planningClientFor = configured.planningClientFor;
  const trackerAdapterFor = configured.trackerAdapterFor;
  const executeFeature = configured.executeFeature;
  const now = configured.now ?? (() => new Date().toISOString());
  const loadConfig = configured.loadConfig ?? loadProjectConfig;
  const protocolsFor = configured.protocolsFor ?? (project => activeProtocolContextRefs(project));
  if (typeof planningClientFor !== 'function' || typeof executeFeature !== 'function'
    || (trackerAdapterFor !== undefined && typeof trackerAdapterFor !== 'function')
    || typeof now !== 'function' || typeof loadConfig !== 'function' || typeof protocolsFor !== 'function') fail('configuration');

  async function repository(project) {
    const root = absolute(project);
    let observed;
    let config;
    try { observed = await gitClient.inspectRepository(root); } catch { fail('repository'); }
    try { config = await loadConfig(root); } catch { fail('configuration'); }
    if (observed.root !== root || observed.detached || observed.dirty
      || observed.branch !== config.project.repository.defaultBranch) fail('repository');
    return { observed, config };
  }

  async function storeFor(project, runId) {
    const paths = await resolveFeatureRunPaths(absolute(project), exactRunId(runId));
    return createFeatureRunStore(paths);
  }

  async function readRun(project, runId) {
    const store = await storeFor(project, runId);
    const record = await store.read();
    if (record === null) fail('run-missing');
    return { store, record };
  }

  async function propose(raw, options = {}) {
    const signal = executionSignal(options);
    const request = capture(
      raw,
      new Set(['project', 'source', 'client', 'tracker', 'decomposition']),
      new Set(['project', 'source']),
    );
    const { observed, config } = await repository(request.project);
    const selectedClient = request.client ?? 'claude';
    if (!CLIENTS.has(selectedClient)) fail('invalid-input');
    const source = capture(request.source, new Set(['kind', 'value']));
    let workRequest;
    if (source.kind === 'inline') {
      workRequest = resolveInlineWorkRequest({ text: source.value, capturedAt: now() });
    } else if (source.kind === 'file') {
      workRequest = await resolveMarkdownWorkRequest({
        root: observed.root, path: sourcePath(observed.root, source.value), capturedAt: now(),
      });
    } else if (source.kind === 'host-observation') {
      if (selectedClient !== 'host') fail('invalid-input');
      workRequest = resolveHostWorkRequest({ config, bundle: source.value, capturedAt: now() });
    } else if (source.kind === 'ticket') {
      if (typeof trackerAdapterFor !== 'function') fail('configuration');
      const provider = selectedTracker(config, request.tracker);
      const adapter = await trackerAdapterFor(immutableJson({ provider, config, project: observed.root }));
      workRequest = await resolveTrackerWorkRequest({ provider, ticketId: source.value, adapter });
    } else fail('invalid-input');
    let protocolRefs;
    try { protocolRefs = await protocolsFor(observed.root); } catch { fail('configuration'); }
    if (!Array.isArray(protocolRefs) || protocolRefs.length > 256
      || protocolRefs.some(ref => typeof ref !== 'string' || !PROTOCOL_REF.test(ref))
      || new Set(protocolRefs).size !== protocolRefs.length) fail('configuration');
    if (protocolRefs.length > 0) {
      workRequest = createWorkRequest({
        source: workRequest.source,
        ...(workRequest.context === undefined ? {} : { context: workRequest.context }),
        title: workRequest.title,
        description: workRequest.description,
        acceptanceCriteria: workRequest.acceptanceCriteria,
        contextRefs: [...workRequest.contextRefs, ...protocolRefs].sort(),
        capturedAt: workRequest.capturedAt,
      });
    }
    if ((selectedClient === 'host') !== (request.decomposition !== undefined)) fail('invalid-input');
    let featurePlan;
    if (selectedClient === 'host') {
      featurePlan = createHostFeaturePlan({
        config,
        workRequest,
        baselineCommit: observed.headSha,
        decomposition: request.decomposition,
      });
    } else {
      const planningClient = await planningClientFor(immutableJson({ client: selectedClient, project: observed.root }));
      const planner = createFeaturePlanner({ planningClient: {
        propose: contract => planningClient.propose(contract, { signal }),
      } });
      featurePlan = await planner.propose({
        config, workRequest, baselineCommit: observed.headSha, client: selectedClient,
      });
    }
    const runId = runIdentifier(featurePlan, workRequest);
    const store = await storeFor(observed.root, runId);
    const existing = await store.read();
    if (existing !== null) {
      if (existing.proposalDigest !== featurePlanDigest(featurePlan)) fail('state-conflict');
      return proposalView(existing);
    }
    const record = await store.create({ workRequest, featurePlan, createdAt: now() });
    return proposalView(record);
  }

  async function validateSavedPlan(project, record) {
    const config = await loadConfig(absolute(project));
    createFeaturePlan({ proposal: record.featurePlan, config, workRequest: record.workRequest,
      baselineCommit: record.featurePlan.baselineCommit, client: record.featurePlan.client });
  }

  async function start(raw) {
    const request = capture(raw, new Set(['project', 'runId', 'expectedVersion', 'proposalDigest']));
    const { store, record } = await readRun(request.project, request.runId);
    if (record.status !== 'proposed' || record.version !== expectedVersion(request.expectedVersion)) fail('state-conflict');
    if (typeof request.proposalDigest !== 'string' || !DIGEST.test(request.proposalDigest)
      || request.proposalDigest !== record.proposalDigest) fail('proposal-mismatch');
    await validateSavedPlan(request.project, record);
    const at = now();
    const updated = await store.update({
      status: 'approved', updatedAt: at,
      activation: {
        approverId: 'human-cli-operator', approvedAt: at,
        requestDigest: record.workRequest.digest, proposalDigest: record.proposalDigest,
      },
      runtimeRefs: record.runtimeRefs, evidenceRefs: [...record.evidenceRefs, 'approval:activation'],
    }, { expectedVersion: record.version });
    return lifecycleView(updated);
  }

  async function status(raw) {
    const request = capture(raw, new Set(['project', 'runId']));
    return lifecycleView((await readRun(request.project, request.runId)).record);
  }

  async function resume(raw, options = {}) {
    const execution = workerExecutionOptions(options);
    const signal = execution.signal;
    const request = capture(raw, new Set(['project', 'runId', 'expectedVersion']));
    const { store, record } = await readRun(request.project, request.runId);
    if (record.featurePlan.client === 'host') fail('host-use-work');
    if (!['approved', 'blocked'].includes(record.status) || record.version !== expectedVersion(request.expectedVersion)) {
      fail('state-conflict');
    }
    await validateSavedPlan(request.project, record);
    const running = await store.update({
      status: 'running', updatedAt: now(), runtimeRefs: record.runtimeRefs, evidenceRefs: record.evidenceRefs,
    }, { expectedVersion: record.version });
    let result;
    try {
      result = executionResult(await executeFeature(
        immutableJson({ project: absolute(request.project), run: running }), execution,
      ));
    } catch (error) {
      try {
        await store.update({
          status: 'blocked', updatedAt: now(), runtimeRefs: running.runtimeRefs, evidenceRefs: running.evidenceRefs,
        }, { expectedVersion: running.version });
      } catch {}
      throw error;
    }
    const updated = await store.update({
      status: result.status,
      updatedAt: now(),
      runtimeRefs: [...new Set([...running.runtimeRefs, ...result.runtimeRefs])],
      evidenceRefs: [...new Set([...running.evidenceRefs, ...result.evidenceRefs])],
    }, { expectedVersion: running.version });
    return lifecycleView(updated, result.summary);
  }

  async function cancel(raw) {
    const request = capture(raw, new Set(['project', 'runId', 'expectedVersion']));
    const { store, record } = await readRun(request.project, request.runId);
    const cancelCurrent = async current => {
      if (current.version !== expectedVersion(request.expectedVersion)
        || !['proposed', 'approved', 'running', 'blocked', 'awaiting-final-approval'].includes(current.status)) fail('state-conflict');
      return lifecycleView(await store.update({
        status: 'cancelled', updatedAt: now(), runtimeRefs: current.runtimeRefs, evidenceRefs: current.evidenceRefs,
      }, { expectedVersion: current.version }));
    };
    if (record.featurePlan.client !== 'host') {
      // The CLI cannot prove that a spawned worker has stopped. Cancelling its
      // record while it runs would leave an untracked writer in the checkout.
      if (record.status === 'running') fail('state-conflict');
      return cancelCurrent(record);
    }
    const paths = await resolveFeatureRunPaths(request.project, request.runId);
    const lock = await acquireHostRunLock(paths);
    try {
      const current = await store.read();
      if (current === null || current.featurePlan.client !== 'host') fail('state-conflict');
      return await cancelCurrent(current);
    } finally { await lock.release(); }
  }

  return Object.freeze({ propose, start, status, resume, watch: resume, cancel });
}
