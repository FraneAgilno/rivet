import { resolveRoleProfile } from '../models/profiles.js';
import { humanRunCommand } from './human-run.js';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { delegateText, ModelDelegationError } from '../models/delegate.js';
import { buildModelRequest } from '../models/protocols.js';
import { containsSecretMaterial } from '../clients/contract.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createModelRegistry } from '../models/registry.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

async function readProfile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 64 * 1024) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } catch { throw new CliError('Model profile must be a valid JSON file of at most 64 KiB.', 'INVALID_INPUT'); }
  finally { await handle?.close(); }
}

export async function modelsCommand(parsed, dependencies) {
  const { subcommand, operands, flags } = parsed;
  if (subcommand === 'role') {
    if (operands.length || typeof flags.roles !== 'string' || typeof flags.role !== 'string'
      || Object.keys(flags).some(key => !['roles', 'role', 'json'].includes(key))) throw new CliError('Use rivet models role --roles=<file> --role=<name> [--json].', 'INVALID_INPUT');
    const result = await readRole(flags, dependencies);
    if (flags.json) dependencies.output.json({ ok: true, result });
    else dependencies.output.log(`Role ${result.role}: ${result.target.kind}. This inspection does not execute work.`);
    return EXIT_CODES.SUCCESS;
  }
  if (subcommand === 'delegate') return delegateCommand(parsed, dependencies);
  if (operands.length || !['list', 'check'].includes(subcommand)
    || Object.keys(flags).some(key => !['json', 'profile'].includes(key))
    || (subcommand === 'list' && flags.profile !== undefined)
    || (subcommand === 'check' && typeof flags.profile !== 'string')) {
    throw new CliError('Use rivet models list or rivet models check --profile=<file>.', 'INVALID_INPUT');
  }
  const registry = createModelRegistry();
  let result;
  if (subcommand === 'list') result = { providers: registry.list() };
  else {
    const input = await readProfile(resolve(dependencies.cwd(), flags.profile));
    try { result = registry.resolve(input); }
    catch { throw new CliError('Invalid model profile. Check the provider, model, limits, endpoint and credential reference.', 'INVALID_INPUT'); }
  }
  if (flags.json) dependencies.output.json({ ok: true, result });
  else if (subcommand === 'list') {
    dependencies.output.log(result.providers.map(provider => `${provider.id}: ${provider.label} (${provider.kind}; ${provider.execution}; not live verified)`).join('\n'));
  } else {
    dependencies.output.log(`Profile valid: ${result.profile.provider} / ${result.profile.model}. Execution is not ready: ${result.reasons.join(', ')}. No model was called.`);
  }
  return EXIT_CODES.SUCCESS;
}

