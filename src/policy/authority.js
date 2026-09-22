import { verifyApproval } from './approvals.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const HUMAN_GATED = new Set([
  'activation', 'scope-change', 'external-write', 'dependency.install',
  'visual-baseline', 'visual-baseline.accept', 'merge', 'git.merge', 'deploy', 'deploy.execute',
  'jira.final-state', 'docs.publish', 'publication', 'final-delivery',
]);
const envelopes = new WeakSet();
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class AuthorityPolicyError extends Error {
  constructor(reason = 'invalid-authority') {
    super(reason === 'overlapping-owned-paths'
      ? 'Authority contains overlapping owned paths.'
      : 'Authority policy input is invalid.');
    this.name = 'AuthorityPolicyError';
    this.code = 'ERR_AUTHORITY_POLICY';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) {
  throw new AuthorityPolicyError(reason);
}

function capture(value, allowed, required, reason) {
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
    if (error instanceof AuthorityPolicyError) throw error;
    fail(reason);
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail(reason);
  return result;
}

function array(value, limit, reason) {
  if (!Array.isArray(value)) fail(reason);
  const result = [];
  try {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) fail(reason);
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(reason);
      result.push(value[index]);
    }
  } catch (error) {
    if (error instanceof AuthorityPolicyError) throw error;
    fail(reason);
  }
  return result;
}

function validId(value) {
  return typeof value === 'string' && value.length <= 64 && ID.test(value);
}

function uniqueStrings(value, pattern, limit, reason) {
  const values = array(value, limit, reason);
  if (values.some(item => typeof item !== 'string' || item.length > 100 || !pattern.test(item))) fail(reason);
  if (new Set(values).size !== values.length) fail(reason);
  return values.sort();
}

function canonicalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) fail('invalid-path');
  if (value.includes('\\')) fail('invalid-path');
  const normalized = value.normalize('NFKC');
  if (normalized !== value && /[/\\:]/.test(normalized)) fail('invalid-path');
  if (/[\\:]/.test(normalized)) fail('invalid-path');
  const parts = normalized.split('/');
  if (
    normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.endsWith('/')
    || normalized.includes('//') || /[\u0000\r\n]/.test(normalized)
    || parts.some(part => (
      part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
      || WINDOWS_RESERVED.test(part)
    ))
  ) fail('invalid-path');
  return parts.join('/');
}

function containsPath(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function canonicalOwnedPaths(value) {
  const paths = array(value, 256, 'invalid-owned-paths').map(canonicalPath).sort();
  const folded = paths.map(path => path.toUpperCase().toLowerCase().normalize('NFKC')).sort();
  if (new Set(folded).size !== folded.length) fail('overlapping-owned-paths');
  for (let left = 0; left < folded.length; left += 1) {
    for (let right = left + 1; right < folded.length; right += 1) {
      if (containsPath(folded[left], folded[right])) {
        throw new AuthorityPolicyError('overlapping-owned-paths');
      }
    }
  }
  return paths;
}

function captureProviders(value) {
  const providers = array(value, 64, 'invalid-providers').map(item => {
    const provider = capture(item, new Set(['id', 'mode', 'capabilities']), ['id', 'mode', 'capabilities'], 'invalid-provider');
    if (!validId(provider.id) || !['disabled', 'read-only', 'read-write-with-approval'].includes(provider.mode)) fail('invalid-provider');
    const capabilities = uniqueStrings(provider.capabilities, ID, 64, 'invalid-provider');
    return Object.freeze({ id: provider.id, mode: provider.mode, capabilities: Object.freeze(capabilities) });
  }).sort((left, right) => (left.id < right.id ? -1 : (left.id > right.id ? 1 : 0)));
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) fail('invalid-providers');
  return providers;
}

function authorityMessage(reason) {
  if (reason === 'action-ceiling' || reason === 'path-ceiling' || reason === 'provider-ceiling' || reason === 'command-ceiling') {
    const error = new AuthorityPolicyError(reason);
    error.message = 'Delegated authority exceeds the authority ceiling.';
    error.safeMessage = error.message;
    throw error;
  }
  fail(reason);
}

export function createAuthorityEnvelope(input) {
  try {
    const value = capture(input, new Set([
      'actorId', 'principal', 'role', 'actions', 'ownedPaths', 'providers', 'commands',
    ]), ['actorId', 'principal', 'actions', 'ownedPaths', 'providers', 'commands'], 'invalid-authority');
    if (!validId(value.actorId) || !['agent', 'human'].includes(value.principal)) fail('invalid-principal');
    if (value.role !== undefined && (!validId(value.role))) fail('invalid-role-label');
    const actions = uniqueStrings(value.actions, ACTION, 128, 'invalid-actions');
    const ownedPaths = canonicalOwnedPaths(value.ownedPaths);
    const providers = captureProviders(value.providers);
    const commands = uniqueStrings(value.commands, ID, 64, 'invalid-commands');
    const envelope = Object.freeze({
      actorId: value.actorId,
      principal: value.principal,
      ...(value.role === undefined ? {} : { role: value.role }),
      actions: Object.freeze(actions),
      ownedPaths: Object.freeze(ownedPaths),
      providers: Object.freeze(providers),
      commands: Object.freeze(commands),
    });
    envelopes.add(envelope);
    return envelope;
  } catch (error) {
    if (error instanceof AuthorityPolicyError) throw error;
    fail('invalid-authority');
  }
}

function providerWithin(child, parent) {
  const ceiling = parent.providers.find(provider => provider.id === child.id);
  if (!ceiling) return false;
  const modes = { disabled: 0, 'read-only': 1, 'read-write-with-approval': 2 };
  return modes[child.mode] <= modes[ceiling.mode]
    && child.capabilities.every(capability => ceiling.capabilities.includes(capability));
}

