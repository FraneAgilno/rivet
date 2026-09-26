import * as filesystem from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import YAML from 'yaml';
import {containsSecretMaterial} from '../clients/contract.js';
import {CliError} from '../cli/output.js';

const PROTOCOL_DIRECTORY = 'protocols';
const MAX_PROTOCOL_BYTES = 128 * 1024;
const MAX_QUERY_LENGTH = 256;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const STATUSES = new Set(['draft', 'active', 'retired']);
const METADATA_KEYS = new Set(['schemaVersion', 'id', 'title', 'status', 'revision', 'digest', 'updatedAt']);
const MUTATION_LOCK = '.mutation.lock';

function fail(message, code = 'INVALID_INPUT') {
  throw new CliError(message, code);
}

function safeText(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.normalize('NFKC') !== value || /[\u0000\r]/.test(value) || containsSecretMaterial(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function safeId(value, label = 'Protocol id') {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)
    || WINDOWS_RESERVED.test(value)) fail(`${label} is invalid.`);
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatIfExists(path, fs) {
  return fs.lstatSync(path, { throwIfNoEntry: false });
}

function regularDirectory(path, fs, label) {
  const status = lstatIfExists(path, fs);
  if (!status) return null;
  if (status.isSymbolicLink() || !status.isDirectory()) fail(`${label} must be a regular directory.`, 'REPOSITORY_CONFLICT');
  return status;
}

function readBounded(path, fs, label) {
  const before = lstatIfExists(path, fs);
  if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > MAX_PROTOCOL_BYTES) {
    fail(`${label} must be a bounded regular file.`, 'REPOSITORY_CONFLICT');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened) || opened.size > MAX_PROTOCOL_BYTES) {
      fail(`${label} changed during validation.`, 'REPOSITORY_CONFLICT');
    }
    const bytes = Buffer.alloc(MAX_PROTOCOL_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) {
        fail(`${label} could not be read safely.`, 'REPOSITORY_CONFLICT');
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROTOCOL_BYTES) fail(`${label} exceeds the size limit.`);
    const after = fs.fstatSync(descriptor);
    const current = lstatIfExists(path, fs);
    if (!current || !sameIdentity(after, current) || after.size !== offset) {
      fail(`${label} changed during validation.`, 'REPOSITORY_CONFLICT');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)); } catch { fail(`${label} is not valid UTF-8.`); }
    return text;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function protocolRoot(projectRoot, fs, { create = false } = {}) {
  const root = resolve(projectRoot);
  const project = regularDirectory(root, fs, 'Project root');
  if (!project) fail('Project root does not exist.', 'MISSING_CONFIGURATION');
  const configRoot = join(root, '.rivet');
  const config = regularDirectory(configRoot, fs, 'Project .rivet configuration');
  if (!config) fail('Project configuration is missing.', 'MISSING_CONFIGURATION');
  const protocols = join(configRoot, PROTOCOL_DIRECTORY);
  let status = regularDirectory(protocols, fs, 'Protocol directory');
  if (!status && create) {
    fs.mkdirSync(protocols, { mode: 0o700 });
    status = regularDirectory(protocols, fs, 'Protocol directory');
  }
  return { root, configRoot, protocols, identity: status ? { dev: status.dev, ino: status.ino } : null };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) fail('Protocol updatedAt is invalid.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) fail('Protocol updatedAt is invalid.');
  return value;
}

function canonicalBody(body) {
  return body.replaceAll('\r\n', '\n').trimEnd() + '\n';
}

