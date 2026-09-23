import { resolve } from 'node:path';
import { loadProjectConfig } from '../config/load.js';
import { createIntegrationRegistry } from '../integrations/registry.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

function readHostInventory(flags, dependencies) {
  const inline = flags['host-inventory-json'];
  if (inline === undefined) return dependencies.integrationHost;
  if (dependencies.integrationHost !== undefined) {
    throw new CliError('Supply host inventory once, through the CLI or host adapter.', 'INVALID_INPUT');
  }
  if (typeof inline !== 'string' || Buffer.byteLength(inline, 'utf8') > 65536) {
    throw new CliError('Host inventory must be JSON of at most 64 KiB.', 'INVALID_INPUT');
  }
  try {
    return JSON.parse(inline);
  } catch {
    throw new CliError('Host inventory must be valid JSON.', 'INVALID_INPUT');
  }
}

export async function integrationsCommand(parsed, dependencies) {
  const { subcommand, operands, flags } = parsed;
  if (!['list', 'check'].includes(subcommand) || operands.length
    || Object.keys(flags).some(key => !['project', 'json', 'host-inventory-json'].includes(key))) {
    throw new CliError('Use rivet integrations list or check [--project=<path>] [--host-inventory-json=<json>] [--json].', 'INVALID_INPUT');
  }
  const host = readHostInventory(flags, dependencies);
  const projectRoot = resolve(flags.project ?? dependencies.cwd?.() ?? process.cwd());
  let config;
  try {
    config = await (dependencies.configLoader ?? loadProjectConfig)(projectRoot);
  } catch {
    throw new CliError('Project configuration is missing or invalid.', 'MISSING_CONFIGURATION');
  }
  let result;
  try {
    const registry = createIntegrationRegistry({
      config,
      projectId: config.project.id,
      environment: dependencies.env ?? process.env,
      host,
    });
    result = { integrations: registry[subcommand](), networkChecked: false };
  } catch {
    throw new CliError('Integration configuration or supplied host inventory is invalid.', 'INVALID_INPUT');
  }
  if (flags.json) dependencies.output.json({ ok: true, result });
  else dependencies.output.log(result.integrations.map(item =>
    `${item.id} (${item.transport}): ${item.readiness}. ${item.remedy}`).join('\n'));
  // Diagnostic completion is success even when an optional integration is unavailable.
  return EXIT_CODES.SUCCESS;
}
