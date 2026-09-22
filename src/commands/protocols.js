import * as filesystem from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';

import { containsSecretMaterial } from '../clients/contract.js';
import { loadProjectConfig } from '../config/load.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

const PROTOCOL_DIRECTORY = 'protocols';
const MAX_PROTOCOL_BYTES = 128 * 1024;
const MAX_QUERY_LENGTH = 256;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const STATUSES = new Set(['draft', 'active']);
const METADATA_KEYS = new Set(['schemaVersion', 'id', 'title', 'status', 'revision', 'digest', 'updatedAt']);
const SUBCOMMANDS = new Set(['add', 'import', 'validate', 'find', 'show', 'update']);
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

function discover(root, fs, includeDrafts = true) {
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
    return record.metadata.status === 'draft' && !includeDrafts ? null : record;
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
    ...(includeBody ? { body: record.body } : {}),
  };
}

function now() {
  return new Date().toISOString();
}

function render(metadata, body) {
  const frontmatter = YAML.stringify(metadata, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${canonicalBody(body)}`;
}

function atomicWrite(path, source, fs, expectedParent, expectedDigest = null) {
  const parent = resolve(path, '..');
  const temporary = join(parent, `.rivet-protocol-${randomUUID()}.tmp`);
  const lockPath = join(parent, MUTATION_LOCK);
  let descriptor;
  let lock;
  try {
    lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const currentParent = lstatIfExists(parent, fs);
    if (!currentParent || currentParent.isSymbolicLink() || !currentParent.isDirectory() || !sameIdentity(expectedParent, currentParent)) {
      fail('Protocol directory changed during validation.', 'REPOSITORY_CONFLICT');
    }
    const current = lstatIfExists(path, fs);
    if (expectedDigest === null) {
      if (current) fail('Protocol already exists.', 'REPOSITORY_CONFLICT');
    } else {
      const id = path.slice(parent.length + 1, -3);
      const observed = validateDocument(readBounded(path, fs, `Protocol '${id}'`), id);
      if (observed.metadata.digest !== expectedDigest) fail('Protocol revision conflict.', 'REPOSITORY_CONFLICT');
    }
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(descriptor, source, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const finalParent = lstatIfExists(parent, fs);
    if (!finalParent || finalParent.isSymbolicLink() || !finalParent.isDirectory() || !sameIdentity(expectedParent, finalParent)) {
      fail('Protocol directory changed during validation.', 'REPOSITORY_CONFLICT');
    }
    fs.renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    if (error instanceof CliError) throw error;
    fail('Protocol write could not be completed safely.', 'REPOSITORY_CONFLICT');
  } finally {
    if (lock !== undefined) {
      try { fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

function sourcePath(root, input, fs) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 512 || input.includes('\0')) fail("Option '--from' is invalid.");
  const normalized = input.replaceAll('\\', '/');
  const absolute = resolve(root.root, normalized);
  const within = relative(root.root, absolute);
  if (isAbsolute(normalized) || !within || within === '..' || within.startsWith(`..${sep}`)) fail("Option '--from' must stay within the project.");
  let current = root.root;
  for (const part of within.split(sep).slice(0, -1)) {
    current = join(current, part);
    const status = lstatIfExists(current, fs);
    if (!status || status.isSymbolicLink() || !status.isDirectory()) fail('Protocol import source has an unsafe ancestor.', 'REPOSITORY_CONFLICT');
  }
  return absolute;
}

function requireFlags(parsed) {
  if (!parsed || parsed.command !== 'protocols' || !SUBCOMMANDS.has(parsed.subcommand)
    || !Array.isArray(parsed.operands) || !parsed.flags || typeof parsed.flags !== 'object') fail('Invalid protocols command.');
  const allowed = new Set(['project', 'json', 'from', 'include-drafts', 'publish', 'expected-revision']);
  if (Object.keys(parsed.flags).some(key => !allowed.has(key))) fail('Invalid protocols command options.');
  if (parsed.flags.project !== undefined && (typeof parsed.flags.project !== 'string' || parsed.flags.project.length === 0)) fail("Option '--project' is invalid.");
  return parsed;
}

function emit(dependencies, parsed, result, code = EXIT_CODES.SUCCESS) {
  const json = parsed?.flags?.json === true;
  if (json && code !== EXIT_CODES.SUCCESS) {
    dependencies.output.json({ ok: false, error: result.error ?? { code: 'INTERNAL_ERROR', exitCode: code, message: 'Protocol operation failed.' } }, 'stderr');
  } else if (json) {
    dependencies.output.json({ ok: true, command: 'protocols', result }, 'stdout');
  }
  else if (code === EXIT_CODES.SUCCESS) dependencies.output.log(JSON.stringify(result, null, 2));
  else dependencies.output.error(`ERROR: ${result.message ?? 'Protocol operation failed.'}`);
  return code;
}

function errorResult(error) {
  return {
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      exitCode: error.exitCode ?? EXIT_CODES.INTERNAL_ERROR,
      message: error.safeMessage ?? error.message ?? 'Protocol operation failed.',
    },
  };
}

export async function protocolsCommand(input, dependencies = {}) {
  let parsed;
  try {
    parsed = requireFlags(input);
    const fs = dependencies.fs ?? filesystem;
    const projectRoot = resolve(parsed.flags.project ?? dependencies.cwd?.() ?? process.cwd());
    await (dependencies.configLoader ?? loadProjectConfig)(projectRoot, { fs });
    const root = protocolRoot(projectRoot, fs, { create: ['add', 'import', 'update'].includes(parsed.subcommand) });
    const operands = parsed.operands;
    if (parsed.subcommand === 'add' && (operands.length !== 1 || parsed.flags.from !== undefined)) fail('Use rivet protocols add <slug>.');
    if (parsed.subcommand === 'import' && (operands.length !== 1 || typeof parsed.flags.from !== 'string')) fail('Use rivet protocols import <slug> --from=<path>.');
    if (parsed.subcommand === 'validate' && operands.length > 1) fail('Use rivet protocols validate [<slug>].');
    if (parsed.subcommand === 'find' && (operands.length !== 1 || typeof operands[0] !== 'string' || operands[0].length < 1 || operands[0].length > MAX_QUERY_LENGTH)) fail('Use rivet protocols find <query>.');
    if (parsed.subcommand === 'show' && operands.length !== 1) fail('Use rivet protocols show <slug>.');
    if (parsed.subcommand === 'update' && (operands.length !== 1 || typeof parsed.flags.from !== 'string' || parsed.flags.publish && parsed.flags['include-drafts'])) fail('Use rivet protocols update <slug> --from=<path> [--publish].');
    if (parsed.subcommand === 'update' && (!/^\d+$/.test(String(parsed.flags['expected-revision'] ?? '')) || Number(parsed.flags['expected-revision']) < 1)) fail("Option '--expected-revision' is required for update.");

    if (parsed.subcommand === 'add') {
      const id = safeId(operands[0]);
      const path = protocolPath(root, id);
      if (lstatIfExists(path, fs)) fail(`Protocol '${id}' already exists.`, 'REPOSITORY_CONFLICT');
      const metadata = { schemaVersion: 1, id, title: id.replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase()), status: 'draft', revision: 1, updatedAt: now() };
      const body = canonicalBody(`# ${metadata.title}\n\nDescribe the reviewed procedure.\n`);
      metadata.digest = bodyDigest(metadata, body);
      const source = render(metadata, body);
      const record = validateDocument(source, id);
      atomicWrite(path, source, fs, root.identity);
      return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Created draft protocol '${id}'.` });
    }

    if (parsed.subcommand === 'import') {
      const id = safeId(operands[0]);
      const path = protocolPath(root, id);
      if (lstatIfExists(path, fs)) fail(`Protocol '${id}' already exists.`, 'REPOSITORY_CONFLICT');
      const body = canonicalBody(readBounded(sourcePath(root, parsed.flags.from, fs), fs, 'Protocol import source'));
      const heading = body.match(/^#\s+(\S.*)$/m);
      if (!heading) fail('Protocol import source must contain a Markdown heading.');
      const metadata = { schemaVersion: 1, id, title: safeText(heading[1].trim(), 120, 'Protocol title'), status: 'draft', revision: 1, updatedAt: now() };
      metadata.digest = bodyDigest(metadata, body);
      const source = render(metadata, body);
      const record = validateDocument(source, id);
      atomicWrite(path, source, fs, root.identity);
      return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Imported draft protocol '${id}'.` });
    }

    const all = discover(root, fs, true);
    if (parsed.subcommand === 'validate') {
      const records = operands.length === 1 ? all.filter(record => record.metadata.id === operands[0]) : all;
      if (operands.length === 1 && records.length === 0) fail(`Protocol '${operands[0]}' was not found.`);
      return emit(dependencies, parsed, { protocols: records.map(record => publicProtocol(record)), message: `Validated ${records.length} protocol${records.length === 1 ? '' : 's'}.` });
    }
    if (parsed.subcommand === 'find') {
      const query = parsed.operands[0].normalize('NFKC').toLocaleLowerCase();
      const records = discover(root, fs, parsed.flags['include-drafts'] === true)
        .filter(record => `${record.metadata.title}\n${record.body}`.toLocaleLowerCase().includes(query));
      return emit(dependencies, parsed, { protocols: records.map(record => publicProtocol(record)), message: `Found ${records.length} matching protocol${records.length === 1 ? '' : 's'}.` });
    }
    if (parsed.subcommand === 'show') {
      const id = safeId(operands[0]);
      const record = all.find(candidate => candidate.metadata.id === id);
      if (!record || (record.metadata.status === 'draft' && parsed.flags['include-drafts'] !== true)) fail(`Protocol '${id}' was not found.`);
      return emit(dependencies, parsed, { protocol: publicProtocol(record, true), message: `Showing protocol '${id}'.` });
    }

    const id = safeId(operands[0]);
    const current = all.find(record => record.metadata.id === id);
    if (!current) fail(`Protocol '${id}' was not found.`);
    if (current.metadata.revision !== Number(parsed.flags['expected-revision'])) fail('Protocol revision conflict.', 'REPOSITORY_CONFLICT');
    const body = canonicalBody(readBounded(sourcePath(root, parsed.flags.from, fs), fs, 'Protocol update source'));
    const heading = body.match(/^#\s+(\S.*)$/m);
    if (!heading) fail('Protocol update source must contain a Markdown heading.');
    const metadata = { ...current.metadata, title: safeText(heading[1].trim(), 120, 'Protocol title'), status: parsed.flags.publish === true ? 'active' : 'draft', revision: current.metadata.revision + 1, updatedAt: now() };
    metadata.digest = bodyDigest(metadata, body);
    const source = render(metadata, body);
    const record = validateDocument(source, id);
    atomicWrite(protocolPath(root, id), source, fs, root.identity, current.metadata.digest);
    return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Updated protocol '${id}'.` });
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError('Protocol operation could not complete safely.', 'INTERNAL_ERROR');
    return emit(dependencies, parsed ?? input, errorResult(safe), safe.exitCode);
  }
}

export function activeProtocolContextRefs(projectRoot, options = {}) {
  const fs = options.fs ?? filesystem;
  const root = protocolRoot(resolve(projectRoot), fs);
  return Object.freeze(discover(root, fs, false).map(record => (
    `protocol:${record.metadata.id}:${record.metadata.revision}:${record.metadata.digest}`
  )));
}

export { MAX_PROTOCOL_BYTES, PROTOCOL_DIRECTORY, validateDocument };
