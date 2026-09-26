import { lstat, realpath, open, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { ensure, hash, sha } from './contract.js';
import { parseRepositoryRemote } from '../repositories/identity.js';
import { runPublicationProcess } from './publication-process.js';

export function publicationAuthorization(provider, token) {
  const username={github:'x-access-token',gitlab:'oauth2',bitbucket:'x-token-auth'}[provider];
  ensure(username && typeof token==='string' && token.length>0 && token.length<=8192 && !/[\s\u0000-\u001f\u007f]/.test(token),'invalid-credentials');
  return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}
function outside(root,path) {const rel=relative(root,path);return rel==='..'||rel.startsWith('../')||isAbsolute(rel);}
function identity(stat) {return `${stat.dev}:${stat.ino}`;}
async function directory(path) {
  ensure(typeof path==='string' && isAbsolute(path) && !/[\u0000-\u001f\u007f:]/.test(path),'unsafe-object-store');
  ensure(await realpath(path)===path,'unsafe-object-store');
  const stat=await lstat(path);ensure(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe-object-store');return identity(stat);
}
async function native(path,project) {
  ensure(isAbsolute(path) && await realpath(path)===path && outside(project,path),'unsafe-git-executable');
  const stat=await lstat(path);ensure(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o111)!==0,'unsafe-git-executable');
  const handle=await open(path,'r');let magic;
  try {const opened=await handle.stat();ensure(identity(opened)===identity(stat),'unsafe-git-executable');const data=Buffer.alloc(4);ensure((await handle.read(data,0,4,0)).bytesRead===4,'unsafe-git-executable');magic=data.toString('hex');}
  finally {await handle.close();}
  ensure(['7f454c46','cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic),'unsafe-git-executable');
  return `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
async function inspectObjects(root) {
  const rootId=await directory(root);let count=0;
  async function visit(path,depth) {
    ensure(depth<=3,'unsafe-object-store');
    for(const entry of await readdir(path,{withFileTypes:true})) {
      ensure(++count<=200000 && !entry.isSymbolicLink(),'unsafe-object-store');
      const child=join(path,entry.name);const stat=await lstat(child);
      ensure(!stat.isSymbolicLink()&&(stat.isFile()||stat.isDirectory()),'unsafe-object-store');
      if(path===join(root,'info')) ensure(!['alternates','http-alternates'].includes(entry.name),'unsafe-object-store');
      if(stat.isDirectory()) await visit(child,depth+1);
    }
  }
  await visit(root,0);ensure(await directory(root)===rootId,'unsafe-object-store');return rootId;
}
export function publicationRef(branch) {
  ensure(typeof branch==='string'&&/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(branch)&&!branch.includes('..')&&!branch.includes('//')&&!branch.includes('@{')&&!branch.endsWith('/')&&!branch.endsWith('.')&&!branch.split('/').some(p=>p.startsWith('.')||p.endsWith('.lock')),'invalid-branch');
  return `refs/heads/${branch}`;
}
export async function createGitPublicationTransport({gitExecutable,sourceObjects,project,repository,token,runner=runPublicationProcess,signal}) {
  ensure(hash(parseRepositoryRemote(repository.url))===hash(repository),'invalid-destination');
  const destination=repository.url+'.git';const projectRoot=await realpath(project);
  const executableId=await native(gitExecutable,projectRoot);
  const objectsId=await inspectObjects(sourceObjects);
  const authorization=publicationAuthorization(repository.provider,token);
  const cleanBase={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/usr/bin/false',SSH_ASKPASS:'/usr/bin/false',GIT_ALLOW_PROTOCOL:'https',GIT_PROTOCOL_FROM_USER:'0'};
  const probe=await runner(gitExecutable,['--exec-path'],{cwd:'/',env:{...cleanBase,HOME:'/nonexistent',GIT_CONFIG_GLOBAL:'/dev/null'},timeoutMs:3000,signal});
  ensure(probe.code===0&&!probe.reason&&typeof probe.stdout==='string','unsafe-git-executable');
  const execPath=probe.stdout.trim();const execPathId=await directory(execPath);
  ensure(outside(projectRoot,execPath),'unsafe-git-executable');
  const helpers=[];
  for (const name of ['git','git-send-pack','git-pack-objects','git-remote-http','git-remote-https']) {
    const path=await realpath(join(execPath,name));helpers.push({name,path,identity:await native(path,projectRoot)});
  }
  async function validateTools() {
    ensure(await native(gitExecutable,projectRoot)===executableId && await directory(execPath)===execPathId,'changed-git-executable');
    for(const helper of helpers) ensure(await realpath(join(execPath,helper.name))===helper.path && await native(helper.path,projectRoot)===helper.identity,'changed-git-executable');
  }
  async function withRepository(operation) {
    await validateTools();
    ensure(await inspectObjects(sourceObjects)===objectsId,'changed-object-store');
    const scratch=await realpath(await mkdtemp(join(tmpdir(),'rivet-publish-')));
    try {
      const bare=join(scratch,'repository.git');const empty=join(scratch,'empty');await mkdir(empty);
      const settings=[['credential.helper',''],['core.hooksPath',empty],['http.sslVerify','true'],['http.followRedirects','false'],['http.proxy',''],['http.cookieFile',''],['http.saveCookies','false'],['http.extraHeader',authorization],['protocol.allow','never'],['protocol.https.allow','always'],['push.followTags','false'],['push.gpgSign','false'],['push.recurseSubmodules','no'],['core.sshCommand','/usr/bin/false'],['core.useReplaceRefs','false'],['core.commitGraph','false'],['gc.auto','0'],['maintenance.auto','false']];
      const env={...cleanBase,HOME:scratch,XDG_CONFIG_HOME:empty,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_EXEC_PATH:execPath,GIT_TEMPLATE_DIR:empty,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_COUNT:String(settings.length),GIT_ALTERNATE_OBJECT_DIRECTORIES:sourceObjects};
      settings.forEach(([key,value],i)=>{env[`GIT_CONFIG_KEY_${i}`]=key;env[`GIT_CONFIG_VALUE_${i}`]=value;});
      const run=async(args,timeoutMs=10000,deadline)=>{
        await validateTools();
        const boundedTimeout=deadline===undefined?timeoutMs:Math.min(timeoutMs,Date.parse(deadline)-Date.now());
        ensure(boundedTimeout>0,'expired-proposal');
        const result=await runner(gitExecutable,args,{cwd:scratch,env,timeoutMs:boundedTimeout,signal,maxOutputBytes:65536});
        ensure(result.code===0&&!result.reason,'publication-outcome-uncertain');return result.stdout;
      };
      await run(['init','--bare','--template=',bare]);
      return await operation((args,timeout,deadline)=>run(['--git-dir='+bare,...args],timeout,deadline));
    } finally {await rm(scratch,{recursive:true,force:true});}
  }
  async function readRefs(target) {
    ensure(hash(target.repository)===hash(repository),'invalid-destination');
    const source=publicationRef(target.sourceBranch),base=publicationRef(target.targetBranch);ensure(source!==base,'invalid-branch');
    return withRepository(async run=>{
      const output=await run(['ls-remote','--refs','--exit-code',destination,source,base]);
      const refs=new Map();for(const line of output.trim().split('\n').filter(Boolean)) {
        const match=/^([a-f0-9]{40})\t(refs\/heads\/[^\s]+)$/.exec(line);
        ensure(match&&[source,base].includes(match[2])&&!refs.has(match[2]),'invalid-remote-observation');refs.set(match[2],match[1]);
      }
      ensure(refs.has(base),'missing-target-branch');return {sourceSha:refs.get(source)??null,baseSha:refs.get(base)};
    });
  }
  async function push(target,{deadline}) {
    ensure(hash(target.repository)===hash(repository),'invalid-destination');sha(target.headSha);
    const ref=publicationRef(target.sourceBranch);ensure(ref!==publicationRef(target.targetBranch),'invalid-branch');
    const remaining=()=>Math.min(60000,Date.parse(deadline)-Date.now());ensure(remaining()>0,'expired-proposal');
    return withRepository(async run=>{
      ensure((await run(['cat-file','-t',target.headSha])).trim()==='commit','invalid-source-commit');
      ensure(await directory(sourceObjects)===objectsId,'changed-object-store');
      ensure(remaining()>0,'expired-proposal');
      await run(['push','--porcelain','--no-verify','--no-follow-tags','--recurse-submodules=no','--signed=false',`--force-with-lease=${ref}:`,destination,`${target.headSha}:${ref}`],60000,deadline);
    });
  }
  return Object.freeze({readRefs,push});
}

export async function validatePublicationExecutable(executable,project) {return native(executable,await realpath(project));}
