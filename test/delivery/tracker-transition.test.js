import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';
import { candidate, factsDigest } from '../../src/delivery/contract.js';

const head = 'a'.repeat(40), merged = 'b'.repeat(40), digest = 'd'.repeat(64), at = '2026-09-26T10:00:00.000Z';
const repository = { provider: 'github', host: 'github.com', namespace: 'team', name: 'repo', fullName: 'team/repo', url: 'https://github.com/team/repo' };
const mergeReceipt = { status: 'succeeded', operationDigest: 'e'.repeat(64), headSha: head, evidenceDigest: digest, resourceUrl: repository.url + '/pull/7', commitSha: merged };
const targetCandidate = candidate({ runId: 'run-one', repository, sourceBranch: 'feature', targetBranch: 'main', reviewNumber: 7, localVerification: { runId: 'run-one', status: 'passed', headSha: head, evidenceDigest: digest, verifiedAt: at } });
const uuid = index => `${String(index).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;

async function fixture(kind = 'jira', change = () => {}) {
  const baseUrl = kind === 'jira' ? 'https://team.atlassian.net' : 'https://api.linear.app';
  const target = { kind, issueKey: 'TEAM-7', issueUrl: kind === 'jira' ? baseUrl + '/browse/TEAM-7' : 'https://linear.app/team/issue/TEAM-7/task', requestDigest: digest };
  const owner = kind === 'jira' ? { id: '9', key: 'TEAM' } : { id: uuid(9), key: 'TEAM' };
  const source = kind === 'jira' ? { id: '1', name: 'In progress', statusCategory: { id: 2, key: 'indeterminate', name: 'In Progress' } }
    : { id: uuid(1), name: 'In progress', type: 'started', team: owner };
  const destination = kind === 'jira' ? { id: '3', name: 'Done', statusCategory: { id: 3, key: 'done', name: 'Done' } }
    : { id: uuid(3), name: 'Done', type: 'completed', team: owner };
  const data = { calls: [], writes: 0, now: at, owner, source, destination,
    issue: kind === 'jira' ? { id: '123', key: 'TEAM-7', fields: { updated: at, project: owner, status: source } }
      : { id: uuid(123), identifier: 'TEAM-7', url: target.issueUrl, updatedAt: at, team: owner, state: source },
    destinations: kind === 'jira' ? [{ id: '31', name: 'Complete issue', to: destination, hasScreen: false, fields: {} }] : [source, destination] };
  change(data);
  const transport = createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned: async (url, options) => {
    data.calls.push({ url, ...options });
    const overridden = await data.respond?.(url, options); if (overridden) return overridden;
    const body = options.body ? JSON.parse(options.body) : null;
    const writing = options.method === 'POST' && (kind === 'jira' || body.query.startsWith('mutation'));
    if (writing) {
      data.writes++;
      data.sent = body;
      if (kind === 'jira') data.issue.fields.status = data.destination;
      else data.issue.state = data.destination;
      await data.afterWrite?.();
      return kind === 'jira' ? new Response(null, { status: 204 }) : Response.json({ data: { issueUpdate: { success: true, issue: { id: data.issue.id } } } });
    }
    if (kind === 'jira') return Response.json(new URL(url).pathname.endsWith('/transitions') ? { transitions: data.destinations } : data.issue);
    if (body.query.includes('workflowStates(')) return Response.json({ data: { workflowStates: { nodes: data.destinations, pageInfo: { hasNextPage: false, endCursor: null } } } });
    return Response.json({ data: { issue: data.issue } });
  } });
  const config = { repository, target, mergeReceipt, providerId: kind + '-primary', baseUrl, transport, clock: () => data.now, timeoutMs: 100 };
  const { createTrackerTransition } = await import('../../src/delivery/tracker-transition.js');
  const intake = await createTrackerTransition(config);
  const prepared = await intake.select(kind === 'jira' ? '31' : uuid(3));
  return { ...prepared, intake, data, config, createTrackerTransition };
}
async function operation(f) { return { action: 'tracker-transition', digest, candidate: targetCandidate, mergeReceipt, payload: f.payload, factsDigest: factsDigest(await f.executor.observe(targetCandidate)) }; }
const deadline = { deadline: '2026-09-26T10:01:00.000Z' };

for (const kind of ['jira', 'linear']) {
  test(`${kind} discovers destinations and transitions the immutable issue with verified desired state`, async () => {
    const f = await fixture(kind), op = await operation(f);
    assert.equal(f.intake.status.current.name, 'In progress');
    assert.equal(f.intake.status.destinations.some(value => value.state.name === 'Done'), true);
    const receipt = await f.executor.dispatch(op, deadline);
    assert.equal(receipt.commitSha, merged);
    assert.equal(receipt.resourceUrl, f.config.target.issueUrl);
    assert.equal(f.data.writes, 1);
    if (kind === 'jira') {
      assert.equal(f.data.sent.transition.id, '31');
      assert.notEqual(f.data.sent.transition.id, f.data.destination.id);
      assert.ok(f.data.calls.some(call => call.url.endsWith('/issue/123/transitions') && call.method === 'POST'));
    } else {
      assert.equal(f.data.sent.variables.id, uuid(123));
      assert.deepEqual(f.data.sent.variables.input, { stateId: uuid(3) });
    }
    assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
    assert.equal(f.data.writes, 1);
  });
  test(`${kind} revision or destination metadata drift prevents dispatch`, async () => {
    for (const mode of ['revision', 'name', 'owner']) {
      const f = await fixture(kind), op = await operation(f);
      if (mode === 'revision') { if (kind === 'jira') f.data.issue.fields.updated = '2026-09-26T10:00:01.000Z'; else f.data.issue.updatedAt = '2026-09-26T10:00:01.000Z'; }
      if (mode === 'name') f.data.destination.name = 'Changed destination';
      if (mode === 'owner') f.data.owner.id = kind === 'jira' ? '10' : uuid(10);
      await assert.rejects(f.executor.dispatch(op, deadline));
      assert.equal(f.data.writes, 0);
    }
  });
  test(`${kind} lost response is reconciled only from desired state and never resent`, async () => {
    const f = await fixture(kind), op = await operation(f);
    f.data.afterWrite = () => { throw new Error('response lost'); };
    await assert.rejects(f.executor.dispatch(op, deadline));
    assert.equal((await f.executor.reconcile(op)).status, 'succeeded');
    if (kind === 'jira') f.data.issue.fields.status = f.data.source; else f.data.issue.state = f.data.source;
    assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
    const third = { ...f.data.destination, id: kind === 'jira' ? '8' : uuid(8) };
    if (kind === 'jira') f.data.issue.fields.status = third; else f.data.issue.state = third;
    assert.deepEqual(await f.executor.reconcile(op), { status: 'unknown' });
    assert.equal(f.data.writes, 1);
  });
  test(`${kind} persisted operation can reopen after state changes without rebinding approved input`, async () => {
    const f = await fixture(kind), op = await operation(f);
    await f.executor.dispatch(op, deadline);
    const reopened = await f.createTrackerTransition({ ...f.config, persistedPayload: f.payload });
    assert.deepEqual(reopened.payload, f.payload);
    assert.equal((await reopened.executor.reconcile(op)).status, 'succeeded');
    await assert.rejects(f.createTrackerTransition({ ...f.config, persistedPayload: { ...f.payload, mergeCommit: head } }));
  });
}

test('Jira screens and required fields are ineligible without guessing missing values', async () => {
  for (const values of [{ hasScreen: true }, { fields: { resolution: { required: true } } }]) {
    await assert.rejects(fixture('jira', data => Object.assign(data.destinations[0], values)));
  }
});

test('Jira 204 alone and Linear success alone cannot replace desired-state readback', async () => {
  for (const kind of ['jira', 'linear']) {
    const f = await fixture(kind), op = await operation(f);
    f.data.afterWrite = () => { if (kind === 'jira') f.data.issue.fields.status = f.data.source; else f.data.issue.state = f.data.source; };
    await assert.rejects(f.executor.dispatch(op, deadline));
    assert.equal(f.data.writes, 1);
  }
});

for (const kind of ['jira','linear']) {
  test(`${kind} rejects substituted issue identity and unsupported provider site before a write`, async () => {
    const f=await fixture(kind), op=await operation(f);
    f.data.issue.id=kind==='jira'?'124':uuid(124);
    await assert.rejects(f.executor.dispatch(op,deadline));
    assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
    await assert.rejects(f.createTrackerTransition({...f.config,baseUrl:'https://other.atlassian.net'}));
    assert.equal(f.data.writes,0);
  });
  test(`${kind} actual transport timeout remains unknown for original/third states and only observes desired state`,async()=>{
    const f=await fixture(kind),op=await operation(f);
    f.data.respond=async(_url,options)=>{
      const body=options.body?JSON.parse(options.body):null;
      if(options.method==='POST'&&(kind==='jira'||body.query.startsWith('mutation'))){f.data.writes++;return new Promise(()=>{});}
    };
    await assert.rejects(f.executor.dispatch(op,deadline));
    assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
    if(kind==='jira')f.data.issue.fields.status={...f.data.destination,id:'99'};else f.data.issue.state={...f.data.destination,id:uuid(99)};
    assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
    if(kind==='jira')f.data.issue.fields.status=f.data.destination;else f.data.issue.state=f.data.destination;
    assert.equal((await f.executor.reconcile(op)).status,'succeeded');assert.equal(f.data.writes,1);
  });
  test(`${kind} selected current state is identified as no-op and cannot dispatch`,async()=>{
    const f=await fixture(kind,data=>{if(kind==='jira')data.issue.fields.status=data.destination;else data.issue.state=data.destination;});
    assert.equal(f.alreadyDesired,true);
    await assert.rejects(f.executor.dispatch(await operation(f),deadline));assert.equal(f.data.writes,0);
  });
}
test('Linear rejects partial GraphQL errors, foreign team states and unbounded state pagination',async()=>{
  for(const change of [
    data=>{data.respond=async()=>Response.json({errors:[{message:'partial failure'}],data:{issue:data.issue}});},
    data=>{data.destinations[1]={...data.destination,team:{id:uuid(10),key:'TEAM'}};},
    data=>{data.respond=async(_url,options)=>JSON.parse(options.body).query.includes('workflowStates(')?Response.json({data:{workflowStates:{nodes:data.destinations,pageInfo:{hasNextPage:true,endCursor:'cursor'}}}}):undefined;},
  ]) await assert.rejects(fixture('linear',change));
});
test('Linear unsuccessful or partially erroneous mutation never produces a confirmed write receipt',async()=>{
  for(const result of [
    {errors:[{message:'partial failure'}],data:{issueUpdate:{success:true,issue:{id:uuid(123)}}}},
    {data:{issueUpdate:{success:false,issue:{id:uuid(123)}}}},
    {data:{issueUpdate:{success:true,issue:{id:uuid(124)}}}},
  ]) {
    const f=await fixture('linear'),op=await operation(f);
    f.data.respond=async(_url,options)=>JSON.parse(options.body).query.startsWith('mutation')?Response.json(result):undefined;
    await assert.rejects(f.executor.dispatch(op,deadline));
    assert.deepEqual(await f.executor.reconcile(op),{status:'unknown'});
  }
});
test('tracker transition false conditional-head exception requires exact desired-state assurance',async()=>{
  const {createTrustedDeliveryExecutor}=await import('../../src/delivery/service.js');
  for(const capability of [
    {action:'tracker-transition',conditionalHead:false,reconcile:true},
    {action:'tracker-transition',conditionalHead:false,verifiesDesiredState:false,reconcile:true},
    {action:'tracker-update',conditionalHead:false,verifiesDesiredState:true,reconcile:true},
  ]) assert.throws(()=>createTrustedDeliveryExecutor({provider:'github',capabilities:[capability],observe:async()=>{},dispatch:async()=>{},reconcile:async()=>{}}));
});

test('a real transition timeout remains durable across store/executor reopen and never writes twice',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
  const {resolveStatePaths}=await import('../../src/state/paths.js');
  const {createDeliveryStore}=await import('../../src/delivery/store.js');
  const {createDeliveryService,createTrustedDeliveryExecutor}=await import('../../src/delivery/service.js');
  const {createAuthorityEnvelope}=await import('../../src/policy/authority.js');
  const {createApprovalRegistry,createApprovalReceipt}=await import('../../src/policy/approvals.js');
  const f=await fixture('jira'),root=await mkdtemp(join(tmpdir(),'rivet-transition-durable-'));
  t.after(()=>rm(root,{recursive:true,force:true}));execFileSync('git',['init','-q',root]);
  const paths=await resolveStatePaths(root,'delivery-one'),store=createDeliveryStore(paths);
  const settings={store,providerId:'jira-primary',subjectId:'worker',expectedApproverId:'owner',clock:()=>at,
    authority:createAuthorityEnvelope({actorId:'worker',principal:'agent',actions:['provider.write'],ownedPaths:[],commands:[],providers:[{id:'jira-primary',mode:'read-write-with-approval',capabilities:['merge','tracker-transition']}]}),
    approvalRegistry:createApprovalRegistry({approvers:[{id:'owner',principal:'human'}]})};
  const approval=(s,id)=>createApprovalReceipt({id,approverId:'owner',approverPrincipal:'human',subjectId:'worker',action:'provider.write',resource:s.proposal.approvalResource,policyId:'authority.external-write',decision:'approved',expiresAt:'2026-09-26T10:05:00.000Z',singleUse:true});
  let service=createDeliveryService({...settings,executor:createTrustedDeliveryExecutor({provider:'github',capabilities:[{action:'merge',conditionalHead:true,reconcile:true}],
    observe:async c=>{const facts=await f.executor.observe(c);return {...facts,review:{...facts.review,state:'open'},checks:{...facts.checks,policy:'known',satisfied:true},reviews:{...facts.reviews,policy:'known',satisfied:true}};},
    dispatch:async op=>({...mergeReceipt,operationDigest:op.digest}),reconcile:async()=>({status:'unknown'})})});
  const {headSha: _headSha, ...initialCandidate}=targetCandidate;
  let saved=await service.initialize(initialCandidate);saved=await service.refresh({expectedVersion:saved.version});
  saved=await service.propose({expectedVersion:saved.version,action:'merge',payload:{method:'merge'},expiresAt:'2026-09-26T10:05:00.000Z'});
  saved=await service.execute({expectedVersion:saved.version,proposalDigest:saved.proposal.digest,approval:approval(saved,'merge-approval')});
  const confirmed=saved.operations[0].receipt;
  const intake=await f.createTrackerTransition({...f.config,mergeReceipt:confirmed});const prepared=await intake.select('31');
  service=createDeliveryService({...settings,executor:prepared.executor});saved=await service.refresh({expectedVersion:saved.version});
  saved=await service.propose({expectedVersion:saved.version,action:'tracker-transition',payload:prepared.payload,expiresAt:'2026-09-26T10:05:00.000Z'});
  f.data.afterWrite=()=>{throw new Error('response lost');};
  saved=await service.execute({expectedVersion:saved.version,proposalDigest:saved.proposal.digest,approval:approval(saved,'transition-approval')});
  assert.equal(saved.operations.at(-1).state,'indeterminate');assert.equal(f.data.writes,1);
  const reopenedStore=createDeliveryStore(paths),pending=(await reopenedStore.read()).operations.at(-1);
  const reopened=await f.createTrackerTransition({...f.config,mergeReceipt:confirmed,persistedPayload:pending.payload});
  service=createDeliveryService({...settings,store:reopenedStore,executor:reopened.executor});
  saved=await service.reconcile({expectedVersion:saved.version});
  assert.equal(saved.stage,'tracker-status-confirmed');assert.deepEqual(saved.operations[0].receipt,confirmed);
  assert.equal(saved.operations.at(-1).receipt.commitSha,merged);assert.equal(f.data.writes,1);
  assert.deepEqual(await createDeliveryStore(paths).read(),saved);
});
