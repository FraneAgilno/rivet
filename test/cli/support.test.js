import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, realpath, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { main } from '../../src/cli/main.js';
import { collectSupportBundle, resolveSupportProject } from '../../src/support/bundle.js';
const seeded='/Users/private-user/private-project/credential-value';
const report={status:'fail',checks:{configuration:{status:'pass'},tools:{node:{present:true,supported:true,version:'22.22.0'},git:{present:true,supported:true,version:'2.50.0'},CUSTOM_AUTH:{version:seeded}},credentials:[{name:'CUSTOM_AUTH',required:true,present:false}],providers:[{id:seeded,readiness:'configured',connectivity:'not_checked'}],commands:{ready:false,steps:[{status:'missing-script',cwd:seeded,argv:['secret-command',seeded]}]}},summary:seeded,error:{message:seeded}};
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-support-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('support bundle uses fixed fields and excludes credentials, paths, IDs, command bodies and raw errors',async()=>{
 let options;const result=await collectSupportBundle('/unused',{environment:{CUSTOM_AUTH:seeded},diagnose:async(root,input)=>{options=input;return report}});
 const serialized=JSON.stringify(result);for(const privateValue of [seeded,'CUSTOM_AUTH','secret-command','private-user','argv','summary'])assert.ok(!serialized.includes(privateValue),privateValue);
 assert.equal(options.providerProbe,undefined);assert.equal(result.configuration.status,'valid');assert.equal(result.collection.status,'complete');
 assert.ok(serialized.length<16384);assert.equal(result.tools.find(tool=>tool.name==='node').version,'22.22.0');assert.equal(result.harnesses.status,'not-requested');
});
test('unsafe diagnostics and throwing collectors produce only bounded incomplete categories',async()=>{
 let invoked=false;
 for(const diagnostic of [new Proxy(report,{get(){throw new Error(seeded)}}),{...report,get checks(){invoked=true;throw new Error(seeded)}},null]){
  const result=await collectSupportBundle('/unused',{diagnose:async()=>diagnostic,environment:{}});
  assert.equal(result.collection.status,'incomplete');assert.ok(!JSON.stringify(result).includes(seeded));
 }
 const result=await collectSupportBundle('/unused',{diagnose:async()=>{throw new Error(seeded)},environment:{}});
 assert.equal(result.collection.status,'incomplete');assert.equal(invoked,false);
});
test('optional harness probe is explicit and opaque version suffixes and errors never escape',async()=>{
 let probes=0;const discover=async()=>{probes++;return [{kind:'claude',executable:seeded,version:'2.1.207-private-value'},{kind:'codex',reason:'missing-options: '+seeded}]};
 const options={diagnose:async()=>report,environment:{},discoverHarnesses:discover};
 await collectSupportBundle('/unused',options);assert.equal(probes,0);
 const result=await collectSupportBundle('/unused',{...options,probeHarnesses:true});
 assert.equal(probes,1);assert.equal(result.harnesses.results[0].version,'2.1.207');assert.equal(result.harnesses.results[1].reason,'missing-options');assert.ok(!JSON.stringify(result).includes(seeded));
});
test('root resolution accepts missing config, chooses nested ancestor marker, and does not follow unsafe markers',async t=>{
 const root=await fixture(t),child=join(root,'src','nested');await mkdir(child,{recursive:true});await mkdir(join(root,'.rivet'));
 assert.equal(await resolveSupportProject(child),root);assert.equal(await resolveSupportProject(child,root),root);
 const other=await fixture(t);assert.equal(await resolveSupportProject(other),other);
 await symlink(root,join(other,'.rivet'));assert.equal(await resolveSupportProject(other),other);
 await assert.rejects(resolveSupportProject(root,join(root,'missing')));
});
test('support CLI strictly parses flags and prints usable JSON for missing configuration',async t=>{
 const root=await fixture(t),outputs=[];
 const deps={cwd:()=>root,env:{},output:{json:value=>outputs.push(value),log:value=>outputs.push(value),error:value=>outputs.push(value)}};
 assert.equal(await main(['support','--json'],deps),0);assert.equal(outputs[0].result.configuration.status,'missing-or-invalid');
 for(const args of [['support','extra'],['support','--upload'],['support','--probe-harnesses=false'],['support',`--project=${join(root,'missing')}`]]){
  outputs.length=0;assert.notEqual(await main(args,deps),0);assert.ok(!JSON.stringify(outputs).includes(root));
 }
});


