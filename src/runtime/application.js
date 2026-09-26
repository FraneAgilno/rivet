import { createTrackerProviderFactory } from '../adapters/factory.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import * as filesystem from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { realpath as realpathFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  createClaudeClient,
  createClaudePlanningClient,
  CLAUDE_ADAPTER_SYNTAX,
} from '../clients/claude.js';
import {
  createCodexClient,
  createCodexPlanningClient,
  CODEX_ADAPTER_SYNTAX,
} from '../clients/codex.js';
import {
  CLAUDE_FEATURE_PROFILE,
  FEATURE_PLANNING_TIMEOUT_MS,
  clientProfileFor,
  matchesClientProfile,
} from '../feature/client-profile.js';
import { collectEvidenceBundle } from '../evidence/collect.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { createFeatureExecutor } from '../feature/runtime-bridge.js';
import { createHostExecution } from '../feature/host-execution.js';
import { discoverHarnesses } from './harness-discovery.js';
import { createFeatureWorkflow } from '../feature/workflow.js';
import { createGitClient } from '../git/client.js';
import { createReservedWorktree } from '../git/worktrees.js';
import { buildLaunchContract } from '../prompts/launch-contract.js';
import { runQualityGates } from '../quality/runner.js';
import { resolveFeatureRunPaths } from '../state/paths.js';
import { createOrchestrator } from './orchestrator.js';

const INPUT_KEYS = new Set(['cwd', 'env', 'fs', 'fetch', 'spawn', 'now', 'featureWorkflow', 'providerTransport']);
const FEATURE_WORKFLOW_METHODS = Object.freeze(['propose', 'start', 'watch', 'status', 'resume', 'cancel']);

export class ApplicationConfigurationError extends Error {
  constructor() {
    super('Rivet runtime configuration is missing or invalid.');
    this.name = 'ApplicationConfigurationError';
    this.code = 'ERR_APPLICATION_CONFIGURATION';
    this.safeMessage = this.message;
  }
}

function fail() { throw new ApplicationConfigurationError(); }

function capture(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > INPUT_KEYS.size || keys.some(key => typeof key !== 'string' || !INPUT_KEYS.has(key))) fail();
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof ApplicationConfigurationError) throw error;
    fail();
  }
}

function environment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const output = Object.create(null);
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { fail(); }
  if (keys.length > 512 || keys.some(key => typeof key !== 'string')) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) fail();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function executable(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1024 || !isAbsolute(value)
    || /[\u0000\r\n]/.test(value)) fail();
  return value;
}

function executableCandidates(runner, pathValue) {
  const directories = typeof pathValue === 'string' ? pathValue.split(':').slice(0, 128) : [];
  return [
    ...directories.filter(directory => directory.length > 1 && directory.length <= 1024
      && isAbsolute(directory) && resolve(directory) === directory && !/[\u0000\r\n]/.test(directory))
      .map(directory => join(directory, runner)),
    `/opt/homebrew/bin/${runner}`, `/usr/local/bin/${runner}`, `/usr/bin/${runner}`,
  ];
}

function captureFeatureWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FEATURE_WORKFLOW_METHODS.length
    || keys.some(key => typeof key !== 'string' || !FEATURE_WORKFLOW_METHODS.includes(key))) fail();
  const output = {};
  for (const method of FEATURE_WORKFLOW_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') fail();
    output[method] = descriptor.value;
  }
  return Object.freeze(output);
}

