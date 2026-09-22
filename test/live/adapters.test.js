import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createConfluenceAdapter } from '../../src/adapters/confluence.js';
import { createFigmaAdapter } from '../../src/adapters/figma.js';
import { createGithubAdapter } from '../../src/adapters/github.js';
import { createJiraAdapter } from '../../src/adapters/jira.js';

const enabled = process.env.RIVET_LIVE_ADAPTER_TESTS === '1';

test('dedicated provider sandbox smoke tests are explicitly opt-in', { skip: !enabled }, async () => {
  const required = [
    'RIVET_LIVE_JIRA_URL', 'RIVET_LIVE_JIRA_ISSUE', 'RIVET_LIVE_JIRA_AUTHORIZATION',
    'RIVET_LIVE_CONFLUENCE_URL', 'RIVET_LIVE_CONFLUENCE_PAGE', 'RIVET_LIVE_CONFLUENCE_AUTHORIZATION',
    'RIVET_LIVE_FIGMA_FILE',
    'RIVET_LIVE_FIGMA_TOKEN', 'RIVET_LIVE_GITHUB_REPOSITORY', 'RIVET_LIVE_GITHUB_TOKEN',
    'RIVET_LIVE_TRANSPORT_MODULE',
  ];
  for (const name of required) assert.ok(process.env[name], `${name} is required for the dedicated sandbox smoke test`);
  const [owner, repo] = process.env.RIVET_LIVE_GITHUB_REPOSITORY.split('/');
  assert.ok(owner && repo && !repo.includes('/'), 'RIVET_LIVE_GITHUB_REPOSITORY must be owner/repository');
  const transportModule = await import(pathToFileURL(process.env.RIVET_LIVE_TRANSPORT_MODULE).href);
  assert.equal(typeof transportModule.createTransport, 'function', 'live transport module must export createTransport');
  const transport = await transportModule.createTransport();
  const adapters = [
    [createJiraAdapter({
      transport, baseUrl: process.env.RIVET_LIVE_JIRA_URL,
      headers: { authorization: process.env.RIVET_LIVE_JIRA_AUTHORIZATION },
    }), { kind: 'issue', id: process.env.RIVET_LIVE_JIRA_ISSUE }],
    [createConfluenceAdapter({
      transport, baseUrl: process.env.RIVET_LIVE_CONFLUENCE_URL,
      headers: { authorization: process.env.RIVET_LIVE_CONFLUENCE_AUTHORIZATION },
    }), { kind: 'page', id: process.env.RIVET_LIVE_CONFLUENCE_PAGE }],
    [createFigmaAdapter({
      transport, baseUrl: 'https://api.figma.com', headers: { 'x-figma-token': process.env.RIVET_LIVE_FIGMA_TOKEN },
    }), { kind: 'file', id: process.env.RIVET_LIVE_FIGMA_FILE }],
    [createGithubAdapter({
      transport, baseUrl: 'https://api.github.com', headers: { authorization: `Bearer ${process.env.RIVET_LIVE_GITHUB_TOKEN}` },
    }), { kind: 'repo', owner, repo }],
  ];
  for (const [adapter, request] of adapters) {
    const result = await adapter.read(request);
    assert.equal(result.provider, adapter.provider);
    assert.equal(result.fixtureSource, false);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
  }
});
