import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthorityPolicyError,
  createAuthorityEnvelope,
  evaluateAuthority,
  grant,
} from '../../src/policy/authority.js';
import * as approvalsModule from '../../src/policy/approvals.js';
import {
  createApprovalReceipt,
  createApprovalRegistry,
  verifyApproval,
} from '../../src/policy/approvals.js';

function envelope(overrides = {}) {
  return createAuthorityEnvelope({
    actorId: 'worker-one',
    principal: 'agent',
    actions: ['file.read', 'file.write', 'provider.read', 'provider.write', 'command.test'],
    ownedPaths: ['src/components'],
    providers: [{ id: 'jira-demo', mode: 'read-write-with-approval', capabilities: ['issues'] }],
    commands: ['test'],
    ...overrides,
  });
}

function approved(action, resource, subjectId = 'worker-one', overrides = {}) {
  return createApprovalReceipt({
    id: 'approval-one',
    approverId: 'human-owner',
    approverPrincipal: 'human',
    subjectId,
    action,
    resource,
    policyId: action === 'provider.write' ? 'authority.external-write' : `authority.human-gate.${action}`,
    decision: 'approved',
    expiresAt: '2030-01-01T00:00:00.000Z',
    singleUse: true,
    ...overrides,
  });
}

function approvalRegistry(principal = 'human') {
  return createApprovalRegistry({ approvers: [{ id: 'human-owner', principal }] });
}

test('worker cannot inherit authority its manager does not have', () => {
  const manager = envelope({ actorId: 'manager-one', actions: ['file.read'] });
  const worker = { actorId: 'worker-one', principal: 'agent' };
  assert.throws(
    () => grant(worker, ['git.merge'], manager),
    /authority ceiling/,
  );
});

test('grant returns an immutable child envelope bounded by parent actions and paths', () => {
  const parent = envelope({ actorId: 'manager-one', ownedPaths: ['src'] });
  const child = grant({
    actorId: 'worker-one',
    principal: 'agent',
    ownedPaths: ['src/components'],
    providers: [{ id: 'jira-demo', mode: 'read-only', capabilities: ['issues'] }],
    commands: ['test'],
  }, ['file.read', 'command.test'], parent);
  assert.deepEqual(child.actions, ['command.test', 'file.read']);
  assert.ok(Object.isFrozen(child));
  assert.ok(Object.isFrozen(child.ownedPaths));
  assert.throws(() => grant({ actorId: 'worker-two', ownedPaths: ['docs'] }, ['file.read'], parent), /authority ceiling/);
  assert.throws(() => grant({ actorId: 'worker-two', principal: 'human' }, ['file.read'], parent), /authority ceiling/);
});

test('file writes require explicit authority and canonical non-overlapping ownership', () => {
  const authority = envelope();
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'file.write', resource: 'src/components/button.js',
  }).decision, 'allow');
  assert.deepEqual(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'file.write', resource: 'src/server.js',
  }), {
    decision: 'deny', policyId: 'authority.file-ownership', reason: 'resource-not-owned',
  });
  assert.throws(() => envelope({ ownedPaths: ['src', 'src/components'] }), /overlapping owned paths/);
  assert.throws(() => evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'file.write', resource: '../private.txt',
  }), AuthorityPolicyError);
});

test('owned paths reject cross-platform aliases and reserved device components', () => {
  for (const path of [
    '..\\private', '\\\\server\\share', 'C:\\private', '/private', '.', '..', 'src/../private',
    'src//button', 'src/name.', 'src/name ', 'src/CON', 'src/con.txt', 'src/CONIN$',
    'src/conout$.txt', 'src/COM1.log', 'src/COM¹.log', 'src/lpt².txt', 'src/file:stream',
    'src＼private', 'src／private', 'src／..／private',
  ]) assert.throws(() => envelope({ ownedPaths: [path] }), AuthorityPolicyError, path);
});

