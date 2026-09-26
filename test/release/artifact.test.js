import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseArtifact, verifyReleaseArtifact, parseReleaseArguments } from '../../scripts/release-artifact.mjs';
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:cwd,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
async function fixture(t) {
 const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-release-test-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 const sourceRoot=join(parent,'source');await mkdir(sourceRoot);
 const pkg={name:'@agilno/rivet',version:'0.1.0-alpha.0',private:true,license:'UNLICENSED',bin:{rivet:'bin/cli.js'},files:['bin/']};
 await mkdir(join(sourceRoot,'bin'));await writeFile(join(sourceRoot,'bin','cli.js'),'#!/usr/bin/env node\nconsole.log("fixture");\n',{mode:0o755});
 await writeFile(join(sourceRoot,'package.json'),JSON.stringify(pkg));await writeFile(join(sourceRoot,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':pkg}}));
 git(sourceRoot,['init','-q','--initial-branch=main']);git(sourceRoot,['config','user.name','Fixture']);git(sourceRoot,['config','user.email','fixture@example.invalid']);git(sourceRoot,['add','.']);git(sourceRoot,['commit','-qm','fixture']);git(sourceRoot,['tag','v0.1.0-alpha.0']);
 return {sourceRoot,outputDirectory:join(parent,'candidate'),tag:'v0.1.0-alpha.0',expectedSourceSha:git(sourceRoot,['rev-parse','HEAD'])};
}
test('packs one immutable prerelease artifact with source/version bindings and verifiable checksums',async t=>{
 const input=await fixture(t);const result=await createReleaseArtifact(input);
 assert.equal(result.package.name,'@agilno/rivet');assert.equal(result.package.private,true);assert.equal(result.package.license,'UNLICENSED');assert.equal(result.source.commit,input.expectedSourceSha);
 assert.equal(result.qualification.publishedChannel,'not-tested');assert.equal(result.qualification.independentPilot,'not-evaluated');
 assert.equal((await verifyReleaseArtifact({directory:input.outputDirectory,expectedSourceSha:input.expectedSourceSha,tag:input.tag})).artifact.sha256,result.artifact.sha256);
 const bytes=await readFile(join(input.outputDirectory,result.artifact.filename));await assert.rejects(()=>createReleaseArtifact(input));assert.deepEqual(await readFile(join(input.outputDirectory,result.artifact.filename)),bytes);
});
test('dirty sources, wrong commit/tag and output inside the source are rejected before packing',async t=>{
 const input=await fixture(t);
 await assert.rejects(()=>createReleaseArtifact({...input,expectedSourceSha:'0'.repeat(40)}));await assert.rejects(()=>createReleaseArtifact({...input,tag:'v0.2.0-alpha.0'}));await assert.rejects(()=>createReleaseArtifact({...input,outputDirectory:join(input.sourceRoot,'release')}));
 await writeFile(join(input.sourceRoot,'untracked.txt'),'dirty');await assert.rejects(()=>createReleaseArtifact(input));
});
test('verification rejects changed artifact, changed metadata, path traversal and conflicting expected identity',async t=>{
 const input=await fixture(t);const result=await createReleaseArtifact(input);const artifact=join(input.outputDirectory,result.artifact.filename);const original=await readFile(artifact);
 await writeFile(artifact,Buffer.concat([original,Buffer.from('tampered')]));await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory}));await writeFile(artifact,original);
 await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory,expectedSourceSha:'f'.repeat(40)}));
 const path=join(input.outputDirectory,'release-manifest.json');const metadata=await readFile(path,'utf8');const changed=JSON.parse(metadata);changed.artifact.filename='../outside.tgz';await writeFile(path,JSON.stringify(changed));await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory}));await writeFile(path,metadata);
 await writeFile(join(input.outputDirectory,'SHA256SUMS'),'forged');await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory}));
});
test('release CLI accepts only explicit build/verify inputs and rejects arbitrary executable options',()=>{
 assert.equal(parseReleaseArguments(['build','--source=/tmp/repo','--out=/tmp/artifact','--tag=v0.1.0-alpha.0','--sha='+'a'.repeat(40)]).command,'build');
 for(const args of [['build','--command=sh'],['build','--sha=a','--sha=b'],['publish'],['verify','--directory=/tmp','--tag=../other']])assert.throws(()=>parseReleaseArguments(args));
});
test('ignored dependencies and generated content cannot enter the exact commit snapshot',async t=>{
 const input=await fixture(t);
 await writeFile(join(input.sourceRoot,'.gitignore'),'node_modules/\n*.secret\n');git(input.sourceRoot,['add','.gitignore']);git(input.sourceRoot,['commit','-qm','ignore fixtures']);git(input.sourceRoot,['tag','-f',input.tag]);input.expectedSourceSha=git(input.sourceRoot,['rev-parse','HEAD']);
 await mkdir(join(input.sourceRoot,'node_modules'));await writeFile(join(input.sourceRoot,'node_modules','fixture.txt'),'ignored dependency');
 await createReleaseArtifact(input);
 await writeFile(join(input.sourceRoot,'bin','ignored.secret'),'must not ship');
 const clean=await createReleaseArtifact({...input,outputDirectory:input.outputDirectory+'-clean'});
 const listing=execFileSync('/usr/bin/tar',['-tzf',join(input.outputDirectory+'-clean',clean.artifact.filename)],{encoding:'utf8'});
 assert.ok(!listing.includes('ignored.secret'));assert.ok(!listing.includes('node_modules'));
});
test('package identity/license changes and mismatched lock metadata are rejected',async t=>{
 for(const change of ['license','private','lock']) {
  const input=await fixture(t);const path=join(input.sourceRoot,change==='lock'?'package-lock.json':'package.json');const data=JSON.parse(await readFile(path,'utf8'));
  if(change==='license')data.license='MIT';else if(change==='private')data.private=false;else data.version='0.1.0-alpha.1';
  await writeFile(path,JSON.stringify(data));git(input.sourceRoot,['add','.']);git(input.sourceRoot,['commit','-qm','changed metadata']);git(input.sourceRoot,['tag','-f',input.tag]);input.expectedSourceSha=git(input.sourceRoot,['rev-parse','HEAD']);
  await assert.rejects(()=>createReleaseArtifact(input));
 }
});
test('verification rejects symlinked assets and extra files even when recorded checksums otherwise match',async t=>{
 const {rename,symlink,unlink}=await import('node:fs/promises');const input=await fixture(t);const result=await createReleaseArtifact(input);
 const artifact=join(input.outputDirectory,result.artifact.filename),outside=input.outputDirectory+'-copy.tgz';await rename(artifact,outside);await symlink(outside,artifact);
 await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory}));await unlink(artifact);await rename(outside,artifact);
 await writeFile(join(input.outputDirectory,'extra.txt'),'extra');await assert.rejects(()=>verifyReleaseArtifact({directory:input.outputDirectory}));
});
test('pack lifecycle hooks are rejected before npm can execute prepare despite ignore-scripts',async t=>{
 const input=await fixture(t);const path=join(input.sourceRoot,'package.json');const pkg=JSON.parse(await readFile(path,'utf8'));
 pkg.scripts={prepare:'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\',\'unsafe\')"'};await writeFile(path,JSON.stringify(pkg));git(input.sourceRoot,['add','.']);git(input.sourceRoot,['commit','-qm','lifecycle fixture']);git(input.sourceRoot,['tag','-f',input.tag]);input.expectedSourceSha=git(input.sourceRoot,['rev-parse','HEAD']);
 await assert.rejects(()=>createReleaseArtifact(input),error=>error.code==='ERR_RELEASE_PACK_LIFECYCLE_HOOKS_UNSUPPORTED');
 assert.equal(await readFile(join(input.sourceRoot,'lifecycle-ran')).then(()=>true,()=>false),false);
});
test('index flags cannot hide modified bytes from the exact tagged commit',async t=>{
 for(const flag of ['--assume-unchanged','--skip-worktree']) {
  const input=await fixture(t);git(input.sourceRoot,['update-index',flag,'bin/cli.js']);
  await writeFile(join(input.sourceRoot,'bin/cli.js'),'#!/usr/bin/env node\nconsole.log("UNCOMMITTED");\n');
  assert.equal(git(input.sourceRoot,['status','--porcelain']),'');
  await assert.rejects(()=>createReleaseArtifact(input),error=>error.code==='ERR_RELEASE_SOURCE_BLOB_MISMATCH');
 }
});
test('Git replacement blobs cannot redefine the contents of the claimed source commit',async t=>{
 const input=await fixture(t);const original=git(input.sourceRoot,['rev-parse','HEAD:bin/cli.js']);
 const path=join(input.sourceRoot,'bin/cli.js');await writeFile(path,'#!/usr/bin/env node\nconsole.log("REPLACEMENT");\n');
 const replacement=git(input.sourceRoot,['hash-object','-w','bin/cli.js']);git(input.sourceRoot,['replace',original,replacement]);
 git(input.sourceRoot,['update-index','--assume-unchanged','bin/cli.js']);
 assert.equal(git(input.sourceRoot,['status','--porcelain']),'');
 await assert.rejects(()=>createReleaseArtifact(input),error=>error.code==='ERR_RELEASE_SOURCE_BLOB_MISMATCH');
});
test('Git replacement commits cannot substitute another tree under the release source SHA',async t=>{
 const input=await fixture(t);await writeFile(join(input.sourceRoot,'bin/cli.js'),'#!/usr/bin/env node\nconsole.log("OTHER TREE");\n');
 git(input.sourceRoot,['add','bin/cli.js']);const tree=git(input.sourceRoot,['write-tree']);
 const replacement=git(input.sourceRoot,['commit-tree',tree,'-m','replacement fixture']);
 git(input.sourceRoot,['reset','--mixed','HEAD']);git(input.sourceRoot,['update-index','--assume-unchanged','bin/cli.js']);
 git(input.sourceRoot,['replace',input.expectedSourceSha,replacement]);
 await assert.rejects(()=>createReleaseArtifact(input),error=>error.code==='ERR_RELEASE_SOURCE_BLOB_MISMATCH');
});
