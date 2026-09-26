import * as filesystem from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';

import { loadProjectConfig } from '../config/load.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

import { MAX_PROTOCOL_BYTES, PROTOCOL_DIRECTORY, MUTATION_LOCK, DIGEST, safeText, safeId, sameIdentity, lstatIfExists, readBounded, protocolRoot, canonicalBody, bodyDigest, validateDocument, protocolPath, discover, publicProtocol } from '../protocols/project.js';
import { protocolCompleteness, requireProtocolCompleteness } from '../protocols/project.js';
const MAX_QUERY_LENGTH = 256;
const SUBCOMMANDS = new Set(['add', 'import', 'validate', 'find', 'show', 'update', 'retire']);
function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function draftGuidance(id, revision) {
  return `Write the missing sections in a project-contained Markdown source file without inventing team policy, then run rivet protocols update ${id} --from=<file> --expected-revision=${revision}. Add --publish only after review and complete validation.`;
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
  const allowed = new Set(['project', 'json', 'from', 'include-drafts', 'include-retired', 'publish', 'expected-revision', 'expected-digest']);
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
  else dependencies.output.error(`ERROR: ${result.error?.message ?? result.message ?? 'Protocol operation failed.'}`);
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
    const root = protocolRoot(projectRoot, fs, { create: ['add', 'import'].includes(parsed.subcommand) });
    const operands = parsed.operands;
    const command = parsed.subcommand, flags = parsed.flags;
    if (flags.from !== undefined && !['add','import','update'].includes(command)) fail("Option '--from' is only valid for add/import/update.");
    if (flags.publish !== undefined && command !== 'update') fail("Only update --publish activates a protocol.");
    if ((flags['include-drafts'] !== undefined || flags['include-retired'] !== undefined) && !['find','show'].includes(command)) fail('Status inclusion options are only valid for find/show.');
    if (flags['expected-digest'] !== undefined && command !== 'show') fail("Option '--expected-digest' is only valid for show.");
    if (flags['expected-revision'] !== undefined && !['update','retire','show'].includes(command)) fail("Option '--expected-revision' is only valid for update/retire/show.");
    if (command === 'show' && (flags['expected-revision'] !== undefined || flags['expected-digest'] !== undefined)
      && (!/^[1-9][0-9]{0,9}$/.test(String(flags['expected-revision'] ?? '')) || Number(flags['expected-revision']) > 1_000_000_000 || !DIGEST.test(flags['expected-digest'] ?? ''))) fail('Exact protocol lookup requires both --expected-revision and --expected-digest from the approved run.');
    if (command === 'retire' && (operands.length !== 1 || !/^[1-9][0-9]{0,9}$/.test(String(flags['expected-revision'] ?? '')) || Number(flags['expected-revision']) > 1_000_000_000)) fail('Use rivet protocols retire <slug> --expected-revision=<current revision>.');
    if (parsed.subcommand === 'add' && (operands.length !== 1 || (parsed.flags.from !== undefined && typeof parsed.flags.from !== 'string'))) fail('Use rivet protocols add <slug>.');
    if (parsed.subcommand === 'import' && (operands.length !== 1 || typeof parsed.flags.from !== 'string')) fail('Use rivet protocols import <slug> --from=<path>.');
    if (parsed.subcommand === 'validate' && operands.length > 1) fail('Use rivet protocols validate [<slug>].');
    if (parsed.subcommand === 'find' && (operands.length !== 1 || typeof operands[0] !== 'string' || operands[0].length < 1 || operands[0].length > MAX_QUERY_LENGTH)) fail('Use rivet protocols find <query>.');
    if (parsed.subcommand === 'show' && operands.length !== 1) fail('Use rivet protocols show <slug>.');
    if (parsed.subcommand === 'update' && (operands.length !== 1 || typeof parsed.flags.from !== 'string' || parsed.flags.publish && parsed.flags['include-drafts'])) fail('Use rivet protocols update <slug> --from=<path> [--publish].');
    if (parsed.subcommand === 'update' && (!/^\d+$/.test(String(parsed.flags['expected-revision'] ?? '')) || Number(parsed.flags['expected-revision']) < 1)) fail("Option '--expected-revision' is required for update.");

    if (parsed.subcommand === 'add' && parsed.flags.from === undefined) {
      const id = safeId(operands[0]);
      const path = protocolPath(root, id);
      if (lstatIfExists(path, fs)) fail(`Protocol '${id}' already exists.`, 'REPOSITORY_CONFLICT');
      const metadata = { schemaVersion: 1, id, title: id.replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase()), status: 'draft', revision: 1, updatedAt: now() };
      const body = canonicalBody(`# ${metadata.title}\n\n## Owner\n\n## Purpose\n\n## Applies when\n\n## Procedure\n\n## Required checks and evidence\n`);
      metadata.digest = bodyDigest(metadata, body);
      const source = render(metadata, body);
      const record = validateDocument(source, id);
      atomicWrite(path, source, fs, root.identity);
      return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Created draft protocol '${id}'. ${draftGuidance(id, 1)}` });
    }

    if (parsed.subcommand === 'import' || parsed.subcommand === 'add') {
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
      return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Imported draft protocol '${id}'. ${draftGuidance(id, 1)}` });
    }

    if (parsed.subcommand === 'show') {
      const id = safeId(operands[0]);
      const record = validateDocument(readBounded(protocolPath(root, id), fs, `Protocol '${id}'`), id);
      if (!record || (record.metadata.status === 'draft' && parsed.flags['include-drafts'] !== true) || (record.metadata.status === 'retired' && parsed.flags['include-retired'] !== true)) fail(`Protocol '${id}' was not found.`);
      if (parsed.flags['expected-revision'] !== undefined && (record.metadata.status !== 'active' || record.metadata.revision !== Number(parsed.flags['expected-revision']) || record.metadata.digest !== parsed.flags['expected-digest'])) fail('Selected protocol changed or is no longer active. Create a new reviewed proposal.', 'REPOSITORY_CONFLICT');
      return emit(dependencies, parsed, { protocol: publicProtocol(record, true), message: `Showing protocol '${id}'.` });
    }

    const all = discover(root, fs, true);
    if (parsed.subcommand === 'validate') {
      const records = operands.length === 1 ? all.filter(record => record.metadata.id === operands[0]) : all;
      if (operands.length === 1 && records.length === 0) fail(`Protocol '${operands[0]}' was not found.`);
      return emit(dependencies, parsed, { protocols: records.map(record => publicProtocol(record)), message: `Validated integrity of ${records.length} protocol${records.length === 1 ? '' : 's'}. Completeness diagnostics are reported separately; incomplete records cannot publish a new revision.` });
    }
    if (parsed.subcommand === 'find') {
      const query = parsed.operands[0].normalize('NFKC').toLocaleLowerCase();
      const records = discover(root, fs, parsed.flags['include-drafts'] === true, parsed.flags['include-retired'] === true)
        .filter(record => `${record.metadata.title}\n${record.body}`.toLocaleLowerCase().includes(query));
      return emit(dependencies, parsed, { protocols: records.map(record => publicProtocol(record)), message: `Found ${records.length} matching protocol${records.length === 1 ? '' : 's'}.` });
    }


    const id = safeId(operands[0]);
    const current = all.find(record => record.metadata.id === id);
    if (!current) fail(`Protocol '${id}' was not found.`);
    if (current.metadata.revision !== Number(parsed.flags['expected-revision'])) fail('Protocol revision conflict.', 'REPOSITORY_CONFLICT');
    if (parsed.subcommand === 'retire') {
      const metadata = { ...current.metadata, status: 'retired', revision: current.metadata.revision + 1, updatedAt: now() };
      metadata.digest = bodyDigest(metadata, current.body);
      const source = render(metadata, current.body), record = validateDocument(source, id);
      atomicWrite(protocolPath(root, id), source, fs, root.identity, current.metadata.digest);
      return emit(dependencies, parsed, {protocol: publicProtocol(record), message: `Retired protocol '${id}'. Existing runs require a new reviewed proposal.`});
    }
    const body = canonicalBody(readBounded(sourcePath(root, parsed.flags.from, fs), fs, 'Protocol update source'));
    if (parsed.flags.publish === true) requireProtocolCompleteness(body);
    const heading = body.match(/^#\s+(\S.*)$/m);
    if (!heading) fail('Protocol update source must contain a Markdown heading.');
    const metadata = { ...current.metadata, title: safeText(heading[1].trim(), 120, 'Protocol title'), status: parsed.flags.publish === true ? 'active' : 'draft', revision: current.metadata.revision + 1, updatedAt: now() };
    metadata.digest = bodyDigest(metadata, body);
    const source = render(metadata, body);
    const record = validateDocument(source, id);
    atomicWrite(protocolPath(root, id), source, fs, root.identity, current.metadata.digest);
    return emit(dependencies, parsed, { protocol: publicProtocol(record), message: `Updated protocol '${id}'.${metadata.status === 'draft' ? ' ' + draftGuidance(id, metadata.revision) : ''}` });
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError('Protocol operation could not complete safely.', 'INTERNAL_ERROR');
    return emit(dependencies, parsed ?? input, errorResult(safe), safe.exitCode);
  }
}

export function activeProtocolContextRefs(projectRoot, options = {}) {
  const fs = options.fs ?? filesystem;
  const root = protocolRoot(resolve(projectRoot), fs);
  return Object.freeze(discover(root, fs, false, false).map(record => (
    `protocol:${record.metadata.id}:${record.metadata.revision}:${record.metadata.digest}`
  )));
}

export { MAX_PROTOCOL_BYTES, PROTOCOL_DIRECTORY, validateDocument };