function bodyDigest(metadata, body) {
  const canonical = JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    id: metadata.id,
    title: metadata.title,
    status: metadata.status,
    revision: metadata.revision,
    updatedAt: metadata.updatedAt,
  }) + '\n' + canonicalBody(body);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function splitDocument(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') fail('Protocol frontmatter is required.');
  const closing = lines.indexOf('---', 1);
  if (closing < 0) fail('Protocol frontmatter is incomplete.');
  let metadata;
  try {
    const document = YAML.parseDocument(lines.slice(1, closing).join('\n'), {
      maxAliasCount: 0, prettyErrors: false, strict: true, uniqueKeys: true, version: '1.2',
    });
    if (document.errors.length || document.warnings.length) fail('Protocol frontmatter is invalid.');
    metadata = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Protocol frontmatter is invalid.');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('Protocol frontmatter is invalid.');
  if (Reflect.ownKeys(metadata).some(key => !METADATA_KEYS.has(key))
    || [...METADATA_KEYS].some(key => !Object.hasOwn(metadata, key))) fail('Protocol frontmatter fields are invalid.');
  const body = lines.slice(closing + 1).join('\n').replace(/^\n/, '');
  return { metadata, body };
}

function validateDocument(source, expectedId = null) {
  safeText(source, MAX_PROTOCOL_BYTES, 'Protocol');
  const { metadata, body } = splitDocument(source);
  if (metadata.schemaVersion !== 1) fail('Protocol schemaVersion is invalid.');
  safeId(metadata.id);
  if (expectedId !== null && metadata.id !== expectedId) fail('Protocol id does not match its filename.');
  safeText(metadata.title, 120, 'Protocol title');
  if (!STATUSES.has(metadata.status)) fail('Protocol status is invalid.');
  if (!Number.isSafeInteger(metadata.revision) || metadata.revision < 1 || metadata.revision > 1_000_000_000) fail('Protocol revision is invalid.');
  parseTimestamp(metadata.updatedAt);
  if (!DIGEST.test(metadata.digest) || metadata.digest !== bodyDigest(metadata, body)) fail('Protocol digest is invalid.', 'REPOSITORY_CONFLICT');
  if (!/^#\s+\S/.test(body.trim())) fail('Protocol body must begin with a Markdown heading.');
  return Object.freeze({ metadata, body, source });
}

function protocolPath(root, id) {
  safeId(id);
  return join(root.protocols, `${id}.md`);
}

function discover(root, fs, includeDrafts = true, includeRetired = true) {
  if (!root.identity) return [];
  const entries = fs.readdirSync(root.protocols, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  return entries.map(entry => {
    if (entry.name === MUTATION_LOCK) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail('Protocol mutation lock is unsafe.', 'REPOSITORY_CONFLICT');
      return null;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) fail('Protocol directory contains an unsupported entry.', 'REPOSITORY_CONFLICT');
    const id = entry.name.slice(0, -3);
    safeId(id);
    const record = validateDocument(readBounded(join(root.protocols, entry.name), fs, `Protocol '${id}'`), id);
    return (record.metadata.status === 'draft' && !includeDrafts) || (record.metadata.status === 'retired' && !includeRetired) ? null : record;
  }).filter(Boolean);
}

function publicProtocol(record, includeBody = false) {
  return {
    id: record.metadata.id,
    title: record.metadata.title,
    status: record.metadata.status,
    revision: record.metadata.revision,
    digest: record.metadata.digest,
    updatedAt: record.metadata.updatedAt,
    completeness: protocolCompleteness(record.body),
    ...(includeBody ? { body: record.body } : {}),
  };
}


export { MAX_PROTOCOL_BYTES, PROTOCOL_DIRECTORY, MUTATION_LOCK, DIGEST, safeText, safeId, sameIdentity, lstatIfExists, readBounded, protocolRoot, canonicalBody, bodyDigest, validateDocument, protocolPath, discover, publicProtocol };

const REQUIRED_SECTIONS = Object.freeze([
  ['Owner', 256], ['Purpose', 4096], ['Applies when', 8192],
  ['Procedure', 65536], ['Required checks and evidence', 16384],
]);

/** Structural completeness only; content remains project-authored policy. */
export function protocolCompleteness(body) {
  const sections = new Map(REQUIRED_SECTIONS.map(([name]) => [name, []]));
  let current = null, fence = null, comment = false;
  for (const rawLine of body.split('\n')) {
    let line = rawLine;
    if (!fence) {
      let visible = '', offset = 0;
      while (offset < line.length) {
        if (comment) {
          const end = line.indexOf('-->', offset);
          if (end < 0) { offset = line.length; break; }
          comment = false; offset = end + 3;
        } else {
          const start = line.indexOf('<!--', offset);
          if (start < 0) { visible += line.slice(offset); break; }
          visible += line.slice(offset, start); comment = true; offset = start + 4;
        }
      }
      line = visible;
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (current) current.push(line);
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length
        && new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$').test(line)) fence = null;
      continue;
    }
    if (delimiter) { fence = delimiter[1]; if (current) current.push(line); continue; }
    const heading = /^ {0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = null;
      if (/^ {0,3}##\s/.test(line) && sections.has(heading[1])) {
        current = []; sections.get(heading[1]).push(current);
      }
    } else if (current) current.push(line);
  }
  const missing = [], invalid = [];
  for (const [name, limit] of REQUIRED_SECTIONS) {
    const entries = sections.get(name);
    if (entries.length > 1) { invalid.push(name); continue; }
    const content = (entries[0] ?? []).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    const meaningful = content.replace(/[`*_#>\-\s.:[\]()]/g, '');
    if (!meaningful || /^(?:TODO|TBD|PLACEHOLDER)(?:\s*[:.-]\s*.*)?$/i.test(content) || /^(?:todo|tbd|placeholder|fill(?:this)?in|your(?:text|name|team|procedure|checks)(?:here)?)$/i.test(meaningful)) missing.push(name);
    else if (Buffer.byteLength(content) > limit) invalid.push(name);
  }
  return Object.freeze({ready: missing.length === 0 && invalid.length === 0, missing: Object.freeze(missing), invalid: Object.freeze(invalid)});
}

export function requireProtocolCompleteness(body) {
  const result = protocolCompleteness(body);
  if (!result.ready) fail(`Protocol is not ready to publish. Complete non-placeholder Markdown sections: ${[...result.missing, ...result.invalid].join(', ')}. Use one heading per section, edit a project-contained source file, then run protocols update <id> --from=<file> --expected-revision=<current revision> --publish. Do not invent team policy.`);
  return result;
}

const PROTOCOL_REF = /^protocol:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([1-9][0-9]*):(sha256:[a-f0-9]{64})$/;
export function assertSelectedProtocolRefs(projectRoot, contextRefs, options = {}) {
  const fs = options.fs ?? filesystem;
  try {
    if (typeof projectRoot !== 'string' || !Array.isArray(contextRefs) || contextRefs.length > 256) throw new Error();
    if (contextRefs.some(ref => typeof ref !== 'string')) throw new Error();
    const refs = contextRefs.filter(ref => ref.startsWith('protocol:')).sort();
    if (refs.length === 0) return Object.freeze({sourceRoot: resolve(projectRoot), refs: Object.freeze([])});
    const sourceRoot = fs.realpathSync(resolve(projectRoot));
    const ids = new Set();
    for (const ref of refs) {
      const match = PROTOCOL_REF.exec(ref);
      if (!match || match[1].length > 64 || ids.has(match[1])) throw new Error();
      ids.add(match[1]);
      const root = protocolRoot(sourceRoot, fs);
      const record = validateDocument(readBounded(protocolPath(root, match[1]), fs, 'Selected protocol'), match[1]);
      if (record.metadata.status !== 'active' || String(record.metadata.revision) !== match[2] || record.metadata.digest !== match[3]) throw new Error();
    }
    return Object.freeze({sourceRoot, refs: Object.freeze(refs)});
  } catch {
    fail('Selected project protocols changed or are unavailable. Create a new reviewed proposal; existing run references were preserved.', 'REPOSITORY_CONFLICT');
  }
}

export function selectedProtocolStatus(projectRoot, contextRefs, options = {}) {
  try { return Object.freeze({status: 'current', ...assertSelectedProtocolRefs(projectRoot, contextRefs, options)}); }
  catch { return Object.freeze({status: 'changed', message: 'Selected project protocols changed or are unavailable. Create a new reviewed proposal; existing run references were preserved.'}); }
}
