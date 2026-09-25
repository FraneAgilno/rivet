import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import * as locks from '../../src/state/lock.js';
const AGE = Date.now() - 600_000;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return { root, path: join(root, 'state.lock'), owner: { pid: child.pid, host: hostname(), timestamp: new Date(AGE).toISOString(), ownerId: randomUUID() } };
}
async function put(f, patch={}) { await writeFile(f.path, JSON.stringify({...f.owner,...patch}), {mode:0o600}); }
test('abandoned recovery requires a stale same-host dead process and preserves live locks', async t => {
  const f = await fixture(t);
  assert.equal(typeof locks.recoverAbandonedLock, 'function');
  assert.equal(await locks.recoverAbandonedLock(f.path), false);
  for (const patch of [{pid:process.pid}, {host:'another-host'}, {timestamp:new Date().toISOString()}, {pid:-1}]) {
    await put(f,patch);
    const before=await readFile(f.path);
    await assert.rejects(locks.recoverAbandonedLock(f.path));
    assert.deepEqual(await readFile(f.path),before);
    await rm(f.path);
  }
  await put(f);
  assert.equal(await locks.recoverAbandonedLock(f.path),true);
  await assert.rejects(lstat(f.path),{code:'ENOENT'});
});
test('recovery rejects symbolic, hardlinked, permissive, and malformed lock files', async t => {
  const f=await fixture(t), other=join(f.root,'other');
  await put(f);
  await link(f.path,other);
  await assert.rejects(locks.recoverAbandonedLock(f.path));
  await rm(f.path);
  await symlink(other,f.path);
  await assert.rejects(locks.recoverAbandonedLock(f.path));
  await rm(f.path);
  await writeFile(f.path,'invalid',{mode:0o600});
  await assert.rejects(locks.recoverAbandonedLock(f.path));
  await rm(f.path);
  await writeFile(f.path,JSON.stringify(f.owner),{mode:0o644});
  await assert.rejects(locks.recoverAbandonedLock(f.path));
});
test('concurrent recovery cannot remove the replacement owner and keeps a permanent claim', async t => {
  const f=await fixture(t); await put(f);
  let replacement, removals=0;
  const recover=async()=>{
    if(await locks.recoverAbandonedLock(f.path)) { removals++; replacement=await locks.acquireLock(f.path); }
  };
  await Promise.allSettled(Array.from({length:16},recover));
  assert.equal(removals,1);
  assert.equal(JSON.parse(await readFile(f.path)).ownerId,replacement.owner.ownerId);
  await replacement.release();
  await put(f);
  await assert.rejects(locks.recoverAbandonedLock(f.path));
  assert.equal(JSON.parse(await readFile(f.path)).ownerId,f.owner.ownerId);
});

test('an interrupted recovery claim is never reused or deleted', async t => {
  const f=await fixture(t); await put(f);
  const claim=`${f.path}.recovered-${f.owner.ownerId}`;
  await writeFile(claim,'',{mode:0o600});
  await assert.rejects(locks.recoverAbandonedLock(f.path), /already claimed/);
  assert.equal(JSON.parse(await readFile(f.path)).ownerId,f.owner.ownerId);
  assert.equal((await lstat(claim)).size,0);
});

