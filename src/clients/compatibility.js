import { failAgent } from './contract.js';

// Evidence of tested releases belongs in docs, not an executable allowlist.
export function validVersion(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function missingCapabilities(help, required) {
  const declared = new Set();
  for (const line of help.split('\n')) {
    const match = line.match(/^\s*(?:-[A-Za-z?],?\s+)?(--[a-z][a-z0-9-]*)(?=[\s=,]|$)/);
    if (match) declared.add(match[1]);
  }
  return required.filter(option => !declared.has(option));
}

export async function checkCompatibility(runner, provider, args, expectedVersion) {
  const observed = await runner.probeVersion();
  if (!validVersion(observed) || (expectedVersion !== undefined && observed !== expectedVersion)) failAgent('provider-unavailable');
  const required = [...new Set(args.filter(value => /^--[a-z][a-z0-9-]*$/.test(value)))];
  if (missingCapabilities(await runner.probeHelp(provider), required).length) failAgent('provider-unavailable');
}
