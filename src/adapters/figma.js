import {
  boundedArray,
  boundedString,
  captureRecord,
  createAdapter,
  createSourceEnvelope,
  failProvider,
  immutableRedactedJson,
  providerTimestamp,
  readOnlyWrite,
  sanitizeReferenceUrl,
  snapshotProviderJson,
} from './contract.js';
import { createProviderHttpClient } from './http.js';

const READ = Object.freeze(['file', 'nodes']);
const WRITE = Object.freeze([]);

function remoteFailure() { failProvider('remote', { provider: 'figma', retryClassification: 'permanent' }); }

function validateNamedMap(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) remoteFailure();
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') remoteFailure();
    if ((kind === 'component' || kind === 'style') && typeof entry.key !== 'string') remoteFailure();
    if (kind === 'variable' && (!entry.valuesByMode || typeof entry.valuesByMode !== 'object' || Array.isArray(entry.valuesByMode))) remoteFailure();
  }
  return value;
}

function validateDocument(root) {
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    count += 1;
    if (count > 10_000 || !node || typeof node !== 'object' || Array.isArray(node)
      || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.type !== 'string'
      || (node.children !== undefined && !Array.isArray(node.children))) remoteFailure();
    if (node.children) pending.push(...node.children);
  }
}

function validateFile(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string'
      || typeof value.version !== 'string' || !value.document || typeof value.document !== 'object'
      || Array.isArray(value.document)) throw new Error();
    validateDocument(value.document);
    validateNamedMap(value.components === undefined ? {} : value.components, 'component');
    validateNamedMap(value.styles === undefined ? {} : value.styles, 'style');
    if (value.variables !== undefined) validateNamedMap(value.variables, 'variable');
    return value;
  } catch { remoteFailure(); }
}

function validateNodes(value, requestedIds) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) throw new Error();
    const returned = Object.keys(value.nodes).sort();
    const requested = [...requestedIds].sort();
    if (returned.length !== requested.length || returned.some((id, index) => id !== requested[index])) throw new Error();
    for (const id of returned) {
      const item = value.nodes[id];
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !item.document || typeof item.document !== 'object' || Array.isArray(item.document)
        || item.document.id !== id || typeof item.document.name !== 'string' || typeof item.document.type !== 'string') throw new Error();
      validateDocument(item.document);
    }
    return value;
  } catch { remoteFailure(); }
}

function flattenNodes(root) {
  const output = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    visited += 1;
    if (visited > 10_000) failProvider('invalid-request', { provider: 'figma' });
    if (typeof node.id === 'string' && node.type !== 'DOCUMENT') {
      output.push({ id: node.id, name: String(node.name ?? ''), type: String(node.type ?? '') });
    }
    if (Array.isArray(node.children)) for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]);
  }
  return output;
}

export function normalizeFigma(file, rendered = {}, variables) {
  const source = snapshotProviderJson(file);
  const renderedSource = snapshotProviderJson(rendered);
  const variableSource = variables === undefined ? (source?.variables ?? {}) : snapshotProviderJson(variables);
  return immutableRedactedJson({
    metadata: {
      name: String(source?.name ?? ''), version: String(source?.version ?? ''),
      lastModified: String(source?.lastModified ?? ''),
    },
    nodes: flattenNodes(source?.document), components: source?.components ?? {}, styles: source?.styles ?? {},
    variables: variableSource,
    renderedReferences: Object.entries(renderedSource).map(([nodeId, url]) => ({
      nodeId, url: sanitizeReferenceUrl(url),
    })),
  });
}

export function createFigmaAdapter(input) {
  const config = captureRecord(input, new Set([
    'transport', 'baseUrl', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'clock',
  ]), ['transport', 'baseUrl'], 'invalid-config');
  const now = config.clock ?? (() => new Date().toISOString());
  if (typeof now !== 'function') failProvider('invalid-config', { provider: 'figma' });
  const http = createProviderHttpClient({
    provider: 'figma', baseUrl: config.baseUrl, transport: config.transport,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
  });

  async function read(inputRead) {
    const request = captureRecord(inputRead, new Set(['kind', 'id', 'nodeIds', 'render', 'includeVariables', 'signal']), ['kind', 'id']);
    const kind = boundedString(request.kind, 16, /^(?:file|nodes)$/);
    const id = boundedString(request.id, 128, /^[A-Za-z0-9_-]+$/);
    const nodeIds = request.nodeIds === undefined ? Object.freeze([]) : boundedArray(
      request.nodeIds, 100, child => boundedString(child, 128, /^[A-Za-z0-9:;._-]+$/),
    );
    if (new Set(nodeIds).size !== nodeIds.length || (kind === 'nodes' && nodeIds.length === 0)) failProvider('invalid-request', { provider: 'figma' });
    if (request.render !== undefined && typeof request.render !== 'boolean') failProvider('invalid-request', { provider: 'figma' });
    if (request.includeVariables !== undefined && typeof request.includeVariables !== 'boolean') failProvider('invalid-request', { provider: 'figma' });
    const signal = request.signal === undefined ? {} : { signal: request.signal };
    const path = kind === 'nodes'
      ? `/v1/files/${encodeURIComponent(id)}/nodes?ids=${encodeURIComponent(nodeIds.join(','))}`
      : `/v1/files/${encodeURIComponent(id)}`;
    const fileResponse = await http.request({ method: 'GET', path, ...signal });
    if (kind === 'file') validateFile(fileResponse.data);
    else validateNodes(fileResponse.data, nodeIds);
    const file = kind === 'nodes'
      ? { ...fileResponse.data, document: { id: 'selected', name: 'Selected nodes', type: 'DOCUMENT', children: Object.values(fileResponse.data?.nodes ?? {}).map(item => item?.document).filter(Boolean) } }
      : fileResponse.data;
    let rendered = {};
    if (request.render === true && nodeIds.length > 0) {
      const imageResponse = await http.request({
        method: 'GET', path: `/v1/images/${encodeURIComponent(id)}?ids=${encodeURIComponent(nodeIds.join(','))}`, ...signal,
      });
      rendered = imageResponse.data?.images;
      if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)
        || Object.values(rendered).some(value => typeof value !== 'string')) failProvider('remote', { provider: 'figma' });
      try { for (const value of Object.values(rendered)) sanitizeReferenceUrl(value); }
      catch { failProvider('remote', { provider: 'figma', retryClassification: 'permanent' }); }
      const imageIds = Object.keys(rendered).sort();
      const requestedImageIds = [...nodeIds].sort();
      if (imageIds.length !== requestedImageIds.length
        || imageIds.some((nodeId, index) => nodeId !== requestedImageIds[index])) remoteFailure();
    }
    let variables = file?.variables ?? {};
    if (request.includeVariables === true) {
      const variableResponse = await http.request({
        method: 'GET', path: `/v1/files/${encodeURIComponent(id)}/variables/local`, ...signal,
      });
      variables = variableResponse.data?.meta?.variables;
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) failProvider('remote', { provider: 'figma' });
      validateNamedMap(variables, 'variable');
    }
    return createSourceEnvelope({
      provider: 'figma', sourceId: id, sourceUrl: `https://www.figma.com/file/${encodeURIComponent(id)}`,
      fetchedAt: providerTimestamp(now, 'figma'), fixtureSource: false, raw: { file, rendered, variables }, normalized: normalizeFigma(file, rendered, variables),
      retryClassification: 'none', capabilities: { read: READ, write: WRITE },
    });
  }

  return createAdapter({
    provider: 'figma', fixtureSource: false, capabilities: { read: READ, write: WRITE },
    read, write: readOnlyWrite('figma'),
  });
}