test('owned paths reject case-folded duplicates and ancestor aliases on every platform', () => {
  for (const ownedPaths of [
    ['src/Button', 'SRC/button'],
    ['Src', 'src/components'],
    ['src/Components', 'SRC/components/Button'],
    ['src/Ä', 'SRC/ä'],
    ['src/Straße', 'SRC/STRASSE/Button'],
    ['src/Σ', 'SRC/ς/component'],
  ]) assert.throws(() => envelope({ ownedPaths }), /overlapping owned paths/, ownedPaths.join(' vs '));
});

test('provider reads and writes remain distinct and writes require a bound approval', () => {
  const authority = envelope();
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'provider.read', providerId: 'jira-demo', capability: 'issues', resource: 'demo-1',
  }).decision, 'allow');
  const request = {
    actorId: 'worker-one', action: 'provider.write', providerId: 'jira-demo', capability: 'issues', resource: 'demo-1',
  };
  assert.equal(evaluateAuthority(authority, request).decision, 'approval-required');
  const approvals = approvalRegistry();
  assert.equal(evaluateAuthority(authority, request, {
    approval: approved('provider.write', 'jira-demo:issues:demo-1'),
    approvalRegistry: approvals,
    expectedApproverId: 'human-owner',
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  }).decision, 'allow');
  assert.equal(evaluateAuthority(envelope({ providers: [{ id: 'jira-demo', mode: 'read-only', capabilities: ['issues'] }] }), request).decision, 'deny');
});

test('command allowlists are explicit and dependency installation is human gated', () => {
  const authority = envelope({ actions: ['command.test', 'dependency.install'], commands: ['test', 'install'] });
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'command.test', commandId: 'test', resource: 'test',
  }).decision, 'allow');
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'command.build', commandId: 'build', resource: 'build',
  }).decision, 'deny');
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'dependency.install', commandId: 'install', resource: 'install',
  }).decision, 'approval-required');
});

test('human-retained actions cannot be inferred from a boss role name', () => {
  const authority = envelope({
    actorId: 'named-boss', role: 'boss',
    actions: ['activation', 'scope-change', 'visual-baseline.accept', 'git.merge', 'deploy.execute', 'docs.publish', 'final-delivery'],
  });
  for (const action of ['activation', 'scope-change', 'visual-baseline.accept', 'git.merge', 'deploy.execute', 'docs.publish', 'final-delivery']) {
    const request = { actorId: 'named-boss', action, resource: 'demo' };
    const decision = evaluateAuthority(authority, request, {
      approval: approved(action, 'demo', 'named-boss'),
      approvalRegistry: approvalRegistry(),
      expectedApproverId: 'human-owner',
      nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
    });
    assert.deepEqual(decision, {
      decision: 'approval-required', policyId: `authority.human-gate.${action}`, reason: 'human-approval-required',
    });
  }
});

test('agents cannot approve their own result or mutate final Jira/documentation state', () => {
  const authority = envelope({
    actions: ['approval.record', 'jira.final-state', 'docs.publish'],
  });
  assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action: 'approval.record', resource: 'demo', subjectId: 'worker-one',
  }).decision, 'deny');
  for (const action of ['jira.final-state', 'docs.publish']) assert.equal(evaluateAuthority(authority, {
    actorId: 'worker-one', action, resource: 'demo', subjectId: 'worker-one',
  }).decision, 'approval-required');
});

test('approval recording requires one valid snapshotted subject distinct from the trusted actor', () => {
  const approver = envelope({
    actorId: 'human-owner', principal: 'human', actions: ['approval.record'],
  });
  for (const request of [
    { actorId: 'human-owner', action: 'approval.record', resource: 'demo' },
    { actorId: 'human-owner', action: 'approval.record', resource: 'demo', subjectId: undefined },
    { actorId: 'human-owner', action: 'approval.record', resource: 'demo', subjectId: 'bad subject' },
    { actorId: 'human-owner', action: 'approval.record', resource: 'demo', subjectId: 'human-owner' },
    { actorId: 'other-human', action: 'approval.record', resource: 'demo', subjectId: 'worker-one' },
  ]) assert.equal(evaluateAuthority(approver, request).decision, 'deny');

  let accesses = 0;
  assert.throws(() => evaluateAuthority(approver, {
    actorId: 'human-owner', action: 'approval.record', resource: 'demo',
    get subjectId() { accesses += 1; throw new Error('subject-private-canary'); },
  }), error => {
    assert.ok(error instanceof AuthorityPolicyError);
    assert.equal(error.message.includes('subject-private-canary'), false);
    return true;
  });
  assert.equal(accesses, 1);

  accesses = 0;
  assert.equal(evaluateAuthority(approver, {
    actorId: 'human-owner', action: 'approval.record', resource: 'demo',
    get subjectId() { accesses += 1; return 'worker-one'; },
  }).decision, 'allow');
  assert.equal(accesses, 1);
});

