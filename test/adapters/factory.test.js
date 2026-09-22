import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrackerProviderFactory, TrackerProviderFactoryError } from '../../src/adapters/factory.js';
import { createTrustedProviderTransport } from '../../src/adapters/http.js';

const NOW = '2029-01-01T00:00:00.000Z';

function provider(overrides = {}) {
  return {
    id: 'jira-main', kind: 'jira', mode: 'read-only', capabilities: ['issues-read'],
    endpoint: 'https://jira.example.test',
    credentials: { usernameEnv: 'JIRA_USERNAME', apiTokenEnv: 'JIRA_API_TOKEN' },
    ...overrides,
  };
}

function config(providers) { return { providers: { schemaVersion: 1, providers } }; }

function transport(fetchPinned = async () => new Response('{}')) {
  return createTrustedProviderTransport({ resolve: async () => ['93.184.216.34'], fetchPinned });
}

test('constructs one read-only Jira adapter from endpoint and named environment credentials', async () => {
  const requests = [];
  const factory = createTrackerProviderFactory({
    config: config([provider()]),
    environment: { JIRA_USERNAME: 'developer@example.test', JIRA_API_TOKEN: 'private-jira-token' },
    transport: transport(async (url, init) => {
      requests.push({ url, init });
      if (new URL(url).pathname.endsWith('/comment')) {
        return new Response(JSON.stringify({ comments: [], startAt: 0, maxResults: 100, total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: '42', key: 'DEMO-42', names: {}, fields: {
          summary: 'Feature', description: 'AC: works', issuetype: { name: 'Story' },
          status: { id: '1', name: 'Open' }, issuelinks: [], updated: NOW,
        },
      }), { status: 200 });
    }),
    clock: () => NOW,
  });

  assert.deepEqual(factory.credentialStatus(), [
    { provider: 'jira-main', name: 'JIRA_API_TOKEN', present: true, required: true },
    { provider: 'jira-main', name: 'JIRA_USERNAME', present: true, required: true },
  ]);
  const adapter = factory.create({ tracker: 'jira' });
  assert.equal(adapter.provider, 'jira');
  assert.deepEqual(adapter.capabilities.write, ['comment', 'status']);
  await adapter.read({ kind: 'issue', id: 'DEMO-42' });
  assert.match(requests[0].init.headers.authorization, /^Basic /);
  assert.doesNotMatch(JSON.stringify(factory.credentialStatus()), /private-jira-token|developer@example/);
  assert.throws(
    () => adapter.write({ action: 'comment', resourceId: 'DEMO-42' }),
    error => error?.code === 'ERR_PROVIDER_APPROVAL_REQUIRED',
  );
});

test('constructs Linear with API token authentication and no write authority', async () => {
  let authorization;
  const factory = createTrackerProviderFactory({
    config: config([provider({
      id: 'linear-main', kind: 'linear', endpoint: 'https://api.linear.app',
      credentials: { apiTokenEnv: 'LINEAR_API_TOKEN' },
    })]),
    environment: { LINEAR_API_TOKEN: 'private-linear-token' },
    transport: transport(async (_url, init) => {
      authorization = init.headers.authorization;
      return new Response(JSON.stringify({ data: { issue: {
        id: 'remote-1', identifier: 'ENG-7', title: 'Feature', description: 'AC: works', updatedAt: NOW,
        url: 'https://linear.app/example/issue/ENG-7', state: { id: 'state-1', name: 'Open' },
        team: { id: 'team-1', key: 'ENG' },
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } }), { status: 200 });
    }),
    clock: () => NOW,
  });

  const adapter = factory.create();
  assert.equal(adapter.provider, 'linear');
  await adapter.read({ kind: 'issue', id: 'ENG-7' });
  assert.equal(authorization, 'private-linear-token');
  await assert.rejects(adapter.write({}), error => error?.code === 'ERR_PROVIDER_READ_ONLY');
});

test('fails closed for ambiguous providers disabled providers and missing credentials', () => {
  const jira = provider();
  const linear = provider({
    id: 'linear-main', kind: 'linear', endpoint: 'https://api.linear.app',
    credentials: { apiTokenEnv: 'LINEAR_API_TOKEN' },
  });
  assert.throws(() => createTrackerProviderFactory({
    config: config([jira, linear]),
    environment: { JIRA_USERNAME: 'user', JIRA_API_TOKEN: 'token', LINEAR_API_TOKEN: 'token' },
    transport: transport(),
  }).create(), TrackerProviderFactoryError);

  const inferred = createTrackerProviderFactory({
    config: config([{ ...jira, mode: 'disabled' }, linear]),
    environment: { LINEAR_API_TOKEN: 'token' }, transport: transport(),
  }).create();
  assert.equal(inferred.provider, 'linear');

  assert.throws(() => createTrackerProviderFactory({
    config: config([jira]), environment: { JIRA_USERNAME: 'user' }, transport: transport(),
  }).create({ tracker: 'jira' }), TrackerProviderFactoryError);
});

test('rejects non-tracker kinds missing endpoints and providers without read capability', () => {
  for (const candidate of [
    provider({ kind: 'github' }),
    provider({ endpoint: undefined }),
    provider({ capabilities: ['issues-write'] }),
  ]) {
    assert.throws(() => createTrackerProviderFactory({
      config: config([candidate]),
      environment: { JIRA_USERNAME: 'user', JIRA_API_TOKEN: 'token' },
      transport: transport(),
    }).create(), TrackerProviderFactoryError);
  }
});
