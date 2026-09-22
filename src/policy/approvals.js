const APPROVAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const receipts = new WeakSet();
const registries = new WeakMap();

export class ApprovalPolicyError extends Error {
  constructor(reason = 'invalid-approval') {
    super('Approval policy input is invalid.');
    this.name = 'ApprovalPolicyError';
    this.code = 'ERR_APPROVAL_POLICY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new ApprovalPolicyError(reason); }

function captureObject(value, allowed, required, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(reason); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) fail(reason);
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) fail(reason);
      result[key] = value[key];
    }
  } catch (error) {
    if (error instanceof ApprovalPolicyError) throw error;
    fail(reason);
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail(reason);
  return result;
}

function validId(value) {
  return typeof value === 'string' && value.length <= 64 && APPROVAL_ID.test(value);
}

function validAction(value) {
  return typeof value === 'string' && value.length <= 100 && ACTION_ID.test(value);
}

function validResource(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 && !/[\u0000\r\n]/.test(value);
}

function timestampMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('invalid-expiry');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || new Date(result).toISOString() !== value) fail('invalid-expiry');
  return result;
}

function fingerprint(receipt) {
  return JSON.stringify([
    receipt.id, receipt.approverId, receipt.approverPrincipal, receipt.subjectId,
    receipt.action, receipt.resource, receipt.policyId, receipt.decision,
    receipt.expiresAt, receipt.singleUse,
  ]);
}

export function createApprovalRegistry(input) {
  try {
    const value = captureObject(input, new Set(['approvers']), ['approvers'], 'invalid-registry');
    if (!Array.isArray(value.approvers)) fail('invalid-registry');
    const length = value.approvers.length;
    if (!Number.isSafeInteger(length) || length < 1 || length > 64) fail('invalid-registry');
    const approvers = new Map();
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value.approvers, index)) fail('invalid-registry');
      const approver = captureObject(value.approvers[index], new Set(['id', 'principal']), ['id', 'principal'], 'invalid-registry');
      if (!validId(approver.id) || !['human', 'agent'].includes(approver.principal) || approvers.has(approver.id)) fail('invalid-registry');
      approvers.set(approver.id, approver.principal);
    }
    const registry = Object.freeze(Object.create(null));
    registries.set(registry, { approvers, records: new Map(), consumed: new Set(), pending: new Map() });
    return registry;
  } catch (error) {
    if (error instanceof ApprovalPolicyError) throw error;
    fail('invalid-registry');
  }
}

export function createApprovalReceipt(input) {
  try {
    const value = captureObject(input, new Set([
      'id', 'approverId', 'approverPrincipal', 'subjectId', 'action', 'resource', 'policyId',
      'decision', 'expiresAt', 'singleUse',
    ]), [
      'id', 'approverId', 'approverPrincipal', 'subjectId', 'action', 'resource', 'policyId',
      'decision', 'expiresAt', 'singleUse',
    ], 'invalid-approval');
    if (!validId(value.id) || !validId(value.approverId) || !validId(value.subjectId)) fail('invalid-identity');
    if (!['human', 'agent'].includes(value.approverPrincipal)) fail('invalid-approver-principal');
    if (!validAction(value.action) || !validAction(value.policyId)) fail('invalid-policy-binding');
    if (!validResource(value.resource)) fail('invalid-resource');
    if (!['approved', 'rejected'].includes(value.decision)) fail('invalid-decision');
    timestampMs(value.expiresAt);
    if (typeof value.singleUse !== 'boolean') fail('invalid-single-use');
    if (value.approverId === value.subjectId) fail('self-approval');
    const receipt = Object.freeze({
      id: value.id,
      approverId: value.approverId,
      approverPrincipal: value.approverPrincipal,
      subjectId: value.subjectId,
      action: value.action,
      resource: value.resource,
      policyId: value.policyId,
      decision: value.decision,
      expiresAt: value.expiresAt,
      singleUse: value.singleUse,
    });
    receipts.add(receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ApprovalPolicyError) throw error;
    fail('invalid-approval');
  }
}

function result(valid, reason, receiptId) {
  return Object.freeze({ valid, reason, ...(receiptId ? { receiptId } : {}) });
}

export function verifyApproval(receipt, requestInput, optionsInput) {
  try {
    if (!receipts.has(receipt)) return result(false, 'untrusted-approval');
    const request = captureObject(requestInput, new Set([
      'subjectId', 'action', 'resource', 'policyId',
    ]), ['subjectId', 'action', 'resource', 'policyId'], 'invalid-request');
    const options = captureObject(optionsInput, new Set([
      'registry', 'expectedApproverId', 'requireHumanApprover', 'requireSingleUse', 'nowMs',
    ]), ['registry', 'expectedApproverId', 'requireHumanApprover', 'nowMs'], 'invalid-options');
    const registry = registries.get(options.registry);
    if (!registry) fail('invalid-approval-registry');
    if (!validId(options.expectedApproverId) || typeof options.requireHumanApprover !== 'boolean') fail('invalid-approval-authority');
    if (options.requireSingleUse !== undefined && typeof options.requireSingleUse !== 'boolean') fail('invalid-approval-authority');
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) fail('invalid-clock');
    if (!validId(request.subjectId) || !validAction(request.action) || !validAction(request.policyId) || !validResource(request.resource)) fail('invalid-request');

    const receiptFingerprint = fingerprint(receipt);
    const registered = registry.records.get(receipt.id);
    if (registered !== undefined && registered !== receiptFingerprint) return result(false, 'approval-id-collision', receipt.id);
    if (receipt.singleUse && registry.consumed.has(receipt.id)) return result(false, 'approval-consumed', receipt.id);
    if (registry.pending.has(receipt.id)) return result(false, 'approval-pending', receipt.id);
    if (receipt.decision !== 'approved') return result(false, 'approval-rejected', receipt.id);
    if (timestampMs(receipt.expiresAt) <= options.nowMs) return result(false, 'approval-expired', receipt.id);
    if (receipt.approverId !== options.expectedApproverId) return result(false, 'approval-authority-mismatch', receipt.id);
    const configuredPrincipal = registry.approvers.get(options.expectedApproverId);
    if (!configuredPrincipal || configuredPrincipal !== receipt.approverPrincipal) return result(false, 'approval-authority-mismatch', receipt.id);
    if (options.requireHumanApprover && configuredPrincipal !== 'human') return result(false, 'approval-authority-mismatch', receipt.id);
    if (options.requireSingleUse && !receipt.singleUse) return result(false, 'approval-must-be-single-use', receipt.id);
    if (
      receipt.subjectId !== request.subjectId || receipt.action !== request.action
      || receipt.resource !== request.resource || receipt.policyId !== request.policyId
    ) return result(false, 'approval-binding-mismatch', receipt.id);

    registry.records.set(receipt.id, receiptFingerprint);
    if (receipt.singleUse) registry.consumed.add(receipt.id);
    return result(true, 'approval-valid', receipt.id);
  } catch (error) {
    if (error instanceof ApprovalPolicyError) throw error;
    fail('invalid-approval');
  }
}

