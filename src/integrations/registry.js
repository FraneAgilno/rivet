import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { deepFreeze } from '../config/defaults.js';
import { fail, fields, negotiateCapabilities, safeUrl, snapshot } from './capabilities.js';
const validate = new Ajv({strict:true}).compile(JSON.parse(readFileSync(new URL('../../schemas/integration.schema.json',import.meta.url))));
export function createIntegrationRegistry({config,projectId,environment = {},host}) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200) fail('INPUT');
  const providers = snapshot(config?.providers?.providers,262144);
  if (!Array.isArray(providers) || providers.length > 64 || new Set(providers.map(p=>p.id)).size !== providers.length) fail('INPUT');
  let inventory;
  if (host !== undefined) {
    inventory = snapshot(host);
    fields(inventory,['projectId','providers']);
    if (inventory.projectId !== projectId || !Array.isArray(inventory.providers) || inventory.providers.length > 64) fail('INPUT');
    const ids = new Set();
    for (const item of inventory.providers) {
      fields(item,['id','authenticated','tools']);
      if (!providers.some(p=>p.id===item.id) || ids.has(item.id) || typeof item.authenticated !== 'boolean'
        || !Array.isArray(item.tools) || item.tools.length > 64 || item.tools.some(t=>typeof t!=='string'|| !/^[A-Za-z0-9_.:-]{1,128}$/.test(t))) fail('INPUT');
      ids.add(item.id);
    }
  }
  const rows = providers.map(raw => {
    if (!validate(raw)) fail('INPUT');
    const provider = {...raw,transport:raw.transport ?? 'direct-api'};
    if (provider.endpoint) safeUrl(provider.endpoint, {endpoint:true});
    const observed = inventory?.providers.find(item=>item.id===provider.id);
    const tools = negotiateCapabilities(provider,observed);
    let readiness; let remedy;
    if (provider.mode === 'disabled') {readiness='disabled';remedy='Enable this integration only when needed.';}
    else if (provider.projectIds?.length && !provider.projectIds.includes(projectId)) {readiness='out-of-scope';remedy='Select an integration configured for this project.';}
    else if (provider.transport === 'local-cli') {readiness='unsupported-transport';remedy='Local CLI descriptors are not executable yet.';}
    else if (provider.transport === 'harness-mcp') {
      readiness = !observed ? 'host-unavailable' : !observed.authenticated ? 'authentication-unavailable' : !tools.length ? 'unsupported-tools' : 'host-observed';
      remedy = readiness === 'host-observed' ? 'Host-reported access; not independently verified.' : 'Supply current project-scoped authenticated host inventory with configured tools.';
    } else {
      const refs=Object.values(provider.credentials ?? {});
      const present=refs.length > 0 && refs.every(ref=>{
        const value=Object.getOwnPropertyDescriptor(environment,ref)?.value;
        return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000\r\n]/.test(value);
      });
      readiness=present ? 'credentials-present' : 'authentication-unavailable';
      remedy=present ? 'Credentials are present; network access has not been checked.' : 'Configure referenced environment credentials when this integration is needed.';
    }
    return deepFreeze({...provider,availableTools:tools,readiness,remedy,assurance:provider.transport === 'harness-mcp' && observed ? 'harness-observed' : 'configured'});
  });
  return Object.freeze({list:()=>rows.slice(),check:()=>rows.slice(),resolve(options) {
    const query=snapshot(options); fields(query,['providerId','kind','capability','tool'],['capability']);
    const matches=rows.filter(row=>(!query.providerId||row.id===query.providerId)&&(!query.kind||row.kind===query.kind)&&row.capabilities.includes(query.capability));
    if(matches.length>1) fail('AMBIGUOUS');
    if(matches.length!==1) fail('NOT_FOUND');
    const selected=matches[0];
    if(!['host-observed','credentials-present'].includes(selected.readiness) || (query.tool && !selected.availableTools.includes(query.tool))) fail('UNAVAILABLE');
    return selected;
  }});
}