export function createRivetApplication(input = {}) {
  const configured = capture(input);
  const cwd = configured.cwd ?? (() => process.cwd());
  const env = environment(configured.env ?? process.env);
  const fs = configured.fs ?? filesystem;
  const fetch = configured.fetch ?? globalThis.fetch;
  const spawn = configured.spawn ?? nodeSpawn;
  const now = configured.now ?? (() => new Date().toISOString());
  if (typeof cwd !== 'function' || !fs || typeof fs !== 'object' || typeof fetch !== 'function'
    || typeof spawn !== 'function' || typeof now !== 'function') fail();
  let gitClientPromise;
  const gitClient = () => {
    gitClientPromise ??= (async () => {
      if (env.RIVET_GIT_EXECUTABLE !== undefined) {
        return createGitClient({ gitExecutable: executable(env.RIVET_GIT_EXECUTABLE) });
      }
      for (const candidate of executableCandidates('git', env.PATH)) {
        try { return await createGitClient({ gitExecutable: executable(await realpathFile(candidate)) }); } catch {}
      }
      fail();
    })();
    return gitClientPromise;
  };
  let workflowPromise;
  let executorPromise;
  let hostExecutionPromise;
  const selectedHarnesses = new Map();
  const selectedVersion = kind => selectedHarnesses.get(kind)?.version;
  const harnessSettings = kind => {
    const selected = selectedHarnesses.get(kind);
    return selected ? {
      executable: selected.executable,
      ...(selected.interpreter ? { interpreter: selected.interpreter } : {}),
    } : {
      executable: executable(env[`RIVET_${kind.toUpperCase()}_EXECUTABLE`]),
      ...clientInterpreter(kind),
    };
  };
  const harnesses = Object.freeze({
    discover(projectRoot, { signal } = {}) { return discoverHarnesses({ env, projectRoot, signal }); },
    async select(kind, projectRoot, { signal } = {}) {
      if (!['claude', 'codex'].includes(kind)) fail();
      const found = await discoverHarnesses({ env, projectRoot, signal });
      const selected = found.find(item => item.kind === kind && item.executable);
      if (!selected) fail();
      selectedHarnesses.set(kind, selected);
      return selected;
    },
  });
  const clientEnvironment = Object.freeze(Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'HOME', 'USER', 'LOGNAME', 'SHELL']
      .filter(key => env[key] !== undefined)
      .map(key => [key, env[key]]),
  ));
  const clientInterpreter = kind => {
    const value = env[`RIVET_${kind.toUpperCase()}_INTERPRETER`];
    return value === undefined ? {} : { interpreter: executable(value) };
  };
  const planningClientFor = async request => {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Reflect.ownKeys(request).length !== 2
      || !Object.hasOwn(request, 'client') || !Object.hasOwn(request, 'project')) fail();
    if (request.client === 'claude') {
      return createClaudePlanningClient({
        ...harnessSettings('claude'),
        expectedVersion: selectedVersion('claude'),
        worktree: executable(request.project),
        environment: clientEnvironment,
        timeoutMs: FEATURE_PLANNING_TIMEOUT_MS,
      });
    }
    if (request.client === 'codex') {
      return createCodexPlanningClient({
        ...harnessSettings('codex'),
        expectedVersion: selectedVersion('codex'),
        worktree: executable(request.project),
        environment: clientEnvironment,
        timeoutMs: FEATURE_PLANNING_TIMEOUT_MS,
      });
    }
    fail();
  };
  const agentClientFor = (kind, clientProfile) => {
    if (!matchesClientProfile(kind, clientProfile)) fail();
    if (kind === 'claude') return createClaudeClient({
      ...harnessSettings('claude'),
      expectedVersion: selectedVersion('claude'),
      args: [
        ...CLAUDE_ADAPTER_SYNTAX.args.slice(0, -1),
        '--model', CLAUDE_FEATURE_PROFILE.model,
        '--effort', 'low',
        '--permission-mode', 'acceptEdits',
        '{stdin}',
      ],
      environment: clientEnvironment,
    });
    if (kind === 'codex') return createCodexClient({
      ...harnessSettings('codex'),
      expectedVersion: selectedVersion('codex'),
      args: [...CODEX_ADAPTER_SYNTAX.args.slice(0, -1), '--sandbox', 'workspace-write', '{stdin}'],
      environment: clientEnvironment,
    });
    fail();
  };
  const resolveCommandExecutable = async runner => {
    if (typeof runner !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/i.test(runner)) fail();
    const configuredPath = env[`RIVET_${runner.toUpperCase().replaceAll('-', '_')}_EXECUTABLE`];
    if (configuredPath !== undefined) return executable(await realpathFile(executable(configuredPath)));
    for (const candidate of executableCandidates(runner, env.PATH)) {
      try { return executable(await realpathFile(candidate)); } catch {}
    }
    fail();
  };
  const executeFeature = async (request, options) => {
    executorPromise ??= gitClient().then(client => createFeatureExecutor({
      gitClient: client,
      clientFor: async (kind, profile, { project, signal }) => {
        await harnesses.select(kind, project, { signal });
        return agentClientFor(kind, profile);
      },
      resolveCommandExecutable,
      now,
      environment: clientEnvironment,
    }));
    return (await executorPromise)(request, options);
  };
  const resolvedWorkflow = () => {
    if (configured.featureWorkflow !== undefined) return Promise.resolve(captureFeatureWorkflow(configured.featureWorkflow));
    workflowPromise ??= gitClient().then(client => createFeatureWorkflow({
      gitClient: client,
      planningClientFor,
      trackerAdapterFor: async ({ provider, config }) => createTrackerProviderFactory({
        config,
        environment: env,
        transport: configured.providerTransport ?? createNodeProviderTransport(),
        clock: now,
      }).create({ tracker: provider }),
      executeFeature,
      now,
    }));
    return workflowPromise;
  };
  const workflow = configured.featureWorkflow !== undefined
    ? captureFeatureWorkflow(configured.featureWorkflow)
    : Object.freeze(Object.fromEntries(FEATURE_WORKFLOW_METHODS.map(method => [
      method, async (...args) => (await resolvedWorkflow())[method](...args),
    ])));

  const hostExecution = Object.freeze(Object.fromEntries(
    ['prepare', 'nextAction', 'status', 'submitResult', 'verify', 'recover'].map(method => [
      method,
      async (...args) => {
        hostExecutionPromise ??= gitClient().then(client => createHostExecution({
          gitClient: client,
          now,
          resolveCommandExecutable,
          environment: clientEnvironment,
        }));
        const service = await hostExecutionPromise;
        if (typeof service[method] !== 'function') fail();
        return service[method](...args);
      },
    ]),
  ));

  const feature = Object.freeze({
    ...workflow,
    async openRun(projectRoot, runId) {
      const paths = await resolveFeatureRunPaths(projectRoot, runId);
      return Object.freeze({ paths, store: createFeatureRunStore(paths) });
    },
    createAgentClient(kind) {
      return agentClientFor(kind, clientProfileFor(kind));
    },
    async prepareWorktree(request, options = {}) {
      return createReservedWorktree(request, { ...options, gitClient: await gitClient() });
    },
    buildLaunchContract,
    createOrchestrator,
    async runQualityGates(request, options = {}) {
      return runQualityGates(request, { ...options, gitClient: await gitClient() });
    },
    async collectEvidence(request) {
      return collectEvidenceBundle({ ...request, gitClient: await gitClient() });
    },
  });

  return Object.freeze({ cwd, env, fs, fetch, feature, work: hostExecution, harnesses, resolveCommandExecutable });
}