export function claimApproval(receipt, requestInput, optionsInput) {
  try {
    if (!receipts.has(receipt)) return result(false, 'untrusted-approval');
    const request = captureObject(requestInput, new Set([
      'subjectId', 'action', 'resource', 'policyId',
    ]), ['subjectId', 'action', 'resource', 'policyId'], 'invalid-request');
    const options = captureObject(optionsInput, new Set([
      'registry', 'expectedApproverId', 'requireHumanApprover', 'requireSingleUse', 'nowMs',
    ]), ['registry', 'expectedApproverId', 'requireHumanApprover', 'nowMs'], 'invalid-options');
    const registry = registries.get(options.registry);
    if (!registry) fail('invalid-approval-registry');
    if (!validId(options.expectedApproverId) || typeof options.requireHumanApprover !== 'boolean') fail('invalid-approval-authority');
    if (options.requireSingleUse !== undefined && typeof options.requireSingleUse !== 'boolean') fail('invalid-approval-authority');
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) fail('invalid-clock');
    if (!validId(request.subjectId) || !validAction(request.action) || !validAction(request.policyId) || !validResource(request.resource)) fail('invalid-request');

    const receiptFingerprint = fingerprint(receipt);
    const registered = registry.records.get(receipt.id);
    if (registered !== undefined && registered !== receiptFingerprint) return result(false, 'approval-id-collision', receipt.id);
    if (receipt.singleUse && registry.consumed.has(receipt.id)) return result(false, 'approval-consumed', receipt.id);
    if (registry.pending.has(receipt.id)) return result(false, 'approval-pending', receipt.id);
    if (receipt.decision !== 'approved') return result(false, 'approval-rejected', receipt.id);
    if (timestampMs(receipt.expiresAt) <= options.nowMs) return result(false, 'approval-expired', receipt.id);
    if (receipt.approverId !== options.expectedApproverId) return result(false, 'approval-authority-mismatch', receipt.id);
    const configuredPrincipal = registry.approvers.get(options.expectedApproverId);
    if (!configuredPrincipal || configuredPrincipal !== receipt.approverPrincipal) return result(false, 'approval-authority-mismatch', receipt.id);
    if (options.requireHumanApprover && configuredPrincipal !== 'human') return result(false, 'approval-authority-mismatch', receipt.id);
    if (options.requireSingleUse && !receipt.singleUse) return result(false, 'approval-must-be-single-use', receipt.id);
    if (receipt.subjectId !== request.subjectId || receipt.action !== request.action
      || receipt.resource !== request.resource || receipt.policyId !== request.policyId) {
      return result(false, 'approval-binding-mismatch', receipt.id);
    }

    const token = Object.freeze(Object.create(null));
    registry.pending.set(receipt.id, token);
    let active = true;
    let finalized = false;
    const priorRecord = registry.records.get(receipt.id);
    const priorConsumed = registry.consumed.has(receipt.id);
    const claim = {
      valid: true,
      reason: 'approval-claimed',
      receiptId: receipt.id,
      finalize() {
        if (!active || finalized || registry.pending.get(receipt.id) !== token) return false;
        registry.records.set(receipt.id, receiptFingerprint);
        if (receipt.singleUse) registry.consumed.add(receipt.id);
        finalized = true;
        return true;
      },
      publish() {
        if (!active || !finalized || registry.pending.get(receipt.id) !== token) return false;
        registry.pending.delete(receipt.id);
        active = false;
        return true;
      },
      rollback() {
        if (!active || !finalized || registry.pending.get(receipt.id) !== token) return false;
        if (priorRecord === undefined) registry.records.delete(receipt.id);
        else registry.records.set(receipt.id, priorRecord);
        if (!priorConsumed) registry.consumed.delete(receipt.id);
        registry.pending.delete(receipt.id);
        active = false;
        return true;
      },
      commit() {
        if (!this.finalize()) return false;
        return this.publish();
      },
      release() {
        if (!active || finalized || registry.pending.get(receipt.id) !== token) return false;
        registry.pending.delete(receipt.id);
        active = false;
        return true;
      },
    };
    return Object.freeze(claim);
  } catch (error) {
    if (error instanceof ApprovalPolicyError) throw error;
    fail('invalid-approval');
  }
}