const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
async function delegateCommand({ operands, flags }, dependencies) {
  const invalid = message => { throw new CliError(message, 'INVALID_INPUT'); };
  const roleMode = typeof flags.roles === 'string' && typeof flags.role === 'string' && flags.profile === undefined;
  const profileMode = typeof flags.profile === 'string' && flags.roles === undefined && flags.role === undefined;
  if (operands.length !== 1 || (!roleMode && !profileMode)
    || Object.keys(flags).some(key => !(roleMode ? ['roles', 'role', 'project'] : ['profile']).includes(key))
    || !dependencies.terminalIsInteractive()) {
    invalid('Use rivet models delegate "prompt" with --profile=<file> or --roles=<file> --role=<name> in an interactive terminal.');
  }
  const prompt = operands[0];
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024
    || UNSAFE_DISPLAY.test(prompt) || containsSecretMaterial(prompt)) invalid('Use a prompt of at most 64 KiB without secrets or terminal control characters.');
  const selection = roleMode ? await readRole(flags, dependencies) : undefined;
  if (roleMode) dependencies.output.log(`Role ${selection.role}: ${selection.target.kind}`);
  if (selection?.target.kind === 'active-harness') {
    if (flags.project !== undefined) invalid('--project applies only to a delegated harness task.');
    dependencies.output.log('Continue this request in your active harness through the Rivet workflow. No model or process was started; the task has not been performed.');
    return EXIT_CODES.SUCCESS;
  }
  if (selection?.target.kind === 'harness') {
    const unchanged = async () => {
      if (!isDeepStrictEqual(selection, await readRole(flags, dependencies))) invalid('Role selection changed. Run the command again.');
    };
    await unchanged();
    return humanRunCommand({ command: 'run', subcommand: null, operands, flags: {
      harness: selection.target.harness, ...(flags.project === undefined ? {} : { project: flags.project }),
    } }, { ...dependencies, confirmFeatureActivation: async (proposal, options) => {
      await unchanged();
      const approved = await dependencies.confirmFeatureActivation(proposal, options);
      await unchanged();
      return approved;
    } });
  }
  if (flags.project !== undefined) invalid('--project applies only to a delegated harness task.');
  const path = profileMode ? resolve(dependencies.cwd(), flags.profile) : undefined;
  const resolveProfile = async () => {
    if (roleMode) {
      const current = await readRole(flags, dependencies);
      if (!isDeepStrictEqual(selection, current)) invalid('Role selection changed. Run the command again.');
      return current.target.profile;
    }
    const input = await readProfile(path);
    try { return createModelRegistry().resolve(input, { requiredCapabilities: ['text'] }).profile; }
    catch { invalid('Invalid model profile.'); }
  };
  const profile = await resolveProfile();
  if (profile.maxCostUsd !== undefined) invalid('Monetary caps cannot be enforced for direct text delegation.');
  if (profile.timeoutMs > 120000) invalid('Direct text delegation requires timeoutMs at most 120000.');
  let url;
  try { url = buildModelRequest(profile, prompt, 'preview-only').url; }
  catch { invalid('This profile does not support direct text delegation. Check its provider and endpoint.'); }
  if (UNSAFE_DISPLAY.test(profile.model)) invalid('Model names must not contain terminal control characters.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const external = dependencies.models?.signal;
  if (external?.aborted) controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let timer;
  try {
    if (controller.signal.aborted) invalid('Text delegation cancelled.');
    const preview = Object.freeze({ profile, prompt, url });
    dependencies.output.log(`Text delegation: ${profile.provider} / ${profile.model}\nDestination: ${url}\nLimits: ${profile.timeoutMs} ms, ${profile.maxOutputTokens} output tokens\nExact prompt:\n${prompt}`);
    const cancelled = new Promise(resolvePromise => {
      controller.signal.addEventListener('abort', () => resolvePromise(false), { once: true });
      timer = setTimeout(() => { controller.abort(); resolvePromise(false); }, 30000);
    });
    const approved = await Promise.race([dependencies.confirmModelDelegation(preview, { signal: controller.signal }), cancelled]);
    clearTimeout(timer);
    if (approved !== true || controller.signal.aborted) invalid('Text delegation cancelled.');
    if (!isDeepStrictEqual(profile, await resolveProfile())) invalid('Model profile changed after approval. Run the command again.');
    if (controller.signal.aborted) invalid('Text delegation cancelled.');
    const result = await (dependencies.models?.delegateText ?? delegateText)({ profile, prompt,
      environment: dependencies.env, signal: controller.signal });
    const text = result.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
    const model = result.model.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
    dependencies.output.log(`Unverified advisory output (${model}; input ${result.usage.inputTokens}, output ${result.usage.outputTokens} tokens):\n${text}`);
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof ModelDelegationError) throw new CliError(error.safeMessage, 'INVALID_INPUT');
    throw error;
  } finally {
    clearTimeout(timer); external?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

async function readRole(flags, dependencies) {
  const input = await readProfile(resolve(dependencies.cwd(), flags.roles));
  try { return resolveRoleProfile(input, flags.role); }
  catch { throw new CliError('Invalid model role configuration or role name.', 'INVALID_INPUT'); }
}
