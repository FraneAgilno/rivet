import { containsSecretMaterial } from '../clients/contract.js';
import { createHash } from 'node:crypto';
import { fail, fields, safeUrl, snapshot } from './capabilities.js';
import { deepFreeze } from '../config/defaults.js';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function normalizeHostObservation(input, { provider, projectId }) {
  const value = snapshot(input);
  if (containsSecretMaterial(JSON.stringify(value))) fail('INPUT');
  fields(value,['schemaVersion','providerId','projectId','tool','resourceId','sourceUrl','revision','capturedAt','content']);
  if (value.schemaVersion !== 1 || value.providerId !== provider.id || value.projectId !== projectId
    || provider.transport !== 'harness-mcp' || provider.mode === 'disabled'
    || (provider.projectIds?.length && !provider.projectIds.includes(projectId))
    || !provider.tools?.includes(value.tool)
    || (provider.resourceIds?.length && !provider.resourceIds.includes(value.resourceId))) fail('INPUT');
  for (const key of ['resourceId','revision','capturedAt']) {
    if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 256 || /[\u0000-\u001f]/.test(value[key])) fail('INPUT');
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt))) fail('INPUT');
  const url = safeUrl(value.sourceUrl);
  if (provider.endpoint && safeUrl(provider.endpoint, {endpoint:true}).origin !== url.origin) fail('INPUT');
  return deepFreeze({...value,provider:provider.kind,transport:'harness-mcp',assurance:'harness-observed',contentDigest:createHash('sha256').update(canonical(value.content)).digest('hex')});
}
