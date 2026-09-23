import { isAbsolute } from 'node:path';

import { immutableJson } from '../clients/contract.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUBCOMMANDS = new Set(['propose', 'start', 'run', 'status', 'resume', 'cancel']);

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function service(dependencies, method) {
  const feature = dependencies?.feature;
  if (!feature || typeof feature !== 'object' || typeof feature[method] !== 'function') {
    fail('Feature workflow is not configured.', 'MISSING_CONFIGURATION');
  }
  return feature;
}

async function invoke(feature, method, input) {
  try {
    return await feature[method](input);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = String(error?.code ?? '');
    let publicCode = 'INTERNAL_ERROR';
    if (code === 'ERR_FEATURE_WORKFLOW_CONFIGURATION' || code === 'ERR_APPLICATION_CONFIGURATION'
      || code === 'ERR_TRACKER_PROVIDER_CONFIGURATION') {
      publicCode = 'MISSING_CONFIGURATION';
    } else if (code.startsWith('ERR_HOST_RUN_') || code === 'ERR_FEATURE_WORKFLOW_REPOSITORY' || code === 'ERR_FEATURE_WORKFLOW_STATE_CONFLICT'
      || code === 'ERR_FEATURE_WORKFLOW_PROPOSAL_MISMATCH' || code === 'ERR_FEATURE_RUN_VERSION_CONFLICT'
      || code.startsWith('ERR_GIT_')) {
      publicCode = 'REPOSITORY_CONFLICT';
    } else if (code === 'ERR_FEATURE_WORKFLOW_HOST_USE_WORK' || code === 'ERR_FEATURE_WORKFLOW_INVALID_INPUT' || code === 'ERR_INVALID_WORK_REQUEST'
      || code === 'ERR_INVALID_FEATURE_PLAN' || code === 'ERR_INVALID_FEATURE_RUN') {
      publicCode = 'INVALID_INPUT';
    } else if (code.startsWith('ERR_PROVIDER_') || code.startsWith('ERR_AGENT_')) {
      publicCode = 'PROVIDER_UNAVAILABLE';
    }
    const message = typeof error?.safeMessage === 'string' && error.safeMessage.length <= 1000
      ? error.safeMessage : 'Unexpected rivet failure.';
    throw new CliError(message, publicCode, { cause: error });
  }
}

function project(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || !isAbsolute(value)
    || /[\u0000\r\n]/.test(value)) fail("Feature option 'project' is invalid.");
  return value;
}

function runId(value) {
  if (typeof value !== 'string' || value.length > 64 || !RUN_ID.test(value)) fail('Feature run ID is invalid.');
  return value;
}

function version(value) {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail("Feature option 'expected-version' is invalid.");
  return parsed;
}

function flags(parsed, allowed) {
  if (!parsed.flags || typeof parsed.flags !== 'object' || Array.isArray(parsed.flags)
    || Object.keys(parsed.flags).some(key => !allowed.includes(key))) fail('Feature command options are invalid.');
  return parsed.flags;
}

function lifecycleInput(parsed, allowed, { mutation = false, digest = false } = {}) {
  const options = flags(parsed, allowed);
  if (!Array.isArray(parsed.operands) || parsed.operands.length !== 1) fail('Feature command requires one explicit private run ID.');
  const input = { project: project(options.project), runId: runId(parsed.operands[0]) };
  if (mutation) input.expectedVersion = version(options['expected-version']);
  if (digest) {
    if (typeof options['proposal-digest'] !== 'string' || !DIGEST.test(options['proposal-digest'])) {
      fail("Feature option 'proposal-digest' is invalid.");
    }
    input.proposalDigest = options['proposal-digest'];
  }
  return Object.freeze(input);
}

function sourceInput(parsed) {
  const options = flags(parsed, [
    'project', 'request', 'request-text', 'ticket', 'tracker', 'client', 'json',
  ]);
  if (!Array.isArray(parsed.operands) || parsed.operands.length !== 0) fail('Feature proposal commands do not accept a run ID.');
  const selectors = ['request', 'request-text', 'ticket'].filter(key => options[key] !== undefined);
  if (selectors.length !== 1) fail('Feature proposal requires exactly one request source.');
  const selected = selectors[0];
  const projectPath = project(options.project);
  let source;
  if (selected === 'request') {
    if (typeof options.request !== 'string' || options.request.length < 2 || options.request.length > 4096
      || !isAbsolute(options.request) || /[\u0000\r\n]/.test(options.request)) fail("Feature option 'request' is invalid.");
    source = Object.freeze({ kind: 'file', value: options.request });
  } else if (selected === 'request-text') {
    if (typeof options['request-text'] !== 'string' || options['request-text'].length < 1
      || Buffer.byteLength(options['request-text'], 'utf8') > 64 * 1024 || options['request-text'].includes('\0')) {
      fail("Feature option 'request-text' is invalid.");
    }
    source = Object.freeze({ kind: 'inline', value: options['request-text'] });
  } else {
    if (typeof options.ticket !== 'string' || !TICKET.test(options.ticket)) fail("Feature option 'ticket' is invalid.");
    source = Object.freeze({ kind: 'ticket', value: options.ticket });
  }
  if (selected !== 'ticket' && options.tracker !== undefined) fail("Feature option 'tracker' requires '--ticket'.");
  if (options.tracker !== undefined && !['jira', 'linear'].includes(options.tracker)) fail("Feature option 'tracker' is invalid.");
  if (options.client !== undefined && !['claude', 'codex'].includes(options.client)) fail("Feature option 'client' is invalid.");
  if (selected !== 'ticket' && options.client === undefined) fail("Feature option 'client' is required for local requests.");
  return Object.freeze({
    project: projectPath,
    source,
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.tracker === undefined ? {} : { tracker: options.tracker }),
  });
}

