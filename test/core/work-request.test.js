import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  createWorkRequest,
  validateWorkRequest,
  workRequestDigest,
} from '../../src/work-request/contract.js';

const BASE = Object.freeze({
  source: Object.freeze({ kind: 'inline', ref: 'inline' }),
  title: 'Add calendar export',
  description: 'Export the accepted agenda as iCalendar.',
  acceptanceCriteria: Object.freeze(['The persisted agenda downloads as .ics.']),
  contextRefs: Object.freeze([]),
  capturedAt: '2026-08-31T12:00:00.000Z',
});

test('creates one immutable checksum-bound work request contract', () => {
  const request = createWorkRequest(BASE);

  assert.equal(request.schemaVersion, 1);
  assert.match(request.digest, /^[a-f0-9]{64}$/);
  assert.equal(request.digest, workRequestDigest(request));
  assert.equal(validateWorkRequest(request), request);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.source), true);
  assert.equal(Object.isFrozen(request.acceptanceCriteria), true);
  assert.throws(() => { request.title = 'changed'; }, TypeError);
});

test('supports inline, Markdown, Jira, and Linear source identities', () => {
  for (const source of [
    { kind: 'inline', ref: 'inline' },
    { kind: 'markdown', ref: 'requests/calendar-export.md', revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { kind: 'jira', ref: 'CONF-42', revision: '10012', url: 'https://jira.example.test/browse/CONF-42' },
    { kind: 'linear', ref: 'DEMO-123', revision: '2026-08-31T11:59:00.000Z', url: 'https://linear.app/example/issue/DEMO-123/example' },
  ]) {
    const request = createWorkRequest({ ...BASE, source });
    assert.equal(request.source.kind, source.kind);
    assert.equal(validateWorkRequest(request), request);
  }
});

test('canonicalizes request identity independent of caller object key order', () => {
  const first = createWorkRequest(BASE);
  const second = createWorkRequest({
    capturedAt: BASE.capturedAt,
    contextRefs: [],
    acceptanceCriteria: [...BASE.acceptanceCriteria],
    description: BASE.description,
    title: BASE.title,
    source: { ref: 'inline', kind: 'inline' },
  });

  assert.equal(first.digest, second.digest);
  assert.notEqual(
    first.digest,
    createWorkRequest({ ...BASE, description: `${BASE.description} Updated.` }).digest,
  );
});

test('rejects missing acceptance criteria, extra fields, secrets, and unsafe source metadata', () => {
  assert.throws(() => createWorkRequest({ ...BASE, acceptanceCriteria: [] }), /Work request is invalid/);
  assert.throws(() => createWorkRequest({ ...BASE, extra: true }), /Work request is invalid/);
  assert.throws(() => createWorkRequest({ ...BASE, description: 'authorization: Bearer abcdefghijklmnop' }), /Work request is invalid/);
  assert.throws(() => createWorkRequest({ ...BASE, source: { kind: 'jira', ref: 'CONF-42', url: 'http://127.0.0.1/CONF-42' } }), /Work request is invalid/);
});

test('snapshots hostile getters once and never retains caller arrays', () => {
  let reads = 0;
  const input = {
    ...BASE,
    get title() {
      reads += 1;
      return 'Add calendar export';
    },
    acceptanceCriteria: ['The persisted agenda downloads as .ics.'],
    contextRefs: ['CONFLUENCE:1234'],
  };

  const request = createWorkRequest(input);
  input.acceptanceCriteria[0] = 'changed';
  input.contextRefs.push('JIRA:CONF-99');

  assert.equal(reads, 1);
  assert.deepEqual(request.acceptanceCriteria, ['The persisted agenda downloads as .ics.']);
  assert.deepEqual(request.contextRefs, ['CONFLUENCE:1234']);
});

test('host context is bound to request digest without claiming direct verification', () => {
  const context = { sources: [{ provider: 'jira', providerId: 'team-jira', projectId: 'demo',
    resourceId: 'DEMO-1', url: 'https://jira.example.test/browse/DEMO-1', revision: '1',
    capturedAt: BASE.capturedAt, transport: 'harness-mcp', assurance: 'harness-observed', tool: 'get_issue',
    content: { title: 'Issue', description: 'Description', acceptanceCriteria: ['Works'] },
  }], userAcceptanceCriteria: ['User addition'] };
  const content = context.sources[0].content;
  // Canonical key order matches the observation contract.
  context.sources[0].contentDigest = createHash('sha256').update(JSON.stringify({
    acceptanceCriteria: content.acceptanceCriteria, description: content.description, title: content.title,
  })).digest('hex');
  const source = { kind: 'host-observation', ref: 'team-jira:DEMO-1',
    revision: `sha256:${context.sources[0].contentDigest}`, url: context.sources[0].url };
  const request = createWorkRequest({ ...BASE, source, context });
  assert.equal(validateWorkRequest(request), request);
  assert.equal(request.context.sources[0].assurance, 'harness-observed');
  assert.ok(Object.isFrozen(request.context.sources));
  const changed = { ...request, context: { ...request.context, userAcceptanceCriteria: ['Changed'] } };
  assert.throws(() => validateWorkRequest(changed));
  assert.throws(() => createWorkRequest({ ...BASE, source, context: { ...context,
    sources: [{ ...context.sources[0], assurance: 'provider-verified' }] } }));
  assert.throws(() => createWorkRequest({ ...BASE, source }));
});

test('tracker criteria provenance is schema compatible, union checked and digest bound without changing legacy requests', async () => {
  const {default:Ajv}=await import('ajv');const {readFile}=await import('node:fs/promises');
  const schema=JSON.parse(await readFile(new URL('../../schemas/work-request.schema.json',import.meta.url),'utf8'));
  const validate=new Ajv({strict:false,validateFormats:false}).compile(schema);
  const source={kind:'jira',ref:'DEMO-42',revision:'r1',url:'https://example.atlassian.net/browse/DEMO-42'};
  const provenance={sourceAcceptanceCriteria:['Source'],userAcceptanceCriteria:['User','Source']};
  const request=createWorkRequest({...BASE,source,acceptanceCriteria:['Source','User'],criteriaProvenance:provenance});
  assert.equal(validate(request),true,JSON.stringify(validate.errors));
  assert.equal(validate(createWorkRequest(BASE)),true);
  assert.throws(()=>createWorkRequest({...BASE,criteriaProvenance:provenance}));
  assert.throws(()=>createWorkRequest({...BASE,source,acceptanceCriteria:['User','Source'],criteriaProvenance:provenance}));
  const changed=createWorkRequest({...BASE,source,acceptanceCriteria:['Source','User'],criteriaProvenance:{sourceAcceptanceCriteria:['Source','User'],userAcceptanceCriteria:['User']}});
  assert.notEqual(changed.digest,request.digest);
  const forged=structuredClone(request);forged.criteriaProvenance=changed.criteriaProvenance;assert.throws(()=>validateWorkRequest(forged));
});
