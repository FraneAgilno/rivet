import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdapter, createSourceEnvelope } from '../../src/adapters/contract.js';
import { WorkRequestError, validateWorkRequest } from '../../src/work-request/contract.js';
import { resolveTrackerWorkRequest } from '../../src/work-request/tracker.js';

const NOW = '2029-01-01T00:00:00.000Z';

function envelope(provider, normalized, overrides = {}) {
  return createSourceEnvelope({
    provider,
    sourceId: normalized.id,
    sourceUrl: provider === 'jira'
      ? `https://jira.example.test/browse/${normalized.id}`
      : `https://linear.app/example/issue/${normalized.id}/feature`,
    fetchedAt: NOW,
    fixtureSource: false,
    raw: { id: normalized.id, rawOnlyMarker: 'must-not-enter-work-request' },
    normalized,
    retryClassification: 'none',
    capabilities: { read: ['issue'], write: [] },
    ...overrides,
  });
}

function adapter(provider, result, calls = []) {
  return createAdapter({
    provider,
    fixtureSource: false,
    capabilities: { read: ['issue'], write: [] },
    async read(input) { calls.push(input); return result; },
    async write() { throw new Error('not used'); },
  });
}

test('resolves a Jira issue into a checksum-bound canonical work request', async () => {
  const calls = [];
  const source = envelope('jira', {
    id: 'DEMO-42',
    summary: 'Conference agenda',
    description: 'Build a robust agenda workflow.',
    acceptanceCriteria: ['AC1: filter by track', 'AC2: export the agenda'],
    revision: '2029-01-01T00:00:00.000Z',
    epicId: 'DEMO-1',
    links: [{ id: '10', type: 'Blocks', issueId: 'DEMO-43' }],
    comments: [{ id: '100', body: 'private discussion', author: 'Reviewer' }],
  });
  const signal = AbortSignal.abort();

  const request = await resolveTrackerWorkRequest({
    provider: 'jira', ticketId: 'DEMO-42', adapter: adapter('jira', source, calls), signal,
  });

  assert.deepEqual(calls, [{ kind: 'issue', id: 'DEMO-42', signal }]);
  assert.equal(request.source.kind, 'jira');
  assert.equal(request.source.ref, 'DEMO-42');
  assert.equal(request.source.url, 'https://jira.example.test/browse/DEMO-42');
  assert.equal(request.source.revision, `2029-01-01T00:00:00.000Z#sha256:${source.digest}`);
  assert.equal(request.title, 'Conference agenda');
  assert.equal(request.description, 'Build a robust agenda workflow.');
  assert.deepEqual(request.acceptanceCriteria, ['AC1: filter by track', 'AC2: export the agenda']);
  assert.deepEqual(request.contextRefs, ['jira:DEMO-1', 'jira:DEMO-43']);
  assert.equal(JSON.stringify(request).includes('must-not-enter-work-request'), false);
  assert.equal(JSON.stringify(request).includes('private discussion'), false);
  assert.equal(validateWorkRequest(request), request);
  assert.equal(Object.isFrozen(request), true);
});

test('resolves a Linear issue through the same contract and falls back to envelope digest revision', async () => {
  const source = envelope('linear', {
    id: 'DEMO-123',
    summary: 'Smart agenda builder',
    description: 'Recommend sessions without conflicts.',
    acceptanceCriteria: ['AC1: preserve accepted sessions'],
    revision: '',
    links: [{ id: 'relation-1', type: 'blocks', issueId: 'DEMO-124' }],
    comments: [],
  });

  const request = await resolveTrackerWorkRequest({
    provider: 'linear', ticketId: 'DEMO-123', adapter: adapter('linear', source),
  });

  assert.equal(request.source.kind, 'linear');
  assert.equal(request.source.revision, `sha256:${source.digest}`);
  assert.deepEqual(request.contextRefs, ['linear:DEMO-124']);
  assert.equal(validateWorkRequest(request), request);
});

