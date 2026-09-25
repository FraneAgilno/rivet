import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../../src/repositories/index.js';

test('parses cloud HTTPS and SSH remotes including nested GitLab namespaces', () => {
  assert.equal(typeof api.parseRepositoryRemote, 'function');
  for (const url of ['git@gitlab.com:team/sub/repo.git', 'ssh://git@gitlab.com/team/sub/repo.git', 'https://gitlab.com/team/sub/repo.git']) {
    assert.deepEqual(api.parseRepositoryRemote(url), {provider:'gitlab',host:'gitlab.com',namespace:'team/sub',name:'repo',fullName:'team/sub/repo',url:'https://gitlab.com/team/sub/repo'});
  }
  assert.equal(api.parseRepositoryRemote('git@github.com:team/repo.git').provider,'github');
  assert.equal(api.parseRepositoryRemote('https://bitbucket.org/team/repo').provider,'bitbucket');
});
test('rejects credentials, unsupported hosts, path traversal and malformed remotes', () => {
  assert.equal(typeof api.parseRepositoryRemote, 'function');
  for (const url of ['https://secret@github.com/a/b','https://github.com/a/../b','https://github.com/a/b?token=secret','https://github.com/a/b#x','https://other.test/a/b','file:///a/b','https://github.com/a/b/c','https://gitlab.com/a/%2e%2e/b','ssh://git@github.com:2222/a/b','https://github.com/a/b%2fc']) assert.throws(()=>api.parseRepositoryRemote(url), {code:'ERR_PROVIDER_INVALID_REQUEST'});
});
test('requires selection for conflicting remotes and deduplicates matching identities', () => {
  assert.equal(typeof api.selectRepositoryRemote,'function');
  const remotes=[{name:'origin',url:'git@github.com:a/b.git'},{name:'upstream',url:'https://github.com:c/d'}];
  remotes[1].url='https://github.com/c/d';
  assert.throws(()=>api.selectRepositoryRemote(remotes),{code:'ERR_PROVIDER_INVALID_REQUEST'});
  assert.equal(api.selectRepositoryRemote(remotes,{remoteName:'upstream'}).fullName,'c/d');
  assert.equal(api.selectRepositoryRemote([remotes[0],{name:'push',url:'https://github.com/a/b'}]).fullName,'a/b');
  assert.throws(()=>api.selectRepositoryRemote(remotes,{remoteName:'missing'}));
});
test('discovers fetch remotes using bounded shell-free git calls',async()=>{
  assert.equal(typeof api.discoverRepositoryRemotes,'function');
  const calls=[];
  const result=await api.discoverRepositoryRemotes('/tmp/project',{runner:async(command,args,options)=>{calls.push({command,args,options});return {code:0,stdout:'origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n'};}});
  assert.deepEqual(result,[{name:'origin',url:'git@github.com:a/b.git'}]);
  assert.equal(calls[0].options.shell,false);
  assert.equal(calls[0].options.maxOutputBytes,32768);
});
test('explicit remote selection ignores unrelated unsupported remote without echoing it',async()=>{
  const remotes=await api.discoverRepositoryRemotes('/tmp/project',{runner:async()=>({code:0,stdout:'origin\thttps://github.com/team/repo (fetch)\nbackup\tfile:///tmp/backup (fetch)\n'})});
  assert.equal(api.selectRepositoryRemote(remotes,{remoteName:'origin'}).fullName,'team/repo');
  assert.throws(()=>api.selectRepositoryRemote(remotes),{code:'ERR_PROVIDER_INVALID_REQUEST'});
});
test('partial or timed-out remote discovery cannot select from incomplete output',async()=>{
  for(const extra of [{timedOut:true},{truncated:{stdout:true}}]) await assert.rejects(api.discoverRepositoryRemotes('/tmp/project',{runner:async()=>({code:0,stdout:'origin\thttps://github.com/team/repo (fetch)\n',...extra})}));
});