export function grant(childInput, actionsInput, parent) {
  try {
    if (!envelopes.has(parent)) fail('invalid-parent-authority');
    const child = capture(childInput, new Set([
      'actorId', 'principal', 'role', 'ownedPaths', 'providers', 'commands',
    ]), ['actorId'], 'invalid-child-authority');
    const actions = uniqueStrings(actionsInput, ACTION, 128, 'invalid-actions');
    if (!actions.every(action => parent.actions.includes(action))) authorityMessage('action-ceiling');
    const candidate = createAuthorityEnvelope({
      actorId: child.actorId,
      principal: child.principal ?? 'agent',
      ...(child.role === undefined ? {} : { role: child.role }),
      actions,
      ownedPaths: child.ownedPaths ?? [],
      providers: child.providers ?? [],
      commands: child.commands ?? [],
    });
    if (candidate.principal === 'human' && parent.principal !== 'human') authorityMessage('action-ceiling');
    if (!candidate.ownedPaths.every(path => parent.ownedPaths.some(parentPath => containsPath(parentPath, path)))) authorityMessage('path-ceiling');
    if (!candidate.providers.every(provider => providerWithin(provider, parent))) authorityMessage('provider-ceiling');
    if (!candidate.commands.every(command => parent.commands.includes(command))) authorityMessage('command-ceiling');
    return candidate;
  } catch (error) {
    if (error instanceof AuthorityPolicyError) throw error;
    fail('invalid-grant');
  }
}

function decision(value, policyId, reason) {
  return Object.freeze({ decision: value, policyId, reason });
}

function approvalResource(request) {
  if (request.action === 'provider.write') return `${request.providerId}:${request.capability}:${request.resource}`;
  return request.resource;
}

function withApproval(authority, request, options, policyId) {
  if (!options.approval || !options.approvalRegistry || !options.expectedApproverId || options.nowMs === undefined) {
    return decision('approval-required', policyId, 'human-approval-required');
  }
  const verified = verifyApproval(options.approval, {
    subjectId: authority.actorId,
    action: request.action,
    resource: approvalResource(request),
    policyId,
  }, {
    registry: options.approvalRegistry,
    expectedApproverId: options.expectedApproverId,
    requireHumanApprover: true,
    requireSingleUse: true,
    nowMs: options.nowMs,
  });
  return verified.valid
    ? decision('allow', policyId, 'approved')
    : decision('approval-required', policyId, verified.reason);
}

export function evaluateAuthority(authority, requestInput, optionsInput = {}) {
  try {
    if (!envelopes.has(authority)) fail('invalid-authority');
    const request = capture(requestInput, new Set([
      'actorId', 'action', 'resource', 'providerId', 'capability', 'commandId', 'subjectId',
    ]), ['actorId', 'action', 'resource'], 'invalid-request');
    const options = capture(optionsInput, new Set([
      'approval', 'approvalRegistry', 'expectedApproverId', 'nowMs',
    ]), [], 'invalid-options');
    if (!validId(request.actorId) || request.actorId !== authority.actorId) return decision('deny', 'authority.actor-binding', 'actor-mismatch');
    if (typeof request.action !== 'string' || !ACTION.test(request.action) || request.action.length > 100) fail('invalid-action');
    if (typeof request.resource !== 'string' || request.resource.length === 0 || request.resource.length > 500 || /[\u0000\r\n]/.test(request.resource)) fail('invalid-resource');
    if (!authority.actions.includes(request.action)) return decision('deny', 'authority.explicit-action', 'action-not-granted');

    if (request.action === 'file.read' || request.action === 'file.write') {
      const path = canonicalPath(request.resource);
      if (!authority.ownedPaths.some(owned => containsPath(owned, path))) {
        return decision('deny', 'authority.file-ownership', 'resource-not-owned');
      }
    }

    if (request.action.startsWith('command.') || request.action === 'dependency.install') {
      if (!validId(request.commandId) || request.resource !== request.commandId || !authority.commands.includes(request.commandId)) {
        return decision('deny', 'authority.command-allowlist', 'command-not-allowlisted');
      }
    }

    if (request.action === 'provider.read' || request.action === 'provider.write') {
      if (!validId(request.providerId) || !validId(request.capability)) fail('invalid-provider-request');
      const provider = authority.providers.find(item => item.id === request.providerId);
      if (!provider || !provider.capabilities.includes(request.capability) || provider.mode === 'disabled') {
        return decision('deny', 'authority.provider-capability', 'provider-action-not-granted');
      }
      if (request.action === 'provider.write') {
        if (provider.mode !== 'read-write-with-approval') return decision('deny', 'authority.provider-mode', 'provider-read-only');
        return withApproval(authority, request, options, 'authority.external-write');
      }
    }

    if (request.action === 'approval.record') {
      if (!validId(request.subjectId)) return decision('deny', 'authority.approval-subject', 'invalid-approval-subject');
      if (request.subjectId === authority.actorId) {
        return decision('deny', 'authority.separation-of-duties', 'self-approval-forbidden');
      }
    }
    if (HUMAN_GATED.has(request.action)) {
      if (authority.principal === 'human') return decision('allow', `authority.human-gate.${request.action}`, 'human-authority');
      return decision('approval-required', `authority.human-gate.${request.action}`, 'human-approval-required');
    }
    return decision('allow', 'authority.explicit-action', 'action-granted');
  } catch (error) {
    if (error instanceof AuthorityPolicyError) throw error;
    fail('invalid-policy-input');
  }
}
