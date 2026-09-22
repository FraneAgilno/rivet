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
    const input = await readProfile(flags.profile);
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