test('configured credential values matching numeric version strings remain hidden',async()=>{
 const diagnostic=structuredClone(report),core=process.version.slice(1);diagnostic.checks.tools.node.version=core;
 const bundle=await collectSupportBundle('/unused',{environment:{CUSTOM_AUTH:core},diagnose:async()=>diagnostic});
 assert.equal(bundle.versions.node,null);assert.equal(bundle.tools.find(tool=>tool.name==='node').version,null);
});
test('timeouts and external cancellation stop later diagnostics and harness dispatch',async()=>{
 for(const cancel of [false,true]) {
  const controller=new AbortController();let harnesses=0;
  const result=collectSupportBundle('/unused',{environment:{},timeoutMs:20,signal:controller.signal,probeHarnesses:true,
    diagnose:async()=>new Promise(resolve=>setTimeout(()=>resolve(report),60)),discoverHarnesses:async()=>{harnesses++;return []}});
  if(cancel)controller.abort();const bundle=await result;
  assert.equal(bundle.collection.status,'incomplete');assert.ok(bundle.collection.errors.includes(cancel?'cancelled':'timeout'));
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(harnesses,0);
 }
});
test('environment accessors and malformed optional probes cannot leak or execute getters',async()=>{
 let invoked=false;
 const bundle=await collectSupportBundle('/unused',{environment:{get CUSTOM_AUTH(){invoked=true;return seeded}},diagnose:async()=>report});
 assert.equal(bundle.collection.status,'incomplete');assert.equal(invoked,false);
 const probe=await collectSupportBundle('/unused',{environment:{},diagnose:async()=>report,probeHarnesses:true,
  discoverHarnesses:async()=>[{kind:'claude',get version(){invoked=true;return seeded}},{kind:'codex',reason:'not-installed'}]});
 assert.equal(probe.harnesses.status,'failed');assert.equal(invoked,false);assert.ok(!JSON.stringify(probe).includes(seeded));
});
test('version probes reject project PATH executables and Node startup injection',async t=>{
 const root=await fixture(t),bin=join(root,'bin'),marker=join(root,'executed');await mkdir(bin);
 await writeFile(join(bin,'node'),`#!/bin/sh\nprintf unsafe > '${marker}'\n`,{mode:0o700});
 const preload=join(root,'preload.cjs');await writeFile(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`);
 let observed;
 const result=await collectSupportBundle(root,{environment:{PATH:`${bin}:${dirname(process.execPath)}`,NODE_OPTIONS:`--require=${preload}`},
  diagnose:async(path,options)=>{observed=await options.runner('node',['--version'],{cwd:path});return report}});
 assert.equal(result.collection.status,'complete');assert.equal(observed.code,0);assert.match(observed.stdout,/^v[0-9]+\./);
 await assert.rejects(access(marker),{code:'ENOENT'});
});
test('unsafe configuration markers never reach the doctor or collect linked files',async t=>{
 const root=await fixture(t),outside=await fixture(t);await symlink(outside,join(root,'.rivet'));let invoked=false;
 const result=await collectSupportBundle(root,{environment:{},diagnose:async()=>{invoked=true;return report}});
 assert.equal(result.configuration.status,'unsafe');assert.equal(invoked,false);
});

test('external package-manager wrappers cannot follow project redirects or enable Corepack downloads',async t=>{
 const root=await fixture(t),outside=await fixture(t),marker=join(root,'redirect-executed');
 await writeFile(join(root,'.yarnrc.yml'),'yarnPath: ./project-manager.cjs\n');
 await writeFile(join(root,'package.json'),' {"packageManager":"yarn@99.99.99"}\n');
 const wrapper=`#!/bin/sh
if [ -f "$PWD/.yarnrc.yml" ] || [ -f "$PWD/package.json" ]; then printf unsafe > '${marker}'; exit 71; fi
if [ "$YARN_IGNORE_PATH" != 1 ] || [ "$COREPACK_ENABLE_PROJECT_SPEC" != 0 ] || [ "$COREPACK_ENABLE_NETWORK" != 0 ] || [ "$COREPACK_ENABLE_AUTO_PIN" != 0 ] || [ "$COREPACK_DEFAULT_TO_LATEST" != 0 ]; then printf unsafe > '${marker}'; exit 72; fi
printf '4.9.0\\n'
`;
 await writeFile(join(outside,'yarn'),wrapper,{mode:0o700});let observed;
 const result=await collectSupportBundle(root,{environment:{PATH:outside,COREPACK_ENABLE_NETWORK:'1',COREPACK_ENABLE_AUTO_PIN:'1',YARN_IGNORE_PATH:'0'},
  diagnose:async(path,options)=>{observed=await options.runner('yarn',['--version'],{cwd:path});return report}});
 assert.equal(result.collection.status,'complete');assert.equal(observed.code,0);assert.equal(observed.stdout.trim(),'4.9.0');
 await assert.rejects(access(marker),{code:'ENOENT'});
});
