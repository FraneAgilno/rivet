import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  boundedString,
  captureRecord,
  createAdapter,
  createSourceEnvelope,
  failProvider,
  readOnlyWrite,
} from './contract.js';
import { normalizeConfluence } from './confluence.js';
import { normalizeFigma } from './figma.js';
import { normalizeJira } from './jira.js';

const DEFINITIONS = Object.freeze({
  jira: Object.freeze({ file: 'jira.json', read: Object.freeze(['epic', 'issue']), normalize: normalizeJira }),
  confluence: Object.freeze({ file: 'confluence.json', read: Object.freeze(['page']), normalize: normalizeConfluence }),
  figma: Object.freeze({ file: 'figma.json', read: Object.freeze(['file', 'nodes']), normalize: raw => normalizeFigma(raw, Object.fromEntries(
    (raw?.renderedReferences ?? []).map(item => [item.nodeId, item.url]),
  )) }),
  github: Object.freeze({
    file: 'github.json', read: Object.freeze(['repo', 'branch', 'pull', 'checks', 'reviews', 'artifacts', 'delivery']),
    normalize: raw => raw,
  }),
});
const trustedPacketSources = new WeakMap();

function descriptorRoot(handle) {
  if (process.platform !== 'linux') failProvider('invalid-config');
  return `/proc/self/fd/${handle.fd}`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function trustedHandle(value, provider) {
  let stat;
  let read;
  try { ({ stat, read } = value); } catch { failProvider('invalid-config', { provider }); }
  if (typeof stat !== 'function' || typeof read !== 'function') failProvider('invalid-config', { provider });
  return Object.freeze({
    stat: options => Reflect.apply(stat, value, [options]),
    read: (...args) => Reflect.apply(read, value, args),
  });
}

export function createTrustedFixturePacketSource(input) {
  const value = captureRecord(input, new Set(['packets']), ['packets'], 'invalid-config');
  const providers = Object.keys(DEFINITIONS);
  const packets = captureRecord(value.packets, new Set(providers), providers, 'invalid-config');
  const handles = {};
  for (const provider of providers) handles[provider] = trustedHandle(packets[provider], provider);
  const source = Object.freeze({ kind: 'trusted-preopened-provider-fixtures' });
  trustedPacketSources.set(source, Object.freeze(handles));
  return source;
}

async function readPacket(handle, provider, validateAnchor = async () => {}) {
  let text;
  let identity;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 2n || before.size > BigInt(2 * 1024 * 1024)) failProvider('invalid-config', { provider });
    const size = Number(before.size);
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await validateAnchor();
    if (offset !== size || !sameIdentity(before, after)) {
      failProvider('invalid-config', { provider });
    }
    identity = `${before.dev}:${before.ino}`;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { failProvider('invalid-config', { provider }); }
  } catch { failProvider('invalid-config', { provider }); }
  let packet;
  try { packet = JSON.parse(text); } catch { failProvider('invalid-config', { provider }); }
  const value = captureRecord(packet, new Set(['sourceId', 'sourceUrl', 'fetchedAt', 'raw']), ['sourceId', 'sourceUrl', 'fetchedAt', 'raw'], 'invalid-config');
  return Object.freeze({ identity, packet: Object.freeze({
    sourceId: boundedString(value.sourceId, 256), sourceUrl: boundedString(value.sourceUrl, 2048),
    fetchedAt: boundedString(value.fetchedAt, 32), raw: value.raw,
  }) });
}

async function loadPacket(rootHandle, rootIdentity, root, definition, provider) {
  const path = join(descriptorRoot(rootHandle), definition.file);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) failProvider('invalid-config', { provider });
  let fileHandle;
  try { fileHandle = await open(path, constants.O_RDONLY | noFollow); }
  catch { failProvider('invalid-config', { provider }); }
  try {
    return await readPacket(trustedHandle(fileHandle, provider), provider, async () => {
      const rootAfter = await rootHandle.stat({ bigint: true });
      const rootPathAfter = await lstat(root, { bigint: true }).catch(() => null);
      if (rootAfter.dev !== rootIdentity.dev || rootAfter.ino !== rootIdentity.ino
        || !rootPathAfter || rootPathAfter.dev !== rootIdentity.dev || rootPathAfter.ino !== rootIdentity.ino) {
        failProvider('invalid-config', { provider });
      }
    });
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

async function loadPreopenedPackets(source) {
  const handles = trustedPacketSources.get(source);
  if (!handles) failProvider('invalid-config');
  const packets = {};
  const identities = new Set();
  for (const [provider, definition] of Object.entries(DEFINITIONS)) {
    const result = await readPacket(handles[provider], provider);
    if (identities.has(result.identity)) failProvider('invalid-config', { provider });
    identities.add(result.identity);
    packets[provider] = result.packet;
  }
  return packets;
}

async function loadRootPackets(rootInput) {
  if (process.platform !== 'linux') failProvider('invalid-config');
  const root = await realpath(rootInput).catch(() => null);
  if (!root || root !== rootInput) failProvider('invalid-config');
  const pathIdentity = await lstat(root, { bigint: true }).catch(() => null);
  if (!pathIdentity?.isDirectory() || pathIdentity.isSymbolicLink()) failProvider('invalid-config');
  const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  let rootHandle;
  try { rootHandle = await open(root, directoryFlags); } catch { failProvider('invalid-config'); }
  const packets = {};
  const identities = new Set();
  try {
    const identity = await rootHandle.stat({ bigint: true });
    if (!identity.isDirectory() || identity.dev !== pathIdentity.dev || identity.ino !== pathIdentity.ino) failProvider('invalid-config');
    for (const [provider, definition] of Object.entries(DEFINITIONS)) {
      const result = await loadPacket(rootHandle, identity, root, definition, provider);
      if (identities.has(result.identity)) failProvider('invalid-config', { provider });
      identities.add(result.identity);
      packets[provider] = result.packet;
    }
  } finally { await rootHandle.close().catch(() => {}); }
  return packets;
}

export async function createFixtureAdapters(input) {
  const config = captureRecord(input, new Set(['root', 'source']), [], 'invalid-config');
  if ((config.root === undefined) === (config.source === undefined)) failProvider('invalid-config');
  let packets;
  if (config.source !== undefined) packets = await loadPreopenedPackets(config.source);
  else {
    const rootInput = boundedString(config.root, 2048, undefined, 'invalid-config');
    if (!isAbsolute(rootInput) || resolve(rootInput) !== rootInput) failProvider('invalid-config');
    packets = await loadRootPackets(rootInput);
  }
  const output = {};
  for (const [provider, definition] of Object.entries(DEFINITIONS)) {
    const packet = packets[provider];
    const read = async inputRead => {
      const request = captureRecord(inputRead, new Set(['kind']), ['kind']);
      const kind = boundedString(request.kind, 32, /^[a-z][a-z0-9-]*$/);
      if (!definition.read.includes(kind)) failProvider('invalid-request', { provider });
      return createSourceEnvelope({
        provider, sourceId: packet.sourceId, sourceUrl: packet.sourceUrl, fetchedAt: packet.fetchedAt,
        fixtureSource: true, raw: packet.raw,
        normalized: { ...definition.normalize(packet.raw), fixture: Object.freeze({ sourced: true, packet: definition.file }) },
        retryClassification: 'none', capabilities: { read: definition.read, write: [] },
      });
    };
    output[provider] = createAdapter({
      provider, fixtureSource: true, capabilities: { read: definition.read, write: [] }, read,
      write: readOnlyWrite(provider),
    });
  }
  return Object.freeze(output);
}
