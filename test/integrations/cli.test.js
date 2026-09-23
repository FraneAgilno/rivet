import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../src/cli/main.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { integrationsCommand } from '../../src/commands/integrations.js';
test('integration commands are routed and report unknown host access honestly',async()=>{
 const parsed=parseArgs(['integrations','check','--project','/tmp','--json']);
 const config={project:{id:'demo'},providers:{providers:[{id:'jira',kind:'jira',mode:'read-only',transport:'harness-mcp',capabilities:['issues-read'],tools:['get_issue']}]}};
 let payload;const dependencies={configLoader:async()=>config,env:{},output:{json(value){payload=value;}}};
 assert.equal(await integrationsCommand(parsed,dependencies),0);
 assert.equal(payload.result.integrations[0].readiness,'host-unavailable');
 assert.equal(payload.result.networkChecked,false);
 let called=false;
 assert.equal(await main(['integrations','list'],{commands:{integrations:async()=>{called=true;return 0;}}}),0);assert.equal(called,true);
 assert.throws(()=>parseArgs(['integrations','check','--token=secret']));
});

test('real CLI accepts bounded explicit host inventory and rejects conflicts', async t => {
  const { mkdtemp, cp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parse, stringify } = await import('yaml');
  const { createOutput, EXIT_CODES } = await import('../../src/cli/output.js');
  const root = await mkdtemp(join(tmpdir(), 'rivet-integration-cli-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await cp(new URL('../fixtures/config/valid/.rivet', import.meta.url), join(root, '.rivet'), {recursive:true});
  const providersPath = join(root, '.rivet/providers.yaml');
  const config = parse(await readFile(providersPath,'utf8'));
  const provider = config.providers[0];
  Object.assign(provider, {transport:'harness-mcp',tools:['get_issue']});
  await writeFile(providersPath,stringify(config));
  const project = parse(await readFile(join(root,'.rivet/project.yaml'),'utf8'));
  const inventory = JSON.stringify({projectId:project.id,providers:[{id:provider.id,authenticated:true,tools:['get_issue']}]});
  let text='';
  const output = createOutput({stdout:{write:value=>{text+=value;}},stderr:{write:value=>{text+=value;}}});
  const argv=['integrations','check',`--project=${root}`,`--host-inventory-json=${inventory}`,'--json'];
  assert.equal(await main(argv,{output}),0);
  assert.equal(JSON.parse(text).result.integrations[0].readiness,'host-observed');
  assert.equal(JSON.parse(text).result.networkChecked,false);
  for(const input of ['{bad', ' '.repeat(65537)]) {
    text='';
    assert.equal(await main(['integrations','list',`--project=${root}`,`--host-inventory-json=${input}`,'--json'],{output}),EXIT_CODES.INVALID_INPUT);
  }
  text='';
  assert.equal(await main(argv,{output,integrationHost:JSON.parse(inventory)}),EXIT_CODES.INVALID_INPUT);
});