function safeResult(value) {
  try { return immutableJson(value); }
  catch { fail('Feature workflow returned an invalid result.', 'INTERNAL_ERROR'); }
}

function proposalResult(value) {
  const result = safeResult(value);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !RUN_ID.test(result.runId)
    || result.runId.length > 64 || !Number.isSafeInteger(result.version) || result.version < 1
    || typeof result.proposalDigest !== 'string' || !DIGEST.test(result.proposalDigest)
    || (result.summary !== undefined && (typeof result.summary !== 'string' || result.summary.length > 4000))) {
    fail('Feature workflow returned an invalid proposal.', 'INTERNAL_ERROR');
  }
  return result;
}

function emit(parsed, dependencies, result) {
  const payload = { ok: true, command: 'feature', subcommand: parsed.subcommand, result: safeResult(result) };
  if (parsed.flags.json) dependencies.output.json(payload);
  else dependencies.output.log(`Feature ${parsed.subcommand}: ${payload.result.status ?? payload.result.runId ?? 'ok'}.`);
  return EXIT_CODES.SUCCESS;
}

function displayProposal(dependencies, proposal) {
  const summary = proposal.summary === undefined ? 'Ready for activation review.' : proposal.summary;
  dependencies.output.log(`Feature proposal ${proposal.runId} (version ${proposal.version}, digest ${proposal.proposalDigest}): ${summary}`);
}

export async function featureCommand(parsed, dependencies) {
  if (!parsed || parsed.command !== 'feature' || !SUBCOMMANDS.has(parsed.subcommand)) fail('Feature subcommand is invalid.');
  if (parsed.subcommand === 'propose') {
    const feature = service(dependencies, 'propose');
    const result = proposalResult(await invoke(feature, 'propose', sourceInput(parsed)));
    return emit(parsed, dependencies, result);
  }
  if (parsed.subcommand === 'run') {
    if (parsed.flags?.json) fail("Feature command 'run' is interactive; use 'propose' and 'start' in JSON mode.");
    const feature = service(dependencies, 'propose');
    if (typeof feature.start !== 'function' || typeof feature.watch !== 'function'
      || typeof dependencies.confirmFeatureActivation !== 'function') fail('Feature workflow is not configured.', 'MISSING_CONFIGURATION');
    const input = sourceInput(parsed);
    const proposal = proposalResult(await invoke(feature, 'propose', input));
    displayProposal(dependencies, proposal);
    if (await dependencies.confirmFeatureActivation(proposal) !== true) {
      return emit(parsed, dependencies, { runId: proposal.runId, version: proposal.version, status: 'proposed', activation: 'declined' });
    }
    const started = safeResult(await invoke(feature, 'start', Object.freeze({
      project: input.project, runId: proposal.runId, expectedVersion: proposal.version,
      proposalDigest: proposal.proposalDigest,
    })));
    if (!Number.isSafeInteger(started.version) || started.version < 1) fail('Feature workflow returned an invalid result.', 'INTERNAL_ERROR');
    const watched = await invoke(feature, 'watch', Object.freeze({ project: input.project, runId: proposal.runId, expectedVersion: started.version }));
    return emit(parsed, dependencies, watched);
  }
  if (parsed.subcommand === 'status') {
    const feature = service(dependencies, 'status');
    return emit(parsed, dependencies, await invoke(feature, 'status', lifecycleInput(parsed, ['project', 'json'])));
  }
  if (parsed.subcommand === 'start') {
    const feature = service(dependencies, 'start');
    return emit(parsed, dependencies, await invoke(feature, 'start', lifecycleInput(
      parsed, ['project', 'expected-version', 'proposal-digest', 'json'], { mutation: true, digest: true },
    )));
  }
  const feature = service(dependencies, parsed.subcommand);
  return emit(parsed, dependencies, await invoke(feature, parsed.subcommand, lifecycleInput(
    parsed, ['project', 'expected-version', 'json'], { mutation: true },
  )));
}