test('rejects missing acceptance criteria and every adapter or envelope identity mismatch', async t => {
  const valid = {
    id: 'DEMO-123', summary: 'Feature', description: 'Description',
    acceptanceCriteria: ['AC1: done'], revision: NOW, links: [], comments: [],
  };
  const cases = [
    ['missing criteria', {
      provider: 'linear', ticketId: 'DEMO-123',
      adapter: adapter('linear', envelope('linear', { ...valid, acceptanceCriteria: [] })),
    }],
    ['adapter provider mismatch', {
      provider: 'linear', ticketId: 'DEMO-123', adapter: adapter('jira', envelope('jira', { ...valid, id: 'DEMO-123' })),
    }],
    ['envelope provider mismatch', {
      provider: 'linear', ticketId: 'DEMO-123', adapter: adapter('linear', envelope('jira', { ...valid, id: 'DEMO-123' })),
    }],
    ['source identity mismatch', {
      provider: 'linear', ticketId: 'DEMO-123', adapter: adapter('linear', envelope('linear', { ...valid, id: 'DEMO-124' })),
    }],
  ];

  for (const [name, input] of cases) {
    await t.test(name, async () => {
      await assert.rejects(() => resolveTrackerWorkRequest(input), WorkRequestError);
    });
  }
});

test('rejects unknown providers, malformed ticket IDs, and unbranded adapters before reading', async () => {
  const read = async () => { throw new Error('must not run'); };
  for (const input of [
    { provider: 'github', ticketId: 'DEMO-123', adapter: { provider: 'github', read } },
    { provider: 'linear', ticketId: '../DEMO-123', adapter: { provider: 'linear', read } },
    { provider: 'linear', ticketId: 'DEMO-123', adapter: { provider: 'linear', read } },
  ]) await assert.rejects(() => resolveTrackerWorkRequest(input), WorkRequestError);
});

test('direct tracker supplements preserve source provenance and bind the exact source-first criteria union', async () => {
  for (const provider of ['jira', 'linear']) {
    for (const sourceCriteria of [[], ['Source criterion']]) {
      const source = envelope(provider, { id: 'DEMO-42', summary: 'Feature', description: 'Description', acceptanceCriteria: sourceCriteria, revision: NOW, links: [], comments: [] });
      const input = { provider, ticketId: 'DEMO-42', adapter: adapter(provider, source), userAcceptanceCriteria: ['User criterion', ...(sourceCriteria.length ? ['Source criterion'] : [])] };
      const request = await resolveTrackerWorkRequest(input);
      assert.deepEqual(request.acceptanceCriteria, [...new Set([...sourceCriteria, ...input.userAcceptanceCriteria])]);
      assert.deepEqual(request.criteriaProvenance, { sourceAcceptanceCriteria: sourceCriteria, userAcceptanceCriteria: input.userAcceptanceCriteria });
      assert.equal(request.source.revision, `${NOW}#sha256:${source.digest}`);
      assert.equal(validateWorkRequest(JSON.parse(JSON.stringify(request))).digest, request.digest);
      const changed = structuredClone(request); changed.criteriaProvenance.userAcceptanceCriteria[0] = 'Changed';
      assert.throws(() => validateWorkRequest(changed));
      input.userAcceptanceCriteria[0] = 'Later edit';
      assert.equal(request.criteriaProvenance.userAcceptanceCriteria[0], 'User criterion');
    }
  }
});
test('missing direct criteria gives an actionable user-input remedy; invalid supplements do not read the tracker', async () => {
  const source = envelope('jira', { id: 'DEMO-42', summary: 'Feature', description: 'Description', acceptanceCriteria: [], revision: NOW, links: [], comments: [] });
  await assert.rejects(resolveTrackerWorkRequest({provider:'jira',ticketId:'DEMO-42',adapter:adapter('jira',source)}), error => /Ask the user/.test(error.safeMessage) && /--acceptance-criteria/.test(error.safeMessage));
  for (const userAcceptanceCriteria of [[], [''], [' '], ...Array.from({length:32},(_,index)=>['valid'+String.fromCharCode(index)+'text']), ['valid'+String.fromCharCode(127)+'text'], ['x\nsecond'], ['x'.repeat(4097)], Array(257).fill('x'), ['authorization: Bearer abcdefghijklmnop']]) {
    const calls=[];
    await assert.rejects(resolveTrackerWorkRequest({provider:'jira',ticketId:'DEMO-42',adapter:adapter('jira',source,calls),userAcceptanceCriteria}));
    assert.equal(calls.length,0);
  }
});