test('SIGKILL after committed dispatch recovers both locks and reconciles without dispatching again', {timeout:15000}, async t => {
  const {resolveStatePaths}=await import('../../src/state/paths.js');
  const {createDeliveryStore}=await import('../../src/delivery/store.js');
  const {createDeliveryService,createTrustedDeliveryExecutor}=await import('../../src/delivery/service.js');
  const {createApprovalRegistry}=await import('../../src/policy/approvals.js');
  const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');
  const f=await fixture(t);
  execFileSync('git',['init','-q',f.root]);
  const at='2026-09-25T10:00:00.000Z', sha='a'.repeat(40), base='b'.repeat(40), digest='d'.repeat(64);
  const repository={provider:'github',host:'github.com',namespace:'team',name:'repo',fullName:'team/repo',url:'https://github.com/team/repo'};
  const initial={runId:'crash-one',repository,sourceBranch:'feature',targetBranch:'main',reviewNumber:7,
    localVerification:{runId:'crash-one',status:'passed',headSha:sha,evidenceDigest:digest,verifiedAt:at}};
  const observation={repositoryUrl:repository.url,sourceBranch:'feature',targetBranch:'main',headSha:sha,baseSha:base,
    review:{number:7,state:'open',url:repository.url+'/pull/7',headSha:sha},
    checks:{headSha:sha,policy:'known',satisfied:true,evidenceDigest:digest},
    reviews:{headSha:sha,policy:'known',satisfied:true,evidenceDigest:digest},observedAt:at};
  const paths=await resolveStatePaths(f.root,'crash-one');
  const modules=['state/paths','state/lock','delivery/store','delivery/service','policy/approvals','policy/authority'];
  const imports=modules.map((m,i)=>`const m${i}=await import(${JSON.stringify(new URL(`../../src/${m}.js`,import.meta.url).href)});`).join('\n');
  const source=`${imports}
    const {writeFile}=await import('node:fs/promises');
    const paths=await m0.resolveStatePaths(${JSON.stringify(f.root)},'crash-one');
    const store=m2.createDeliveryStore(paths);
    const executor=m3.createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'merge',conditionalHead:true,reconcile:true}],
      observe:async()=>(${JSON.stringify(observation)}),
      dispatch:async()=>{
        await writeFile(${JSON.stringify(join(f.root,'dispatch-count'))},'1');
        await m1.acquireLock(paths.lockPath);
        process.send({ready:true});
        await new Promise(()=>setInterval(()=>{},1000));
      }, reconcile:async()=>({status:'unknown'})});
    const service=m3.createDeliveryService({store,executor,providerId:'github-primary',subjectId:'worker',expectedApproverId:'owner',clock:()=>${JSON.stringify(at)},
      approvalRegistry:m4.createApprovalRegistry({approvers:[{id:'owner',principal:'human'}]}),
      authority:m5.createAuthorityEnvelope({actorId:'worker',principal:'agent',actions:['provider.write'],ownedPaths:[],commands:[],providers:[{id:'github-primary',mode:'read-write-with-approval',capabilities:['merge']}]})});
    let s=await service.initialize(${JSON.stringify(initial)});
    s=await service.refresh({expectedVersion:s.version});
    s=await service.propose({expectedVersion:s.version,action:'merge',payload:{method:'squash'},expiresAt:'2026-09-25T10:30:00.000Z'});
    await service.execute({expectedVersion:s.version,proposalDigest:s.proposal.digest,approval:m4.createApprovalReceipt({id:'crash-approval',approverId:'owner',approverPrincipal:'human',subjectId:'worker',action:'provider.write',resource:s.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt:'2026-09-25T11:00:00.000Z',singleUse:true})});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')});
  await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(`Child exited before dispatch: ${errors}`)})]);
  const store=createDeliveryStore(paths,{recoveryNow:()=>Date.now()+600_000});
  const before=await readFile(paths.snapshotPath);
  assert.equal((await store.read()).operations[0].state,'dispatching');
  await assert.rejects(store.recover(), /still running/);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await assert.rejects(createDeliveryStore(paths).recover());
  assert.deepEqual(await store.recover(),{recoveredLocks:['operation','snapshot']});
  assert.deepEqual(await readFile(paths.snapshotPath),before);
  assert.deepEqual(await store.recover(),{recoveredLocks:[]});
  let dispatches=0, reconciles=0;
  const executor=createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'merge',conditionalHead:true,reconcile:true}],
    observe:async()=>observation,
    dispatch:async()=>{dispatches++;throw new Error('Must not dispatch')},
    reconcile:async operation=>{reconciles++;return {status:'succeeded',receipt:{status:'succeeded',operationDigest:operation.digest,headSha:sha,evidenceDigest:digest,resourceUrl:repository.url+'/pull/7',commitSha:base}}}});
  const service=createDeliveryService({store,executor,providerId:'github-primary',subjectId:'worker',expectedApproverId:'owner',clock:()=>at,
    approvalRegistry:createApprovalRegistry({approvers:[{id:'owner',principal:'human'}]}),
    authority:createAuthorityEnvelope({actorId:'worker',principal:'agent',actions:['provider.write'],ownedPaths:[],commands:[],providers:[{id:'github-primary',mode:'read-write-with-approval',capabilities:['merge']}]})});
  const beforeState=await store.read();
  const result=await service.reconcile({expectedVersion:beforeState.version});
  assert.equal(result.stage,'merged');
  assert.equal(result.operations[0].state,'succeeded');
  assert.deepEqual(result.usedApprovalIds,beforeState.usedApprovalIds);
  assert.equal(reconciles,1);assert.equal(dispatches,0);
  assert.equal(await readFile(join(f.root,'dispatch-count'),'utf8'),'1');
});

test('delivery recovery verifies branded directories and rejects a live snapshot owner under its operation lock', async t => {
  const {resolveStatePaths}=await import('../../src/state/paths.js');
  const {createDeliveryStore}=await import('../../src/delivery/store.js');
  const f=await fixture(t);
  execFileSync('git',['init','-q',f.root]);
  const paths=await resolveStatePaths(f.root,'safe-recovery');
  assert.throws(()=>createDeliveryStore({...paths}));
  const snapshotLock=await locks.acquireLock(paths.lockPath);
  const store=createDeliveryStore(paths,{recoveryNow:()=>Date.now()+600_000});
  await assert.rejects(store.recover(), /still running/);
  assert.equal(JSON.parse(await readFile(paths.lockPath)).ownerId,snapshotLock.owner.ownerId);
  await assert.rejects(lstat(`${paths.snapshotPath}.operation.lock`),{code:'ENOENT'});
  await snapshotLock.release();
  assert.deepEqual(await store.recover(),{recoveredLocks:[]});
});
