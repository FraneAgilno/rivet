import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BudgetPolicyError,
  createBudgetSnapshot,
  evaluateBudget,
  observeBudget,
} from '../../src/policy/budget.js';

const limits = {
  elapsedMs: 60_000,
  agentTurns: 10,
  retries: 2,
  childCount: 3,
  activeNodes: 2,
  tokens: 10_000,
  costUsd: '0.30',
};

test('budget observations are immutable, monotonic, integer-safe, and exact for decimals', () => {
  const initial = createBudgetSnapshot(limits, { nowMs: 1_000 });
  const next = observeBudget(initial, {
    agentTurns: 1, retries: 1, childCount: 2, activeNodes: 2, tokens: 5_000, costUsd: '0.10',
  }, { nowMs: 31_000 });
  const final = observeBudget(next, {
    agentTurns: 2, retries: 1, childCount: 2, activeNodes: 1, tokens: 10_000, costUsd: '0.30',
  }, { nowMs: 61_000 });
  assert.equal(initial.usage.agentTurns, 0);
  assert.equal(next.usage.costUsd, '0.1');
  assert.equal(final.usage.costUsd, '0.3');
  assert.ok(Object.isFrozen(final));
  assert.ok(Object.isFrozen(final.usage));
  assert.deepEqual(evaluateBudget(final), {
    decision: 'deny', policyId: 'budget.exhausted', reason: 'elapsed-time-exhausted', exhausted: ['elapsedMs', 'tokens', 'costUsd'],
  });
});

test('budget exhaustion fails closed for every tracked limit', () => {
  for (const [field, value] of [
    ['agentTurns', 10], ['retries', 2], ['childCount', 3], ['activeNodes', 2],
  ]) {
    const snapshot = observeBudget(createBudgetSnapshot(limits, { nowMs: 0 }), { [field]: value }, { nowMs: 1 });
    const decision = evaluateBudget(snapshot);
    assert.equal(decision.decision, 'deny');
    assert.ok(decision.exhausted.includes(field));
  }
});

test('cumulative observations cannot go backward or increase remaining budget', () => {
  const initial = createBudgetSnapshot(limits, { nowMs: 100 });
  const observed = observeBudget(initial, { agentTurns: 2, retries: 1, childCount: 1, tokens: 100, costUsd: '0.2' }, { nowMs: 200 });
  for (const observation of [
    { agentTurns: 1 }, { retries: 0 }, { childCount: 0 }, { tokens: 99 }, { costUsd: '0.19' },
  ]) assert.throws(() => observeBudget(observed, observation, { nowMs: 300 }), /monotonic/);
  assert.throws(() => observeBudget(observed, {}, { nowMs: 199 }), /monotonic/);
  assert.doesNotThrow(() => observeBudget(observed, { activeNodes: 0 }, { nowMs: 300 }));
});

test('invalid, unsafe, or aliased budget inputs fail closed without mutation', () => {
  assert.throws(() => createBudgetSnapshot({ ...limits, agentTurns: Number.MAX_SAFE_INTEGER + 1 }), BudgetPolicyError);
  assert.equal(createBudgetSnapshot({ ...limits, costUsd: 0.1 + 0.2 }, { nowMs: 0 }).limits.costUsd, '0.30000000000000004');
  assert.throws(() => createBudgetSnapshot({ ...limits, extra: 1 }), BudgetPolicyError);
  assert.throws(() => createBudgetSnapshot({ ...limits, costUsd: 0 }), BudgetPolicyError);
  const source = { ...limits };
  const snapshot = createBudgetSnapshot(source, { nowMs: 0 });
  source.agentTurns = 1;
  assert.equal(snapshot.limits.agentTurns, 10);
});

test('hostile getters are read once and errors never expose caught values', () => {
  const canary = 'budget-private-canary';
  let accesses = 0;
  const source = { ...limits };
  Object.defineProperty(source, 'costUsd', {
    enumerable: true,
    get() { accesses += 1; throw new Error(canary); },
  });
  assert.throws(() => createBudgetSnapshot(source, { nowMs: 0 }), error => {
    assert.ok(error instanceof BudgetPolicyError);
    assert.equal(error.message.includes(canary), false);
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  });
  assert.equal(accesses, 1);
});
