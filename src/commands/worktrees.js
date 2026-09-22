import { createReservedWorktree, recoverStaleWorktree, verifyReservedWorktree } from '../git/worktrees.js';
import { reconcileWorktree } from '../git/reconcile.js';

function captureRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid worktree command request');
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid worktree command request');
  const result = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) throw new TypeError('Invalid worktree command request');
      result[key] = input[key];
    }
  } catch {
    throw new TypeError('Invalid worktree command request');
  }
  if (typeof result.action !== 'string') throw new TypeError('Invalid worktree command request');
  return Object.freeze(result);
}

export async function runWorktreeCommand(input, dependencies = {}) {
  const request = captureRequest(input);
  const options = Object.freeze({
    gitClient: dependencies.gitClient,
    nowMs: dependencies.nowMs,
  });
  if (request.action === 'create') {
    const { action: _action, ...payload } = request;
    return createReservedWorktree(payload, options);
  }
  if (request.action === 'inspect') {
    const { action: _action, ...payload } = request;
    return verifyReservedWorktree(payload, options);
  }
  if (request.action === 'reconcile') {
    const { action: _action, ...payload } = request;
    return reconcileWorktree(payload, options);
  }
  if (request.action === 'recover') {
    const { action: _action, ...payload } = request;
    return recoverStaleWorktree(payload, dependencies);
  }
  throw new TypeError('Invalid worktree command action');
}

export function formatWorktreeResult(result, options = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Invalid worktree command result');
  if (options.json === true) return JSON.stringify(result);
  const status = typeof result.status === 'string' ? result.status : result.reservation?.status;
  return `Worktree: ${status ?? 'unknown'}.`;
}
