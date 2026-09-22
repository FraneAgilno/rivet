import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePlanningResult,
  serializePlanningContract,
  validatePlanningPayload,
} from '../../src/prompts/planning-contract.js';

function fixture() {
  return {
    worktree: {
      path: '/private/tmp/conference-planner',
      dev: '16777234',
      ino: '9123456',
      reservationId: 'planning-read-only',
    },
    contract: {
      schemaVersion: 1,
      baselineCommit: 'a'.repeat(40),
      client: 'claude',
      workRequest: {
        schemaVersion: 1,
        digest: 'b'.repeat(64),
        title: 'Add room capacity guidance',
      },
      policy: {
        projectId: 'conference-planner',
        commands: { test: ['npm', 'test'] },
      },
    },
  };
}

function proposal() {
  return {
    schemaVersion: 1,
    id: 'room-capacity-guidance',
    baselineCommit: 'a'.repeat(40),
    workRequestDigest: 'b'.repeat(64),
    client: 'claude',
    providerRefs: ['git-ci-main'],
    nodes: [],
  };
}

test('serializes one deterministic inert planning payload and validates it immutably', () => {
  const input = fixture();
  const source = serializePlanningContract(input);
  const parsed = JSON.parse(source);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.kind, 'agilno.feature-planning');
  assert.deepEqual(parsed.sections, ['worktree', 'contract']);
  assert.equal(parsed.resultContract.kind, 'agilno.feature-decomposition');
  assert.equal(parsed.resultContract.version, 1);
  assert.equal(parsed.resultContract.schema.properties.kind.const, 'agilno.feature-decomposition');
  assert.deepEqual(parsed.resultContract.schema.required, ['schemaVersion', 'kind', 'workItems']);
  assert.match(parsed.resultContract.framing, /exactly one JSON object/);
  assert.match(parsed.resultContract.instructions.join(' '), /one-based acceptance-criterion indexes/i);
  assert.match(parsed.resultContract.instructions.join(' '), /style modules|stylesheet/i);
  assert.match(parsed.resultContract.instructions.join(' '), /only files .* expected to change/i);
  assert.doesNotMatch(parsed.resultContract.instructions.join(' '), /files .* may need to change/i);
  assert.equal(JSON.stringify(validatePlanningPayload(source)), JSON.stringify({
    version: 1,
    worktree: input.worktree,
    contract: input.contract,
  }));
  assert.equal(serializePlanningContract(input), source);
  assert.equal(Object.isFrozen(validatePlanningPayload(source)), true);
});

test('rejects malformed, noncanonical, oversized, secret-bearing, and hostile planning payloads', () => {
  const canonical = serializePlanningContract(fixture());
  const parsed = JSON.parse(canonical);
  for (const source of [
    '',
    '{}',
    `${canonical}{}`,
    JSON.stringify({ ...parsed, extra: true }),
    JSON.stringify({ ...parsed, kind: 'agilno.agent-launch' }),
    JSON.stringify({ ...parsed, contract: { ...parsed.contract, token: 'private-value' } }),
    ' '.repeat(512 * 1024 + 1),
  ]) {
    assert.throws(() => validatePlanningPayload(source));
  }

  const hostile = fixture();
  Object.defineProperty(hostile.contract, 'client', {
    enumerable: true,
    get() { throw new Error('private canary'); },
  });
  assert.throws(() => serializePlanningContract(hostile), error => !error.message.includes('private canary'));
});

test('parses exactly one bounded immutable plan result and rejects unsafe output', () => {
  const expected = proposal();
  const parsed = parsePlanningResult(Buffer.from(`${JSON.stringify(expected)}\n`, 'utf8'));
  assert.equal(JSON.stringify(parsed), JSON.stringify(expected));
  assert.equal(Object.isFrozen(parsed), true);
  const wrapped = parsePlanningResult(Buffer.from(`${JSON.stringify({
    type: 'result', subtype: 'success', structured_output: expected,
  })}\n`, 'utf8'));
  assert.equal(JSON.stringify(wrapped), JSON.stringify(expected));
  assert.equal(Object.isFrozen(wrapped), true);

  for (const output of [
    Buffer.from('not-json'),
    Buffer.from(`${JSON.stringify(expected)}\n${JSON.stringify(expected)}`),
    Buffer.from(JSON.stringify({ ...expected, token: 'private-value' })),
    Buffer.from(JSON.stringify({ type: 'result', subtype: 'error', structured_output: expected })),
    Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', structured_output: [] })),
    Buffer.from([0xff]),
    Buffer.alloc(512 * 1024 + 1, 0x20),
  ]) {
    assert.throws(() => parsePlanningResult(output));
  }
});
