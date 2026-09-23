import { createIntegrationRegistry } from '../integrations/registry.js';
import { normalizeHostObservation } from '../integrations/host-observation.js';
import { fields, snapshot } from '../integrations/capabilities.js';
import { createWorkRequest, WorkRequestError } from './contract.js';

const CAPABILITIES = { jira: 'issues-read', linear: 'issues-read', figma: 'files-read', confluence: 'pages-read', generic: 'context-read' };
const TICKET = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
function fail() { throw new WorkRequestError(); }

function requestId(value, provider) {
  if (typeof value !== 'string') fail();
  if (!value.startsWith('https://')) return value;
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (!provider.endpoint || url.origin !== new URL(provider.endpoint).origin || url.username || url.password || url.search || url.hash) fail();
  const expression = provider.kind === 'jira' ? /^\/browse\/([A-Z][A-Z0-9]*-[1-9][0-9]*)\/?$/
    : provider.kind === 'linear' ? /^\/[^/]+\/issue\/([A-Z][A-Z0-9]*-[1-9][0-9]*)(?:\/[^/]+)?\/?$/ : null;
  const match = expression?.exec(url.pathname);
  if (!match) fail();
  return match[1];
}

export function resolveHostWorkRequest({ config, bundle: raw, capturedAt }) {
  const bundle = snapshot(raw);
  fields(bundle, ['schemaVersion', 'projectId', 'host', 'request', 'observations', 'userAcceptanceCriteria'],
    ['schemaVersion', 'projectId', 'host', 'request', 'observations']);
  if (bundle.schemaVersion !== 1 || bundle.projectId !== config.project.id
    || !Array.isArray(bundle.observations) || bundle.observations.length < 1 || bundle.observations.length > 16) fail();
  fields(bundle.request, ['providerId', 'resourceId']);
  const registry = createIntegrationRegistry({ config, projectId: config.project.id, host: bundle.host });
  const primaryProvider = registry.list().find(p => p.id === bundle.request.providerId);
  if (!primaryProvider || !['jira', 'linear'].includes(primaryProvider.kind)) fail();
  const primaryId = requestId(bundle.request.resourceId, primaryProvider);
  if (!TICKET.test(primaryId)) fail();
  const sources = bundle.observations.map(observation => {
    const descriptor = registry.list().find(p => p.id === observation.providerId);
    if (!descriptor || !CAPABILITIES[descriptor.kind]) fail();
    const provider = registry.resolve({ providerId: descriptor.id, capability: CAPABILITIES[descriptor.kind], tool: observation.tool });
    const normalized = normalizeHostObservation(observation, { provider, projectId: config.project.id });
    const { schemaVersion, sourceUrl, ...source } = normalized;
    if (!source.content || typeof source.content !== 'object' || Array.isArray(source.content)) fail();
    const url = new URL(sourceUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (source.provider === 'jira' && (segments.length !== 2 || segments[0] !== 'browse' || segments[1] !== source.resourceId)) fail();
    if (source.provider === 'linear' && (segments[1] !== 'issue' || segments[2] !== source.resourceId)) fail();
    if (source.provider === 'figma' && (!['file', 'design', 'board', 'proto'].includes(segments[0]) || segments[1] !== source.resourceId)) fail();
    if (source.provider === 'confluence' && !(url.searchParams.get('pageId') === source.resourceId
      || segments.some((part, index) => part === 'pages' && segments[index + 1] === source.resourceId))) fail();
    if (['jira', 'linear'].includes(source.provider)) {
      fields(source.content, ['title', 'description', 'acceptanceCriteria']);
      if (!Array.isArray(source.content.acceptanceCriteria) || !TICKET.test(source.resourceId)) fail();
    } else {
      fields(source.content, ['title', 'text']);
      if (typeof source.content.title !== 'string' || !source.content.title || typeof source.content.text !== 'string' || !source.content.text) fail();
    }
    return { ...source, url: sourceUrl };
  });
  const selected = sources.filter(s => s.providerId === bundle.request.providerId && s.resourceId === primaryId);
  if (selected.length !== 1) fail();
  const primary = selected[0];
  const additions = bundle.userAcceptanceCriteria ?? [];
  if (!Array.isArray(additions)) fail();
  const acceptanceCriteria = [...new Set([...primary.content.acceptanceCriteria, ...additions])];
  if (!acceptanceCriteria.length) {
    const error = new WorkRequestError();
    error.safeMessage = 'The source has no acceptance criteria. Ask the user and supply explicit userAcceptanceCriteria before proposing work.';
    throw error;
  }
  return createWorkRequest({
    source: { kind: 'host-observation', ref: `${primary.providerId}:${primary.resourceId}`, revision: `sha256:${primary.contentDigest}`, url: primary.url },
    title: primary.content.title,
    description: primary.content.description,
    acceptanceCriteria,
    contextRefs: sources.map(s => `${s.providerId}:${s.resourceId}:sha256:${s.contentDigest}`),
    capturedAt,
    context: { sources: [primary, ...sources.filter(s => s !== primary)], userAcceptanceCriteria: additions },
  });
}