test('authority inputs are snapshotted once and public errors are sanitized', () => {
  const canary = 'authority-private-canary';
  let accesses = 0;
  const input = {
    actorId: 'worker-one', principal: 'agent', ownedPaths: [], providers: [], commands: [],
    get actions() { accesses += 1; throw new Error(canary); },
  };
  assert.throws(() => createAuthorityEnvelope(input), error => {
    assert.ok(error instanceof AuthorityPolicyError);
    assert.equal(JSON.stringify(error).includes(canary), false);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
  assert.equal(accesses, 1);
});

test('approval receipts are identity-bound, expiring, and single-use without caller mutation', () => {
  const receipt = approved('provider.write', 'jira-demo:issues:demo-1');
  const request = {
    subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1',
    policyId: 'authority.external-write',
  };
  const registry = approvalRegistry();
  assert.equal(verifyApproval(receipt, request, {
    registry, expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  }).valid, true);
  assert.equal(verifyApproval(receipt, { ...request, resource: 'jira-demo:issues:demo-2' }, {
    registry: approvalRegistry(), expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  }).reason, 'approval-binding-mismatch');
  assert.equal(verifyApproval(receipt, request, {
    registry: approvalRegistry(), expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2030-01-01T00:00:00.000Z'),
  }).reason, 'approval-expired');
  assert.equal(verifyApproval(receipt, request, {
    registry, expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  }).reason, 'approval-consumed');
  assert.throws(() => createApprovalReceipt({
    id: 'approval-self', approverId: 'worker-one', approverPrincipal: 'human', subjectId: 'worker-one',
    action: 'provider.write', resource: 'demo', policyId: 'authority.external-write', decision: 'approved',
    expiresAt: '2030-01-01T00:00:00.000Z', singleUse: true,
  }), /invalid/);
});

test('approval registry rejects ID collisions and permits only one reentrant consumer', () => {
  const registry = approvalRegistry();
  const first = approved('provider.write', 'jira-demo:issues:demo-1', 'worker-one', { singleUse: false });
  const collision = approved('provider.write', 'jira-demo:issues:demo-2', 'worker-one', {
    id: 'approval-one', singleUse: false,
  });
  const baseOptions = {
    registry, expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  };
  assert.equal(verifyApproval(first, {
    subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1', policyId: 'authority.external-write',
  }, baseOptions).valid, true);
  assert.equal(verifyApproval(collision, {
    subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-2', policyId: 'authority.external-write',
  }, baseOptions).reason, 'approval-id-collision');

  const singleRegistry = approvalRegistry();
  const receipt = approved('provider.write', 'jira-demo:issues:demo-1');
  const request = {
    subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1', policyId: 'authority.external-write',
  };
  let inner;
  const options = {
    registry: singleRegistry,
    expectedApproverId: 'human-owner',
    requireHumanApprover: true,
    get nowMs() {
      inner = verifyApproval(receipt, request, {
        registry: singleRegistry, expectedApproverId: 'human-owner', requireHumanApprover: true,
        nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
      });
      return Date.parse('2029-01-01T00:00:00.000Z');
    },
  };
  const outer = verifyApproval(receipt, request, options);
  assert.equal([inner, outer].filter(result => result.valid).length, 1);
  assert.equal([inner, outer].filter(result => result.reason === 'approval-consumed').length, 1);
});

test('approval claims consume only after commit and release safely after failed durable work', () => {
  assert.equal(typeof approvalsModule.claimApproval, 'function');
  const registry = approvalRegistry();
  const receipt = approved('provider.write', 'jira-demo:issues:demo-1');
  const request = { subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1', policyId: 'authority.external-write' };
  const options = { registry, expectedApproverId: 'human-owner', requireHumanApprover: true, requireSingleUse: true, nowMs: Date.parse('2029-01-01T00:00:00.000Z') };
  const first = approvalsModule.claimApproval(receipt, request, options);
  assert.equal(first.valid, true);
  assert.equal(approvalsModule.claimApproval(receipt, request, options).reason, 'approval-pending');
  first.release();
  const second = approvalsModule.claimApproval(receipt, request, options);
  assert.equal(second.valid, true);
  second.commit();
  assert.equal(approvalsModule.claimApproval(receipt, request, options).reason, 'approval-consumed');
  assert.equal(second.commit(), false);
  assert.equal(second.release(), false);
});

test('approval claims finalize before publication and can roll back only an unpublished mutation', () => {
  const registry = approvalRegistry();
  const receipt = approved('provider.write', 'jira-demo:issues:demo-1');
  const request = { subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1', policyId: 'authority.external-write' };
  const options = { registry, expectedApproverId: 'human-owner', requireHumanApprover: true, requireSingleUse: true, nowMs: Date.parse('2029-01-01T00:00:00.000Z') };
  const failedPublish = approvalsModule.claimApproval(receipt, request, options);
  assert.equal(failedPublish.finalize(), true);
  assert.equal(approvalsModule.claimApproval(receipt, request, options).reason, 'approval-consumed');
  assert.equal(failedPublish.rollback(), true);
  const published = approvalsModule.claimApproval(receipt, request, options);
  assert.equal(published.finalize(), true);
  assert.equal(published.publish(), true);
  assert.equal(published.rollback(), false);
  assert.equal(approvalsModule.claimApproval(receipt, request, options).reason, 'approval-consumed');
});

test('approval authority, principal, policy, and decision mismatches fail closed', () => {
  const request = {
    subjectId: 'worker-one', action: 'provider.write', resource: 'jira-demo:issues:demo-1', policyId: 'authority.external-write',
  };
  const options = {
    registry: approvalRegistry(), expectedApproverId: 'human-owner', requireHumanApprover: true,
    nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
  };
  for (const [overrides, reason] of [
    [{ approverId: 'other-human' }, 'approval-authority-mismatch'],
    [{ approverPrincipal: 'agent' }, 'approval-authority-mismatch'],
    [{ policyId: 'authority.other-policy' }, 'approval-binding-mismatch'],
    [{ decision: 'rejected' }, 'approval-rejected'],
  ]) {
    const receipt = approved('provider.write', 'jira-demo:issues:demo-1', 'worker-one', overrides);
    assert.equal(verifyApproval(receipt, request, { ...options, registry: approvalRegistry() }).reason, reason);
  }
  const claimedHuman = approved('provider.write', 'jira-demo:issues:demo-1');
  assert.equal(verifyApproval(claimedHuman, request, {
    ...options,
    registry: approvalRegistry('agent'),
  }).reason, 'approval-authority-mismatch');
  const reusable = approved('provider.write', 'jira-demo:issues:demo-1', 'worker-one', { singleUse: false });
  assert.equal(verifyApproval(reusable, request, {
    ...options, registry: approvalRegistry(), requireSingleUse: true,
  }).reason, 'approval-must-be-single-use');
});

test('authority array proxies are bounded and each length/index getter is read once', () => {
  const accesses = { length: 0, zero: 0 };
  const actions = new Proxy(['file.read'], {
    get(target, property, receiver) {
      if (property === 'length') accesses.length += 1;
      if (property === '0') accesses.zero += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = envelope({ actions });
  assert.deepEqual(result.actions, ['file.read']);
  assert.deepEqual(accesses, { length: 1, zero: 1 });
});
