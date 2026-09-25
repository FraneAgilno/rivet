import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveStatePaths } from '../../src/state/paths.js';
import { createApprovalRegistry, createApprovalReceipt } from '../../src/policy/approvals.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import * as api from '../../src/delivery/service.js';
import * as stores from '../../src/delivery/store.js';
const SHA = 'a'.repeat(40),
  BASE = 'b'.repeat(40),
  DIGEST = 'd'.repeat(64),
  AT = '2026-09-25T10:00:00.000Z';
const repository = {
  provider: 'github',
  host: 'github.com',
  namespace: 'team',
  name: 'repo',
  fullName: 'team/repo',
  url: 'https://github.com/team/repo',
};
const initial = {
  runId: 'run-one',
  repository,
  sourceBranch: 'feature',
  targetBranch: 'main',
  reviewNumber: 7,
  localVerification: {
    runId: 'run-one',
    headSha: SHA,
    evidenceDigest: DIGEST,
    verifiedAt: AT,
    status: 'passed',
  },
};
const observation = {
  repositoryUrl: repository.url,
  sourceBranch: 'feature',
  targetBranch: 'main',
  headSha: SHA,
  baseSha: BASE,
  review: { number: 7, state: 'open', url: repository.url + '/pull/7', headSha: SHA },
  checks: { headSha: SHA, policy: 'known', satisfied: true, evidenceDigest: DIGEST },
  reviews: { headSha: SHA, policy: 'known', satisfied: true, evidenceDigest: DIGEST },
  observedAt: AT,
};
async function fixture(t, options = {}) {
  assert.equal(typeof api.createDeliveryService, 'function');
  const root = await mkdtemp(join(tmpdir(), 'rivet-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const paths = await resolveStatePaths(root, 'delivery-one');
  const store = stores.createDeliveryStore(paths, options.storeOptions);
  let facts = structuredClone(observation),
    now = AT,
    dispatch = 0,
    observe = 0,
    reconcile = 0;
  let dispatchFn = async (operation) => ({
    status: 'succeeded',
    operationDigest: operation.digest,
    headSha: SHA,
    evidenceDigest: DIGEST,
    resourceUrl: repository.url + '/pull/7',
    commitSha: operation.action === 'review-request' ? null : BASE,
  });
  let reconcileFn = async () => ({ status: 'unknown' });
  let observeFn = async () => facts;
  const executor = api.createTrustedDeliveryExecutor({
    provider: 'github',
    capabilities: ['review-request', 'merge', 'deploy', 'tracker-update'].map((action) => ({
      action,
      conditionalHead: true,
      reconcile: true,
    })),
    observe: async () => {
      observe++;
      return observeFn();
    },
    dispatch: async (operation, context) => {
      dispatch++;
      return dispatchFn(operation, context);
    },
    reconcile: async (operation) => {
      reconcile++;
      return reconcileFn(operation);
    },
  });
  const config = {
    store,
    executor,
    timeoutMs: options.timeoutMs ?? 10000,
    providerId: 'github-primary',
    subjectId: 'worker',
    expectedApproverId: 'owner',
    clock: () => now,
    approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'owner', principal: 'human' }] }),
    authority: createAuthorityEnvelope({
      actorId: 'worker',
      principal: 'agent',
      actions: ['provider.write'],
      ownedPaths: [],
      providers: [
        {
          id: 'github-primary',
          mode: 'read-write-with-approval',
          capabilities: ['review-request', 'merge', 'deploy', 'tracker-update'],
        },
      ],
      commands: [],
    }),
  };
  let service = api.createDeliveryService(config);
  function approval(state, id = 'approval-one') {
    return createApprovalReceipt({
      id,
      approverId: 'owner',
      approverPrincipal: 'human',
      subjectId: 'worker',
      action: 'provider.write',
      resource: state.proposal.approvalResource,
      policyId: 'authority.external-write',
      decision: 'approved',
      expiresAt: '2026-09-25T11:00:00.000Z',
      singleUse: true,
    });
  }
  return {
    paths,
    store,
    service,
    approval,
    counts: () => ({ dispatch, observe, reconcile }),
    setFacts(v) {
      facts = v;
    },
    setObserve(fn) {
      observeFn = fn;
    },
    setNow(v) {
      now = v;
    },
    setDispatch(v) {
      dispatchFn = v;
    },
    setReconcile(v) {
      reconcileFn = v;
    },
    reopen(freshExecutor = false, provider = executor.provider, providerId = config.providerId) {
      return api.createDeliveryService({
        ...config,
        providerId,
        executor: freshExecutor ? api.createTrustedDeliveryExecutor({ ...executor, provider }) : executor,
        store: stores.createDeliveryStore(paths),
        approvalRegistry: createApprovalRegistry({ approvers: [{ id: 'owner', principal: 'human' }] }),
      });
    },
  };
}
async function ready(f) {
  let s = await f.service.initialize(initial);
  s = await f.service.refresh({ expectedVersion: s.version });
  return f.service.propose({
    expectedVersion: s.version,
    action: 'merge',
    payload: { method: 'squash' },
    expiresAt: '2026-09-25T10:30:00.000Z',
  });
}
test('initialize persists local proof without network; refresh attaches existing review and qualified policies', async (t) => {
  const f = await fixture(t);
  const s = await f.service.initialize(initial);
  assert.equal(s.stage, 'locally-verified');
  assert.equal(s.observation, null);
  assert.equal(f.counts().observe, 0);
  assert.deepEqual((await f.reopen().status()).candidate, s.candidate);
  assert.equal((await f.service.refresh({ expectedVersion: s.version })).stage, 'checks-passed');
});
test('dispatch is durable before external call and records merged separately', async (t) => {
  const f = await fixture(t);
  const s = await ready(f);
  f.setDispatch(async (operation) => {
    const disk = JSON.parse(await readFile(f.paths.snapshotPath, 'utf8')).data;
    assert.equal(disk.stage, 'merge-approved');
    assert.equal(disk.operations.at(-1).state, 'dispatching');
    assert.equal(disk.operations.at(-1).digest, operation.digest);
    return {
      status: 'succeeded',
      operationDigest: operation.digest,
      headSha: SHA,
      evidenceDigest: DIGEST,
      resourceUrl: repository.url + '/pull/7',
      commitSha: BASE,
    };
  });
  const result = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  assert.equal(result.stage, 'merged');
  assert.equal(result.operations.at(-1).state, 'succeeded');
  assert.equal(f.counts().dispatch, 1);
});
test('missing review, failed CI, unknown policy and changed head cannot authorize merge', async (t) => {
  for (const change of [
    (v) => {
      v.review = null;
    },
    (v) => {
      v.checks.satisfied = false;
    },
    (v) => {
      v.reviews.policy = 'unknown';
      v.reviews.satisfied = null;
    },
    (v) => {
      v.headSha = BASE;
    },
  ]) {
    const f = await fixture(t);
    let s = await f.service.initialize(initial);
    const facts = structuredClone(observation);
    change(facts);
    f.setFacts(facts);
    try {
      s = await f.service.refresh({ expectedVersion: s.version });
    } catch {}
    await assert.rejects(
      f.service.propose({
        expectedVersion: s.version,
        action: 'merge',
        payload: {},
        expiresAt: '2026-09-25T10:30:00.000Z',
      })
    );
    assert.equal(f.counts().dispatch, 0);
  }
});
test('changed facts or expired proposal invalidate execution before writes', async (t) => {
  for (const change of ['head', 'expiry']) {
    const f = await fixture(t);
    const s = await ready(f);
    if (change === 'head') {
      const facts = structuredClone(observation);
      facts.headSha = BASE;
      f.setFacts(facts);
    } else f.setNow('2026-09-25T10:31:00.000Z');
    await assert.rejects(
      f.service.execute({
        expectedVersion: s.version,
        proposalDigest: s.proposal.digest,
        approval: f.approval(s),
      })
    );
    assert.equal(f.counts().dispatch, 0);
  }
});
test('timeouts remain indeterminate after reopen and reconciliation never repeats dispatch', async (t) => {
  const f = await fixture(t),
    s = await ready(f);
  f.setDispatch(async () => {
    throw new Error('timeout secret');
  });
  let result = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  assert.equal(result.operations.at(-1).state, 'indeterminate');
  const service = f.reopen();
  result = await service.reconcile({ expectedVersion: result.version });
  assert.equal(result.operations.at(-1).state, 'indeterminate');
  assert.equal(f.counts().dispatch, 1);
  f.setReconcile(async (operation) => ({
    status: 'succeeded',
    receipt: {
      status: 'succeeded',
      operationDigest: operation.digest,
      headSha: SHA,
      evidenceDigest: DIGEST,
      resourceUrl: repository.url + '/pull/7',
      commitSha: BASE,
    },
  }));
  result = await service.reconcile({ expectedVersion: result.version });
  assert.equal(result.stage, 'merged');
  assert.equal(f.counts().dispatch, 1);
});
test('wrong approval binding and duplicate concurrent execute produce at most one dispatch', async (t) => {
  const f = await fixture(t),
    s = await ready(f);
  await assert.rejects(
    f.service.execute({ expectedVersion: s.version, proposalDigest: 'f'.repeat(64), approval: f.approval(s) })
  );
  const results = await Promise.allSettled([
    f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    }),
    f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    }),
  ]);
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(f.counts().dispatch, 1);
});
test('payload secrets and mutable accessor objects are rejected before proposal creation', async (t) => {
  const f = await fixture(t);
  let s = await f.service.initialize(initial);
  s = await f.service.refresh({ expectedVersion: s.version });
  for (const payload of [
    { token: 'private-value' },
    { message: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    {
      get body() {
        throw new Error('getter');
      },
    },
  ])
    await assert.rejects(
      f.service.propose({
        expectedVersion: s.version,
        action: 'merge',
        payload,
        expiresAt: '2026-09-25T10:30:00.000Z',
      })
    );
});
test('store refuses altered operation binding and fabricated lifecycle stage', async (t) => {
  const f = await fixture(t),
    s = await ready(f);
  f.setDispatch(async () => {
    throw new Error('timeout');
  });
  const result = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  const { version, ...record } = structuredClone(result);
  record.operations[0].payload = { method: 'rebase' };
  await assert.rejects(f.store.write(record, { expectedVersion: version }));
  const g = await fixture(t);
  const local = await g.service.initialize(initial);
  const { version: v, ...forged } = structuredClone(local);
  forged.stage = 'review-requested';
  await assert.rejects(g.store.write(forged, { expectedVersion: v }));
});
test('durability failure prevents dispatch and secret errors are not persisted', async (t) => {
  let failWrite = false;
  const f = await fixture(t, {
    storeOptions: {
      snapshotOptions: {
        beforeCommit() {
          if (failWrite) throw new Error('disk failure');
        },
      },
    },
  });
  const s = await ready(f);
  failWrite = true;
  await assert.rejects(
    f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    })
  );
  assert.equal(f.counts().dispatch, 0);
});
test('not-applied reconciliation requires a fresh approval even after process restart', async (t) => {
  const f = await fixture(t);
  let s = await ready(f);
  const consumed = f.approval(s);
  f.setDispatch(async () => {
    throw new Error('timeout');
  });
  s = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: consumed,
  });
  f.setReconcile(async () => ({ status: 'not-applied' }));
  const reopened = f.reopen();
  s = await reopened.reconcile({ expectedVersion: s.version });
  s = await reopened.propose({
    expectedVersion: s.version,
    action: 'merge',
    payload: { method: 'squash' },
    expiresAt: '2026-09-25T10:30:00.000Z',
  });
  await assert.rejects(
    reopened.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    })
  );
  assert.equal(f.counts().dispatch, 1);
});
test('successful merge survives failed deployment and tracker writes independently', async (t) => {
  for (const action of ['deploy', 'tracker-update']) {
    const f = await fixture(t);
    let s = await ready(f);
    s = await f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    });
    s = await f.service.propose({
      expectedVersion: s.version,
      action,
      payload: { target: 'test' },
      expiresAt: '2026-09-25T10:30:00.000Z',
    });
    f.setDispatch(async () => {
      throw new Error('timeout');
    });
    s = await f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s, 'approval-two'),
    });
    assert.equal(s.stage, 'merged');
    assert.equal(s.operations[0].state, 'succeeded');
    assert.equal(s.operations[1].state, 'indeterminate');
    assert.equal((await f.reopen().status()).operations[0].receipt.commitSha, BASE);
  }
});
test('wrong SHA receipt cannot advance state and reconciliation races are serialized', async (t) => {
  const f = await fixture(t);
  let s = await ready(f);
  f.setDispatch(async (operation) => ({
    status: 'succeeded',
    operationDigest: operation.digest,
    headSha: BASE,
    evidenceDigest: DIGEST,
    resourceUrl: repository.url + '/pull/7',
    commitSha: BASE,
  }));
  s = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  assert.equal(s.operations[0].state, 'indeterminate');
  const results = await Promise.allSettled([
    f.service.reconcile({ expectedVersion: s.version }),
    f.reopen().reconcile({ expectedVersion: s.version }),
  ]);
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(f.counts().dispatch, 1);
});
test('proposal expiry during remote revalidation prevents dispatch', async (t) => {
  const f = await fixture(t),
    s = await ready(f);
  f.setObserve(async () => {
    f.setNow('2026-09-25T10:31:00.000Z');
    return { ...observation, observedAt: '2026-09-25T10:31:00.000Z' };
  });
  await assert.rejects(
    f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s),
    })
  );
  assert.equal(f.counts().dispatch, 0);
});
test('execute rejects input accessors without evaluating them', async (t) => {
  const f = await fixture(t),
    s = await ready(f);
  let invoked = false;
  await assert.rejects(
    f.service.execute({
      expectedVersion: s.version,
      get proposalDigest() {
        invoked = true;
        return s.proposal.digest;
      },
      approval: f.approval(s),
    })
  );
  assert.equal(invoked, false);
});
test('a hung trusted mutation times out to an indeterminate durable operation', async (t) => {
  const f = await fixture(t, { timeoutMs: 20 });
  const s = await ready(f);
  f.setDispatch(() => new Promise(() => {}));
  const result = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  assert.equal(result.operations.at(-1).state, 'indeterminate');
  assert.equal((await f.reopen().status()).operations.at(-1).state, 'indeterminate');
});
test('merge deployment and tracker completion each need a separate action-bound approval', async (t) => {
  const f = await fixture(t);
  let s = await ready(f);
  s = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  for (const [action, stage, id] of [
    ['deploy', 'deployed', 'approval-two'],
    ['tracker-update', 'tracker-updated', 'approval-three'],
  ]) {
    s = await f.service.propose({
      expectedVersion: s.version,
      action,
      payload: { target: 'test' },
      expiresAt: '2026-09-25T10:30:00.000Z',
    });
    s = await f.service.execute({
      expectedVersion: s.version,
      proposalDigest: s.proposal.digest,
      approval: f.approval(s, id),
    });
    assert.equal(s.stage, stage);
  }
  assert.equal(s.operations.length, 3);
  assert.equal(s.usedApprovalIds.length, 3);
});
test('wrong resource and expired approval receipts cannot dispatch', async (t) => {
  for (const override of [{ resource: 'different-resource' }, { expiresAt: '2026-09-25T09:00:00.000Z' }]) {
    const f = await fixture(t),
      s = await ready(f);
    const approval = createApprovalReceipt({ ...f.approval(s), ...override });
    await assert.rejects(
      f.service.execute({ expectedVersion: s.version, proposalDigest: s.proposal.digest, approval })
    );
    assert.equal(f.counts().dispatch, 0);
  }
});
test('caller payload mutations after propose begins cannot change the approved digest', async (t) => {
  const f = await fixture(t);
  let s = await f.service.initialize(initial);
  s = await f.service.refresh({ expectedVersion: s.version });
  const payload = { method: 'squash' };
  const promise = f.service.propose({
    expectedVersion: s.version,
    action: 'merge',
    payload,
    expiresAt: '2026-09-25T10:30:00.000Z',
  });
  payload.method = 'rebase';
  s = await promise;
  assert.equal(s.proposal.payload.method, 'squash');
});
test('reconciliation cannot report not-applied while timed-out dispatch is still in flight', async (t) => {
  const f = await fixture(t, { timeoutMs: 20 });
  let s = await ready(f);
  let release;
  f.setDispatch(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  s = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  f.setReconcile(async () => ({ status: 'not-applied' }));
  s = await f.reopen(true).reconcile({ expectedVersion: s.version });
  assert.equal(s.operations.at(-1).state, 'indeterminate');
  assert.equal(f.counts().reconcile, 0);
  await assert.rejects(
    f.service.propose({
      expectedVersion: s.version,
      action: 'merge',
      payload: {},
      expiresAt: '2026-09-25T10:30:00.000Z',
    })
  );
  release({});
});
test('expiry during durable intent write prevents the external write', async (t) => {
  let expire = null;
  const f = await fixture(t, {
    storeOptions: {
      snapshotOptions: {
        beforeCommit() {
          expire?.();
        },
      },
    },
  });
  const s = await ready(f);
  expire = () => f.setNow('2026-09-25T10:31:00.000Z');
  const result = await f.service.execute({
    expectedVersion: s.version,
    proposalDigest: s.proposal.digest,
    approval: f.approval(s),
  });
  assert.equal(f.counts().dispatch, 0);
  assert.equal(result.operations.at(-1).state, 'not-applied');
  assert.equal(result.proposal, null);
});

test('deploy and tracker proposals bind the confirmed merge receipt and resulting commit', async (t) => {
  for (const action of ['deploy', 'tracker-update']) {
    const f = await fixture(t);
    let state = await ready(f);
    state = await f.service.execute({
      expectedVersion: state.version,
      proposalDigest: state.proposal.digest,
      approval: f.approval(state),
    });
    const mergeReceipt = state.operations[0].receipt;
    assert.notEqual(mergeReceipt.commitSha, state.candidate.headSha);
    state = await f.service.propose({
      expectedVersion: state.version,
      action,
      payload: { target: 'test' },
      expiresAt: '2026-09-25T10:30:00.000Z',
    });
    assert.deepEqual(state.proposal.mergeReceipt, mergeReceipt);
    f.setDispatch(async (operation) => {
      assert.equal(operation.mergeReceipt.commitSha, BASE);
      assert.equal(operation.candidate.headSha, SHA);
      assert.deepEqual(operation.mergeReceipt, mergeReceipt);
      return {
        status: 'succeeded',
        operationDigest: operation.digest,
        headSha: SHA,
        evidenceDigest: DIGEST,
        resourceUrl: repository.url + '/pull/7',
        commitSha: BASE,
      };
    });
    const result = await f.service.execute({
      expectedVersion: state.version,
      proposalDigest: state.proposal.digest,
      approval: f.approval(state, 'approval-two'),
    });
    assert.equal(result.operations.at(-1).state, 'succeeded');
    assert.deepEqual(result.operations.at(-1).mergeReceipt, mergeReceipt);
    const { version, ...record } = structuredClone(result);
    record.operations.at(-1).mergeReceipt.commitSha = SHA;
    await assert.rejects(f.store.write(record, { expectedVersion: version }));
  }
});

test('confirmed review creation survives an absent observation and cannot be repeated', async (t) => {
  const f = await fixture(t);
  let state = await f.service.initialize(initial);
  f.setFacts({ ...observation, review: null });
  state = await f.service.refresh({ expectedVersion: state.version });
  state = await f.service.propose({
    expectedVersion: state.version,
    action: 'review-request',
    payload: { title: 'Task' },
    expiresAt: '2026-09-25T10:30:00.000Z',
  });
  state = await f.service.execute({
    expectedVersion: state.version,
    proposalDigest: state.proposal.digest,
    approval: f.approval(state),
  });
  assert.equal(state.stage, 'review-requested');
  const reopened = f.reopen();
  state = await reopened.refresh({ expectedVersion: state.version });
  assert.equal(state.stage, 'review-requested');
  await assert.rejects(
    reopened.propose({
      expectedVersion: state.version,
      action: 'review-request',
      payload: { title: 'Duplicate' },
      expiresAt: '2026-09-25T10:30:00.000Z',
    })
  );
  assert.equal(f.counts().dispatch, 1);
});

test('reopened provider mismatch fails before observation or mutation', async (t) => {
  const f = await fixture(t);
  const state = await ready(f);
  const before = f.counts();
  const wrongProvider = f.reopen(true, 'gitlab');
  await assert.rejects(wrongProvider.refresh({ expectedVersion: state.version }));
  await assert.rejects(
    wrongProvider.execute({
      expectedVersion: state.version,
      proposalDigest: state.proposal.digest,
      approval: f.approval(state),
    })
  );
  assert.deepEqual(f.counts(), before);
});


test('trusted dispatch receives a deadline bounded by execution timeout and approval expiry', async t => {
  const f = await fixture(t);
  const state = await ready(f);
  f.setDispatch(async (operation, context) => {
    assert.equal(context.deadline, '2026-09-25T10:00:10.000Z');
    assert.ok(Object.isFrozen(context));
    return {status:'succeeded',operationDigest:operation.digest,headSha:SHA,evidenceDigest:DIGEST,
      resourceUrl:repository.url+'/pull/7',commitSha:BASE};
  });
  const result = await f.service.execute({expectedVersion:state.version,proposalDigest:state.proposal.digest,approval:f.approval(state)});
  assert.equal(result.stage, 'merged');
});


async function merged(f) {
  const state = await ready(f);
  return f.service.execute({ expectedVersion: state.version, proposalDigest: state.proposal.digest, approval: f.approval(state) });
}
async function proposeNext(f, state, action) {
  return f.service.propose({ expectedVersion: state.version, action, payload: { target: 'test' }, expiresAt: '2026-09-25T10:30:00.000Z' });
}
function postMergeReceipt(operation, commitSha = BASE) {
  return { status: 'succeeded', operationDigest: operation.digest, headSha: SHA, evidenceDigest: DIGEST,
    resourceUrl: repository.url + '/pull/7', commitSha };
}
test('pending reconciliation is bound to the approved provider id even for the same repository kind', async t => {
  const f = await fixture(t);
  const proposal = await ready(f);
  f.setDispatch(async () => { throw new Error('lost response'); });
  const state = await f.service.execute({ expectedVersion: proposal.version, proposalDigest: proposal.proposal.digest, approval: f.approval(proposal) });
  const before = await readFile(f.paths.snapshotPath);
  await assert.rejects(f.reopen(true, 'github', 'different-provider').reconcile({ expectedVersion: state.version }));
  assert.equal(f.counts().reconcile, 0);
  assert.deepEqual(await readFile(f.paths.snapshotPath), before);
});
test('tracker completion permits a later deployment and successful actions cannot repeat', async t => {
  const f = await fixture(t);
  let state = await merged(f);
  f.setDispatch(async operation => postMergeReceipt(operation));
  for (const [action, approvalId] of [['tracker-update', 'tracker-one'], ['deploy', 'deploy-one']]) {
    state = await proposeNext(f, state, action);
    state = await f.service.execute({ expectedVersion: state.version, proposalDigest: state.proposal.digest, approval: f.approval(state, approvalId) });
    assert.equal(state.operations.at(-1).state, 'succeeded');
    await assert.rejects(proposeNext(f, state, action));
  }
  assert.equal(state.operations.filter(operation => operation.state === 'succeeded').length, 3);
});
test('post-merge execution and reconciliation reject receipts for an absent or different merged commit', async t => {
  for (const action of ['deploy', 'tracker-update']) {
    for (const commit of [null, SHA]) {
      const f = await fixture(t);
      let state = await proposeNext(f, await merged(f), action);
      f.setDispatch(async operation => postMergeReceipt(operation, commit));
      state = await f.service.execute({ expectedVersion: state.version, proposalDigest: state.proposal.digest, approval: f.approval(state, 'post-merge-one') });
      assert.equal(state.stage, 'merged');
      assert.equal(state.operations.at(-1).state, 'indeterminate');
      f.setReconcile(async operation => ({status: 'succeeded', receipt: postMergeReceipt(operation, commit)}));
      state = await f.reopen().reconcile({expectedVersion: state.version});
      assert.equal(state.stage, 'merged');
      assert.equal(state.operations.at(-1).state, 'indeterminate');
      f.setReconcile(async operation => ({status: 'succeeded', receipt: postMergeReceipt(operation)}));
      state = await f.reopen().reconcile({expectedVersion: state.version});
      assert.equal(state.stage, action === 'deploy' ? 'deployed' : 'tracker-updated');
      assert.equal(f.counts().dispatch, 2);
    }
  }
});
