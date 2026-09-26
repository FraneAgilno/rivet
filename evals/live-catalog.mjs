import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ensure } from '../src/evaluations/cost-policy.js';
const definitions=Object.freeze({
 feature:Object.freeze({id:'feature',kind:'harness',acceptanceIds:Object.freeze(['normalization','stable-deduplication','empty-input','input-preservation'])}),
 bugfix:Object.freeze({id:'bugfix',kind:'harness',acceptanceIds:Object.freeze(['inclusive-boundaries','duplicate-matches','finite-numbers','input-preservation'])}),
 'text-review':Object.freeze({id:'text-review',kind:'text',acceptanceIds:Object.freeze(['inclusive-boundaries','numeric-validation'])}),
});
export const liveScenarioIds=Object.freeze(Object.keys(definitions));
export async function loadLiveScenario(id) {
 ensure(Object.hasOwn(definitions,id),'unknown-scenario');
 const scenario=definitions[id],files={},configurationTemplates={};
 for(const path of scenario.kind==='text'?['prompt.md']:['src/solution.js','public-check.mjs','request.md']) {
  files[path]=await readFile(new URL(`./fixtures/${id}/${path}`,import.meta.url),'utf8');
  ensure(Buffer.byteLength(files[path])<=16384,'fixture-too-large');
 }
 if(scenario.kind==='harness')for(const name of ['project','providers','orchestration','quality'])configurationTemplates[name]=await readFile(new URL(`../templates/project/.rivet/${name}.yaml`,import.meta.url),'utf8');
 const digest=createHash('sha256').update(JSON.stringify({scenario,files,configurationTemplates})).digest('hex');
 return Object.freeze({...scenario,files:Object.freeze(files),configurationTemplates:Object.freeze(configurationTemplates),digest});
}
