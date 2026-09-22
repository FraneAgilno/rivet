import { isAbsolute, resolve } from 'node:path';

import { EXIT_CODES } from '../cli/output.js';
import { inspectCommandReadiness } from '../config/command-readiness.js';
import { loadProjectConfig, providerCredentialStatus } from '../config/load.js';
import { discoverTools } from '../discovery/tools.js';

function emit(output, json, payload, exitCode) {
  if (json) {
    output.json(payload, exitCode === EXIT_CODES.SUCCESS ? 'stdout' : 'stderr');
  } else if (exitCode === EXIT_CODES.SUCCESS) {
    output.log(`Doctor: ${payload.status}. ${payload.summary}`);
  } else {
    output.error(`Doctor: ${payload.status}. ${payload.summary}`);
  }
  return exitCode;
}

function requiredToolReady(tool) {
  return tool?.present === true
    && typeof tool.version === 'string'
    && tool.version.length > 0
    && tool.supported === true;
}

async function boundedProbe(probe, provider, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      probe(provider),
      new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise({ status: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function providerChecks(config, probe, timeoutMs = 3_000) {
  const checks = [];
  for (const provider of config.providers.providers) {
    if (provider.mode === 'disabled') {
      checks.push({ id: provider.id, readiness: 'disabled', connectivity: 'not_checked' });
      continue;
    }
    if (typeof probe !== 'function') {
      checks.push({ id: provider.id, readiness: 'configured', connectivity: 'not_checked' });
      continue;
    }
    try {
      const result = await boundedProbe(probe, {
        id: provider.id,
        kind: provider.kind,
        endpoint: provider.endpoint,
      }, timeoutMs);
      const connectivity = result?.status === 'available' ? 'available'
        : result?.status === 'timeout' ? 'timeout' : 'unavailable';
      checks.push({ id: provider.id, readiness: connectivity === 'available' ? 'ready' : 'unavailable', connectivity });
    } catch {
      checks.push({ id: provider.id, readiness: 'unavailable', connectivity: 'error' });
    }
  }
  return checks;
}

export async function diagnoseDoctor(projectRoot, dependencies = {}) {
  let config;
  try {
    config = await (dependencies.configLoader ?? loadProjectConfig)(projectRoot, { fs: dependencies.fs });
  } catch {
    return {
      ok: false,
      status: 'fail',
      exitCode: EXIT_CODES.MISSING_CONFIGURATION,
      error: {
        code: 'MISSING_CONFIGURATION',
        exitCode: EXIT_CODES.MISSING_CONFIGURATION,
        message: 'Project configuration is missing or invalid.',
      },
      checks: { configuration: { status: 'fail' } },
      summary: 'Project configuration is missing or invalid.',
    };
  }
  const environment = dependencies.env ?? process.env;
  const packageManager = config.project.stack.packageManager;
  let tools = await (dependencies.toolDiscovery ?? discoverTools)({ packageManager }, {
    cwd: projectRoot,
    runner: dependencies.runner,
  });
  if (typeof dependencies.resolveCommandExecutable === 'function') {
    let runtimeResolved = false;
    try {
      const executable = await dependencies.resolveCommandExecutable(packageManager);
      runtimeResolved = typeof executable === 'string' && isAbsolute(executable);
    } catch {}
    tools = Object.freeze({
      ...tools,
      [packageManager]: Object.freeze({ ...(tools[packageManager] ?? {}), runtimeResolved }),
    });
  }
  const credentials = providerCredentialStatus(config, environment);
  const providers = await providerChecks(
    config,
    dependencies.providerProbe,
    dependencies.providerProbeTimeoutMs,
  );
  const commands = inspectCommandReadiness(projectRoot, config, { fs: dependencies.fs, tools });
  const missingCredentials = credentials.filter(item => item.required && !item.present);
  const unavailableProviders = providers.filter(item => ['unavailable', 'timeout', 'error'].includes(item.connectivity));
  const toolsReady = requiredToolReady(tools.node)
    && requiredToolReady(tools[packageManager])
    && tools[packageManager].runtimeResolved !== false
    && requiredToolReady(tools.git);
  const failed = missingCredentials.length > 0 || unavailableProviders.length > 0 || !toolsReady || !commands.ready;
  const exitCode = missingCredentials.length > 0 || unavailableProviders.length > 0
    ? EXIT_CODES.PROVIDER_UNAVAILABLE
    : failed ? EXIT_CODES.FAILED_GATE : EXIT_CODES.SUCCESS;
  return {
    ok: !failed,
    status: failed ? 'fail' : providers.some(item => item.connectivity === 'not_checked') ? 'warn' : 'pass',
    exitCode,
    checks: {
      configuration: { status: 'pass' },
      tools,
      credentials,
      providers,
      commands,
    },
    summary: failed ? 'One or more readiness checks failed.' : 'Configuration and local readiness checks completed.',
  };
}

export async function doctor(parsed, dependencies = {}) {
  const json = parsed.flags.json === true;
  const projectRoot = resolve(parsed.flags.project ?? dependencies.cwd?.() ?? process.cwd());
  try {
    const result = await diagnoseDoctor(projectRoot, dependencies);
    return emit(dependencies.output, json, result, result.exitCode);
  } catch {
    return emit(dependencies.output, json, {
      ok: false,
      status: 'fail',
      summary: 'Doctor could not complete safely.',
      error: {
        code: 'INTERNAL_ERROR',
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: 'Doctor could not complete safely.',
      },
    }, EXIT_CODES.INTERNAL_ERROR);
  }
}
