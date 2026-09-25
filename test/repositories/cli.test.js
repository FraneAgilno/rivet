import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-repository-cli-')));
  t.after(() => rm(root, {recursive:true,force:true}));
  await cp(new URL('../fixtures/config/valid/.rivet', import.meta.url), join(root,'.rivet'), {recursive:true});
  await mkdir(join(root,'nested'));
  const project = parse(await readFile(join(root,'.rivet/project.yaml'),'utf8'));
  const originalProviders = parse(await readFile(join(root,'.rivet/providers.yaml'),'utf8')).providers;
  const provider = {id:'github-main',kind:'git-ci',mode:'read-only',capabilities:['repository-read','checks-read'],
    endpoint:'https://api.github.com',resourceIds:['team/demo'],projectIds:[project.id],credentials:{tokenEnv:'TEST_REPO_TOKEN'},...changes};
  await writeFile(join(root,'.rivet/providers.yaml'),stringify({schemaVersion:1,providers:[...originalProviders,provider]}));
  let calls = 0, output = '';
  let respond;
  const transport = createTrustedProviderTransport({resolve:async()=>['140.82.113.6'],fetchPinned:async(url,init)=>{
    calls++;
    assert.equal(init.method,'GET');
    assert.equal(init.headers.authorization,'Bearer sample-token');
    if (respond) return respond(url,init);
    assert.equal(new URL(url).pathname,'/repos/team/demo');
    return new Response(JSON.stringify({id:1,full_name:'team/demo',default_branch:'main',private:false,html_url:'https://github.com/team/demo'}));
  }});
  const deps = {env:{TEST_REPO_TOKEN:'sample-token'},cwd:()=>join(root,'nested'),runGit:async()=>({code:0,stdout:root+'\n'}),
    repositories:{transport,discoverRemotes:async()=>[{name:'origin',url:'git@github.com:team/demo.git'}]},
    output:createOutput({stdout:{write:s=>output+=s},stderr:{write:s=>output+=s}})};
  return {root,provider,deps,setResponse:fn=>{respond=fn;},calls:()=>calls,result:()=>JSON.parse(output),setProviders:items=>writeFile(join(root,'.rivet/providers.yaml'),stringify({schemaVersion:1,providers:[...originalProviders,...items]}))};
}

test('repository inspect detects configured project from subdirectory and performs a scoped read',async t=>{
  const f=await fixture(t);
  assert.equal(await main(['repositories','inspect','--json'],f.deps),0);
  assert.equal(f.calls(),1);
  assert.equal(f.result().result.repository.fullName,'team/demo');
  assert.equal(f.result().result.networkChecked,true);
  assert.doesNotMatch(JSON.stringify(f.result()),/sample-token/);
});

test('repository CLI requires explicit selection for distinct remotes and providers',async t=>{
  const f=await fixture(t);
  f.deps.repositories.discoverRemotes=async()=>[{name:'origin',url:'git@github.com:team/demo.git'},{name:'upstream',url:'git@github.com:else/demo.git'}];
  assert.equal(await main(['repositories','inspect','--json'],f.deps),EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(f.calls(),0);
  await f.setProviders([f.provider,{...f.provider,id:'second'}]);
  assert.equal(await main(['repositories','inspect','--remote=origin','--json'],f.deps),EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(f.calls(),0);
});

for (const changes of [{resourceIds:['other/repo']},{projectIds:['other']},{endpoint:'https://example.com'},
  {transport:'harness-mcp'},{mode:'disabled'},{capabilities:['checks-read']}]) {
  test(`repository CLI rejects nonapplicable provider before network: ${JSON.stringify(changes)}`,async t=>{
    const f=await fixture(t,changes);
    assert.equal(await main(['repositories','inspect','--json'],f.deps),EXIT_CODES.MISSING_CONFIGURATION);
    assert.equal(f.calls(),0);
  });
}

test('repository CLI validates review numbers and credentials before provider calls',async t=>{
  const f=await fixture(t);
  for(const review of ['0','-1','1.5','1e3','999999999999999999999']) {
    assert.equal(await main(['repositories','inspect',`--review=${review}`,'--json'],f.deps),EXIT_CODES.INVALID_INPUT);
  }
  f.deps.env={};
  assert.equal(await main(['repositories','inspect','--json'],f.deps),EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(f.calls(),0);
});


test('repository CLI inspects a real-shaped GitHub review through the provider boundary',async t=>{
  const f=await fixture(t), sha='a'.repeat(40);
  f.setResponse(url=>{
    const path=new URL(url).pathname;
    const data=path.endsWith('/pulls/14')
      ? {number:14,state:'open',merged:false,title:'Review',head:{sha,ref:'feature'},base:{sha:'b'.repeat(40),ref:'main'},html_url:'https://github.com/team/demo/pull/14'}
      : path.endsWith('/check-runs') ? {total_count:1,check_runs:[{id:1,name:'check',head_sha:sha,status:'completed',conclusion:'success'}]}
      : path.endsWith('/reviews') || path.endsWith('/statuses') ? []
      : {id:1,full_name:'team/demo',default_branch:'main',private:false,html_url:'https://github.com/team/demo'};
    return new Response(JSON.stringify(data));
  });
  assert.equal(await main(['repositories','inspect','--review','14','--remote','origin','--provider','github-main','--json'],f.deps),0);
  const result=f.result().result;
  assert.equal(result.observation.reviewRequest.headSha,sha);
  assert.equal(result.observation.checks.items[0].state,'success');
  assert.equal(result.observation.checks.requiredPolicy,'unknown');
});

test('repository CLI suppresses provider error payloads',async t=>{
  const f=await fixture(t);
  f.setResponse(()=>new Response(JSON.stringify({message:'sample-token private diagnostics'}),{status:403}));
  assert.equal(await main(['repositories','inspect','--json'],f.deps),EXIT_CODES.PROVIDER_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(f.result()),/sample-token|private diagnostics/);
});

test('remote discovery uses the same configured Git executable as project discovery',async t=>{
  const f=await fixture(t);
  f.deps.env.RIVET_GIT_EXECUTABLE='/usr/bin/git';
  const commands=[];
  f.deps.runGit=async(command,args)=>{
    commands.push({command,args});
    return {code:0,stdout:f.root+'\n'};
  };
  f.deps.repositories.discoverRemotes=async(root,options)=>{
    assert.equal(root,f.root);
    await options.runner('git',['remote','-v'],{cwd:root});
    return [{name:'origin',url:'https://github.com/team/demo'}];
  };
  assert.equal(await main(['repositories','inspect','--json'],f.deps),0);
  assert.equal(commands.length,2);
  assert.equal(commands[0].command,commands[1].command);
  assert.notEqual(commands[1].command,'git');
});

test('review inspection requires checks-read before accessing the provider',async t=>{
  const f=await fixture(t,{capabilities:['repository-read']});
  assert.equal(await main(['repositories','inspect','--review=14','--json'],f.deps),EXIT_CODES.MISSING_CONFIGURATION);
  assert.equal(f.calls(),0);
});
