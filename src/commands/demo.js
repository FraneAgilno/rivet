import { execFile as execFileCallback } from 'node:child_process';
import * as filesystem from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { CliError, EXIT_CODES } from '../cli/output.js';

const execFile = promisify(execFileCallback);
const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_TEMPLATE_NAME = /^(?:\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PROJECT_TOKEN = '__PROJECT_NAME__';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_ENTRIES = 1000;

export class DemoInputError extends CliError {
  constructor(message) {
    super(message, 'INVALID_INPUT');
    this.name = 'DemoInputError';
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function directoryIdentity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function assertSafeName(name) {
  if (
    typeof name !== 'string'
    || name.length < 1
    || name.length > 128
    || name === '.'
    || name === '..'
    || name.toLowerCase() === '.git'
    || name.normalize('NFKC') !== name
    || /[ .]$/.test(name)
    || WINDOWS_DEVICE_NAME.test(name)
    || !SAFE_TEMPLATE_NAME.test(name)
  ) throw new CliError('Conference planner template contains an unsupported entry.', 'MISSING_CONFIGURATION');
}

function validateProjectName(name) {
  if (
    typeof name !== 'string'
    || name.length > 64
    || name.normalize('NFKC') !== name
    || WINDOWS_DEVICE_NAME.test(name)
    || !PROJECT_ID.test(name)
  ) throw new DemoInputError('Project name must be a lowercase hyphenated identifier of at most 64 characters.');
  return name;
}

function captureDemoOptions(options) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('shape');
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('prototype');
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== 'string' || !['target', 'name', 'gitInit'].includes(key))) {
      throw new Error('key');
    }
    const snapshot = Object.create(null);
    for (const key of ['target', 'name', 'gitInit']) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor) {
        if (key !== 'gitInit') throw new Error('missing');
        continue;
      }
      if (!descriptor.enumerable) throw new Error('enumerability');
      snapshot[key] = Reflect.get(options, key);
    }
    return Object.freeze(snapshot);
  } catch {
    throw new DemoInputError('Demo creation options are invalid.');
  }
}

function validateTarget(target, cwd, fs) {
  if (
    typeof target !== 'string'
    || target.length < 1
    || target.length > 4096
    || target.normalize('NFKC') !== target
    || /[\u0000\r\n]/.test(target)
  ) throw new DemoInputError('Demo target must be an existing empty regular directory.');
  const lexical = resolve(cwd, target);
  let status;
  let canonical;
  try {
    status = fs.lstatSync(lexical);
    canonical = fs.realpathSync(lexical);
  } catch {
    throw new DemoInputError('Demo target must be an existing empty regular directory.');
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new DemoInputError('Demo target must be an existing empty regular directory without symbolic links.');
  }
  const canonicalStatus = fs.statSync(canonical, { bigint: true });
  const lexicalStatus = fs.lstatSync(lexical, { bigint: true });
  if (!sameDirectory(canonicalStatus, lexicalStatus)) {
    throw new DemoInputError('Demo target directory changed during validation.');
  }
  let entries;
  try { entries = fs.readdirSync(canonical); }
  catch { throw new DemoInputError('Demo target must be an existing empty regular directory.'); }
  if (entries.length !== 0) throw new DemoInputError('Demo target directory must be empty.');
  return Object.freeze({ path: canonical, identity: directoryIdentity(canonicalStatus) });
}

function snapshotFile(path, label, status, fs) {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1n || status.size > BigInt(MAX_FILE_BYTES)) {
    throw new CliError('Conference planner template contains an unsupported file or hard link.', 'MISSING_CONFIGURATION');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(status, opened)) throw new Error('identity');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count < 1) throw new Error('read');
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error('growth');
    if (!sameIdentity(opened, fs.fstatSync(descriptor, { bigint: true }))) throw new Error('change');
    return Object.freeze({ label, bytes, mode: Number(status.mode & 0o777n), status });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Conference planner template changed during validation.', 'MISSING_CONFIGURATION', { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); }
      catch { throw new CliError('Conference planner template could not be read safely.', 'MISSING_CONFIGURATION'); }
    }
  }
}

function snapshotTemplate(packageRoot, fs) {
  const lexicalPackageRoot = resolve(packageRoot);
  let packageStatus;
  let canonicalPackageRoot;
  try {
    packageStatus = fs.lstatSync(lexicalPackageRoot, { bigint: true });
    canonicalPackageRoot = fs.realpathSync(lexicalPackageRoot);
  } catch {
    throw new CliError('Conference planner template is unavailable.', 'MISSING_CONFIGURATION');
  }
  if (packageStatus.isSymbolicLink() || !packageStatus.isDirectory() || canonicalPackageRoot !== lexicalPackageRoot) {
    throw new CliError('Conference planner template root is unsafe.', 'MISSING_CONFIGURATION');
  }
  const templateRoot = join(canonicalPackageRoot, 'templates', 'conference-planner');
  let rootStatus;
  try { rootStatus = fs.lstatSync(templateRoot, { bigint: true }); }
  catch { throw new CliError('Conference planner template is unavailable.', 'MISSING_CONFIGURATION'); }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new CliError('Conference planner template root is unsafe.', 'MISSING_CONFIGURATION');
  }
  const canonicalTemplateRoot = fs.realpathSync(templateRoot);
  if (canonicalTemplateRoot !== templateRoot || !isWithin(canonicalPackageRoot, canonicalTemplateRoot)) {
    throw new CliError('Conference planner template root is unsafe.', 'MISSING_CONFIGURATION');
  }

  const files = [];
  const directories = [];
  const identities = new Set();
  let totalBytes = 0;
  let entryCount = 0;

  function visit(path, parts, expectedStatus) {
    let before = expectedStatus;
    if (!before) before = fs.lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new CliError('Conference planner template contains an unsupported entry.', 'MISSING_CONFIGURATION');
    }
    let names;
    try { names = fs.readdirSync(path).sort((left, right) => left.localeCompare(right)); }
    catch { throw new CliError('Conference planner template is unavailable.', 'MISSING_CONFIGURATION'); }
    if (parts.length > 0 && names.length === 0) {
      throw new CliError('Conference planner template contains an empty directory.', 'MISSING_CONFIGURATION');
    }
    directories.push(Object.freeze({ path, parts: Object.freeze(parts), status: before, names: Object.freeze(names) }));
    for (const name of names) {
      assertSafeName(name);
      entryCount += 1;
      if (entryCount > MAX_TEMPLATE_ENTRIES) {
        throw new CliError('Conference planner template exceeds its entry limit.', 'MISSING_CONFIGURATION');
      }
      const childPath = join(path, name);
      const status = fs.lstatSync(childPath, { bigint: true });
      if (status.isSymbolicLink()) {
        throw new CliError('Conference planner template contains an unsupported symbolic link.', 'MISSING_CONFIGURATION');
      }
      if (status.isDirectory()) {
        visit(childPath, [...parts, name], status);
        continue;
      }
      const identity = `${status.dev}:${status.ino}`;
      if (identities.has(identity)) {
        throw new CliError('Conference planner template contains an unsupported hard link.', 'MISSING_CONFIGURATION');
      }
      identities.add(identity);
      const file = snapshotFile(childPath, [...parts, name].join('/'), status, fs);
      totalBytes += file.bytes.length;
      if (totalBytes > MAX_TEMPLATE_BYTES) {
        throw new CliError('Conference planner template exceeds its byte limit.', 'MISSING_CONFIGURATION');
      }
      files.push(Object.freeze({ ...file, path: childPath, parts: Object.freeze([...parts, name]) }));
    }
    if (!sameIdentity(before, fs.lstatSync(path, { bigint: true }))) {
      throw new CliError('Conference planner template changed during validation.', 'MISSING_CONFIGURATION');
    }
  }

  visit(canonicalTemplateRoot, [], rootStatus);
  for (const directory of directories) {
    const current = fs.lstatSync(directory.path, { bigint: true });
    if (!sameIdentity(directory.status, current)
      || fs.readdirSync(directory.path).sort((a, b) => a.localeCompare(b)).join('\0') !== directory.names.join('\0')) {
      throw new CliError('Conference planner template changed during validation.', 'MISSING_CONFIGURATION');
    }
  }
  for (const file of files) {
    if (!sameIdentity(file.status, fs.lstatSync(file.path, { bigint: true }))) {
      throw new CliError('Conference planner template changed during validation.', 'MISSING_CONFIGURATION');
    }
  }
  return Object.freeze({ root: canonicalTemplateRoot, files: Object.freeze(files) });
}

function substitutedBytes(bytes, name) {
  if (!bytes.includes(Buffer.from(PROJECT_TOKEN, 'utf8'))) return bytes;
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CliError('Conference planner template substitution source is invalid.', 'MISSING_CONFIGURATION'); }
  const result = source.replaceAll(PROJECT_TOKEN, name);
  if (result.includes(PROJECT_TOKEN)) {
    throw new CliError('Conference planner template substitution failed.', 'MISSING_CONFIGURATION');
  }
  return Buffer.from(result, 'utf8');
}

function outputParts(parts) {
  return parts.length === 1 && parts[0] === 'gitignore' ? Object.freeze(['.gitignore']) : parts;
}

function withPinnedDirectory(directory, identity, fs, operation) {
  const originalCwd = process.cwd();
  let changed = false;
  try {
    process.chdir(directory);
    changed = true;
    if (!sameDirectory(identity, fs.statSync('.', { bigint: true }))) {
      throw new CliError('Demo target directory changed during publication.', 'REPOSITORY_CONFLICT');
    }
    return operation();
  } finally {
    if (changed) process.chdir(originalCwd);
  }
}

function writeAll(descriptor, bytes, fs) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(count) || count < 1) throw new Error('write');
    offset += count;
  }
}

function pathKey(parts) {
  return parts.join('/');
}

function createOwnership(target) {
  return {
    target,
    directoryIdentities: new Map([['', target.identity]]),
    directories: [],
    files: [],
  };
}

function inOwnedDirectory(ownership, parts, fs, operation) {
  return withPinnedDirectory(ownership.target.path, ownership.target.identity, fs, () => {
    function descend(index) {
      if (index === parts.length) return operation();
      const currentParts = parts.slice(0, index + 1);
      const identity = ownership.directoryIdentities.get(pathKey(currentParts));
      if (!identity) throw new Error('missing identity');
      const status = fs.lstatSync(parts[index], { bigint: true });
      if (status.isSymbolicLink() || !status.isDirectory() || !sameDirectory(identity, status)) {
        throw new Error('changed directory');
      }
      return withPinnedDirectory(parts[index], identity, fs, () => descend(index + 1));
    }
    return descend(0);
  });
}

function cleanupOwnership(ownership, fs) {
  let residue = false;
  for (const file of [...ownership.files].reverse()) {
    try {
      inOwnedDirectory(ownership, file.parts.slice(0, -1), fs, () => {
        const leaf = file.parts.at(-1);
        const current = fs.lstatSync(leaf, { throwIfNoEntry: false, bigint: true });
        if (!current) return;
        if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(file.status, current)) {
          residue = true;
          return;
        }
        fs.unlinkSync(leaf);
      });
    } catch { residue = true; }
  }
  for (const directory of [...ownership.directories].reverse()) {
    try {
      inOwnedDirectory(ownership, directory.parts.slice(0, -1), fs, () => {
        const leaf = directory.parts.at(-1);
        const current = fs.lstatSync(leaf, { throwIfNoEntry: false, bigint: true });
        if (!current) return;
        if (current.isSymbolicLink() || !current.isDirectory()
          || !sameDirectory(directory.identity, current)
          || fs.readdirSync(leaf).length !== 0) {
          residue = true;
          return;
        }
        fs.rmdirSync(leaf);
      });
    } catch { residue = true; }
  }
  return residue;
}

function publishFileTree(files, name, target, fs, options = {}) {
  const ownership = createOwnership(target);
  const prefix = options.prefix ?? [];
  const exact = options.exact === true;
  const directoryPaths = new Map();
  for (const directory of options.directories ?? []) {
    const parts = [...prefix, ...directory.parts];
    directoryPaths.set(pathKey(parts), parts);
  }
  for (const file of files) {
    const parts = [...prefix, ...outputParts(file.parts)];
    for (let length = 1; length < parts.length; length += 1) {
      const directoryParts = parts.slice(0, length);
      directoryPaths.set(pathKey(directoryParts), directoryParts);
    }
  }
  const orderedDirectories = [...directoryPaths.values()].sort((left, right) => (
    left.length - right.length || pathKey(left).localeCompare(pathKey(right))
  ));
  try {
    withPinnedDirectory(target.path, target.identity, fs, () => {
      if (options.requireEmpty !== false && fs.readdirSync('.').length !== 0) {
        throw new DemoInputError('Demo target directory must remain empty.');
      }
      for (const parts of orderedDirectories) {
        const parentParts = parts.slice(0, -1);
        const relativeParent = pathKey(parentParts);
        const parentIdentity = ownership.directoryIdentities.get(relativeParent);
        withPinnedDirectory(relativeParent || '.', parentIdentity, fs, () => {
          const leaf = parts.at(-1);
          let status = fs.lstatSync(leaf, { throwIfNoEntry: false, bigint: true });
          if (!status) {
            fs.mkdirSync(leaf, { mode: 0o755 });
            status = fs.lstatSync(leaf, { bigint: true });
          } else {
            const known = ownership.directoryIdentities.get(pathKey(parts));
            if (!known || !sameDirectory(known, status)) {
              throw new CliError('Demo target topology changed during publication.', 'REPOSITORY_CONFLICT');
            }
          }
          if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new CliError('Demo target topology changed during publication.', 'REPOSITORY_CONFLICT');
          }
          const identity = directoryIdentity(status);
          ownership.directories.push(Object.freeze({ parts: Object.freeze(parts), identity }));
          ownership.directoryIdentities.set(pathKey(parts), identity);
        });
      }
      for (const file of files) {
        const parts = [...prefix, ...outputParts(file.parts)];
        const relativeDirectory = pathKey(parts.slice(0, -1));
        const parentIdentity = ownership.directoryIdentities.get(relativeDirectory);
        withPinnedDirectory(relativeDirectory || '.', parentIdentity, fs, () => {
          const leaf = parts.at(-1);
          let descriptor;
          let finalStatus;
          const bytes = exact ? file.bytes : substitutedBytes(file.bytes, name);
          try {
            descriptor = fs.openSync(
              leaf,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
              file.mode,
            );
            const opened = fs.fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.nlink !== 1n) throw new Error('leaf');
            writeAll(descriptor, bytes, fs);
            fs.fsyncSync(descriptor);
            finalStatus = fs.fstatSync(descriptor, { bigint: true });
            if (!finalStatus.isFile() || finalStatus.nlink !== 1n) throw new Error('leaf change');
          } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
          }
          const published = fs.lstatSync(leaf, { bigint: true });
          if (!sameIdentity(finalStatus, published)) throw new Error('published leaf change');
          ownership.files.push(Object.freeze({
            parts: Object.freeze(parts),
            status: published,
            bytes: Buffer.from(bytes),
          }));
        });
      }
    });
  } catch (error) {
    cleanupOwnership(ownership, fs);
    if (error instanceof CliError) throw error;
    throw new CliError('Conference planner demo could not be written safely.', 'REPOSITORY_CONFLICT', { cause: error });
  }
  return ownership;
}

async function defaultGitRunner(command, args, options) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env,
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: '',
    };
  }
}

function assertTargetIdentity(target, fs) {
  try {
    const current = fs.lstatSync(target.path, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || !sameDirectory(target.identity, current)) {
      throw new Error('identity');
    }
  } catch {
    throw new CliError('Demo target directory changed during generation.', 'REPOSITORY_CONFLICT');
  }
}

function safeGitEnvironment(source, platform) {
  const result = Object.create(null);
  try {
    if (!source || typeof source !== 'object') throw new Error('environment');
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
      const value = Reflect.get(source, key);
      if (typeof value === 'string') result[key] = value;
    }
  } catch {
    throw new CliError('Git initialization environment is invalid.', 'REPOSITORY_CONFLICT');
  }
  const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null';
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_SYSTEM = nullDevice;
  result.GIT_CONFIG_GLOBAL = nullDevice;
  result.GIT_CONFIG_COUNT = '0';
  result.GIT_TERMINAL_PROMPT = '0';
  result.GIT_OPTIONAL_LOCKS = '0';
  return Object.freeze(result);
}

function captureGitCode(result) {
  try {
    if (!result || typeof result !== 'object') return null;
    const code = Reflect.get(result, 'code');
    return Number.isInteger(code) ? code : null;
  } catch { return null; }
}

function createPrivateGitStage(target, fs) {
  let lexical;
  try {
    lexical = fs.mkdtempSync(join(tmpdir(), 'agilno-demo-git-'));
    fs.chmodSync(lexical, 0o700);
    const canonical = fs.realpathSync(lexical);
    const status = fs.lstatSync(canonical, { bigint: true });
    if (status.isSymbolicLink() || !status.isDirectory()
      || (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o700)) {
      throw new Error('stage');
    }
    if (isWithin(target.path, canonical) || isWithin(canonical, target.path)) throw new Error('stage overlap');
    return Object.freeze({ path: canonical, identity: directoryIdentity(status) });
  } catch {
    if (lexical) {
      try {
        const status = fs.lstatSync(lexical, { bigint: true });
        if (!status.isSymbolicLink() && status.isDirectory() && fs.readdirSync(lexical).length === 0) fs.rmdirSync(lexical);
      } catch { /* private stage cleanup is best effort before identity capture */ }
    }
    throw new CliError('Private Git staging could not be created safely.', 'REPOSITORY_CONFLICT');
  }
}

function snapshotPrivateStage(stage, fs) {
  const ownership = createOwnership(stage);
  const directories = [];
  const files = [];
  let entries = 0;
  let bytes = 0;
  let rootNames = [];
  try {
    withPinnedDirectory(stage.path, stage.identity, fs, () => {
      function visit(parts, identity) {
        const names = fs.readdirSync('.').sort((left, right) => left.localeCompare(right));
        if (parts.length === 0) rootNames = names;
        for (const name of names) {
          if (!(parts.length === 0 && name === '.git')) assertSafeName(name);
          entries += 1;
          if (entries > MAX_TEMPLATE_ENTRIES) throw new Error('entries');
          const status = fs.lstatSync(name, { bigint: true });
          const childParts = [...parts, name];
          if (status.isSymbolicLink()) throw new Error('link');
          if (status.isDirectory()) {
            const childIdentity = directoryIdentity(status);
            const directory = Object.freeze({ parts: Object.freeze(childParts), identity: childIdentity });
            directories.push(directory);
            ownership.directories.push(directory);
            ownership.directoryIdentities.set(pathKey(childParts), childIdentity);
            withPinnedDirectory(name, childIdentity, fs, () => visit(childParts, childIdentity));
            continue;
          }
          const file = snapshotFile(name, pathKey(childParts), status, fs);
          bytes += file.bytes.length;
          if (bytes > MAX_TEMPLATE_BYTES) throw new Error('bytes');
          const ownedFile = Object.freeze({
            parts: Object.freeze(childParts),
            status: file.status,
            bytes: Buffer.from(file.bytes),
            mode: file.mode,
          });
          files.push(ownedFile);
          ownership.files.push(ownedFile);
        }
        if (!sameDirectory(identity, fs.statSync('.', { bigint: true }))
          || fs.readdirSync('.').sort((left, right) => left.localeCompare(right)).join('\0') !== names.join('\0')) {
          throw new Error('directory change');
        }
      }
      visit([], stage.identity);
    });
    return Object.freeze({
      unsafe: false,
      ownership,
      directories: Object.freeze(directories),
      files: Object.freeze(files),
      rootNames: Object.freeze(rootNames),
    });
  } catch {
    return Object.freeze({ unsafe: true, ownership: null, directories: null, files: null, rootNames: null });
  }
}

function validGitSnapshot(snapshot) {
  if (snapshot.unsafe || snapshot.rootNames?.join('\0') !== '.git') return false;
  const allowedDirectories = new Set([
    '.git',
    '.git/objects',
    '.git/objects/info',
    '.git/objects/pack',
    '.git/refs',
    '.git/refs/heads',
    '.git/refs/tags',
  ]);
  if (snapshot.directories.some(directory => !allowedDirectories.has(pathKey(directory.parts)))) return false;
  const byPath = new Map(snapshot.files.map(file => [pathKey(file.parts), file]));
  if (byPath.size !== 2 || !byPath.has('.git/HEAD') || !byPath.has('.git/config')) return false;
  let head;
  let config;
  try {
    head = new TextDecoder('utf-8', { fatal: true }).decode(byPath.get('.git/HEAD').bytes);
    config = new TextDecoder('utf-8', { fatal: true }).decode(byPath.get('.git/config').bytes);
  } catch { return false; }
  if (!/^ref: refs\/heads\/main\r?\n$/.test(head)) return false;
  const allowedCoreKeys = new Set([
    'repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks',
  ]);
  let section = '';
  const values = new Map();
  for (const sourceLine of config.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      if (section !== 'core') return false;
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment || section !== 'core') return false;
    const key = assignment[1].toLowerCase();
    if (!allowedCoreKeys.has(key) || values.has(key)) return false;
    values.set(key, assignment[2].trim().toLowerCase());
  }
  return values.get('repositoryformatversion') === '0' && values.get('bare') === 'false';
}

function removePrivateStage(stage, snapshot, fs) {
  let residue = snapshot.unsafe;
  if (snapshot.ownership) residue = cleanupOwnership(snapshot.ownership, fs) || residue;
  try {
    const current = fs.lstatSync(stage.path, { throwIfNoEntry: false, bigint: true });
    if (!current) return true;
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameDirectory(stage.identity, current) || fs.readdirSync(stage.path).length !== 0) return true;
    fs.rmdirSync(stage.path);
    if (fs.lstatSync(stage.path, { throwIfNoEntry: false, bigint: true })) return true;
  } catch { return true; }
  return residue;
}

function verifyExactOwnership(target, ownerships, fs) {
  const combined = createOwnership(target);
  const directories = new Map();
  const files = new Map();
  try {
    assertTargetIdentity(target, fs);
    for (const ownership of ownerships) {
      if (!sameDirectory(target.identity, ownership.target.identity)) throw new Error('target');
      for (const directory of ownership.directories) {
        const key = pathKey(directory.parts);
        const prior = directories.get(key);
        if (prior && !sameDirectory(prior.identity, directory.identity)) throw new Error('directory collision');
        directories.set(key, directory);
        combined.directoryIdentities.set(key, directory.identity);
      }
      for (const file of ownership.files) {
        const key = pathKey(file.parts);
        if (files.has(key) || directories.has(key)) throw new Error('file collision');
        files.set(key, file);
      }
    }
    const expectedChildren = new Map([['', new Set()]]);
    for (const directory of directories.values()) {
      const parent = pathKey(directory.parts.slice(0, -1));
      if (!expectedChildren.has(parent)) expectedChildren.set(parent, new Set());
      expectedChildren.get(parent).add(directory.parts.at(-1));
      if (!expectedChildren.has(pathKey(directory.parts))) expectedChildren.set(pathKey(directory.parts), new Set());
    }
    for (const file of files.values()) {
      const parent = pathKey(file.parts.slice(0, -1));
      if (!expectedChildren.has(parent)) throw new Error('missing parent');
      expectedChildren.get(parent).add(file.parts.at(-1));
    }
    for (const [key, expected] of expectedChildren) {
      const parts = key === '' ? [] : key.split('/');
      inOwnedDirectory(combined, parts, fs, () => {
        const actual = fs.readdirSync('.').sort((left, right) => left.localeCompare(right));
        const names = [...expected].sort((left, right) => left.localeCompare(right));
        if (actual.join('\0') !== names.join('\0')) throw new Error('manifest');
      });
    }
    for (const file of files.values()) {
      inOwnedDirectory(combined, file.parts.slice(0, -1), fs, () => {
        const leaf = file.parts.at(-1);
        const status = fs.lstatSync(leaf, { bigint: true });
        if (status.isSymbolicLink() || !sameIdentity(file.status, status)) throw new Error('file identity');
        const current = snapshotFile(leaf, pathKey(file.parts), status, fs);
        if (!current.bytes.equals(file.bytes)) throw new Error('file bytes');
      });
    }
    assertTargetIdentity(target, fs);
  } catch {
    throw new CliError('Demo target contents changed during Git initialization.', 'REPOSITORY_CONFLICT');
  }
}

export async function createDemo(options, dependencies = {}) {
  const request = captureDemoOptions(options);
  const fs = dependencies.fs ?? filesystem;
  const cwd = resolve((dependencies.cwd ?? (() => process.cwd()))());
  const packageRoot = dependencies.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const name = validateProjectName(request.name);
  if (request.gitInit !== undefined && typeof request.gitInit !== 'boolean') {
    throw new DemoInputError('Git initialization must be explicitly enabled or disabled.');
  }
  const target = validateTarget(request.target, cwd, fs);
  const template = snapshotTemplate(packageRoot, fs);
  if (isWithin(template.root, target.path) || isWithin(target.path, template.root)) {
    throw new DemoInputError('Demo target must be isolated from the package template.');
  }
  const generatedOwnership = publishFileTree(template.files, name, target, fs);

  const runGit = dependencies.runGit ?? defaultGitRunner;
  if (request.gitInit === true) {
    let stage = null;
    let stageSnapshot = null;
    let gitOwnership = null;
    let targetConflict = false;
    let result = null;
    let executionFailed = false;
    try {
      const platform = dependencies.platform ?? process.platform;
      const gitEnvironment = safeGitEnvironment(dependencies.env ?? process.env, platform);
      const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null';
      assertTargetIdentity(target, fs);
      stage = createPrivateGitStage(target, fs);
      result = await runGit(
        'git',
        [
          '--literal-pathspecs',
          '-c', `core.hooksPath=${nullDevice}`,
          '-c', 'core.fsmonitor=false',
          'init', '--quiet', '--initial-branch=main', '--template=', '.',
        ],
        { cwd: stage.path, env: gitEnvironment, shell: false },
      );
    } catch {
      executionFailed = true;
    }
    if (stage) stageSnapshot = snapshotPrivateStage(stage, fs);
    try {
      if (executionFailed || captureGitCode(result) !== 0 || !stageSnapshot || !validGitSnapshot(stageSnapshot)) {
        throw new Error('git result');
      }
      try { verifyExactOwnership(target, [generatedOwnership], fs); }
      catch { targetConflict = true; throw new Error('target changed'); }
      try {
        gitOwnership = publishFileTree(stageSnapshot.files, name, target, fs, {
          directories: stageSnapshot.directories,
          exact: true,
          requireEmpty: false,
        });
      } catch {
        targetConflict = true;
        throw new Error('git publication');
      }
      try { verifyExactOwnership(target, [generatedOwnership, gitOwnership], fs); }
      catch { targetConflict = true; throw new Error('target changed'); }
      if (removePrivateStage(stage, stageSnapshot, fs)) throw new Error('stage residue');
      stage = null;
      try { verifyExactOwnership(target, [generatedOwnership, gitOwnership], fs); }
      catch { targetConflict = true; throw new Error('target changed'); }
    } catch {
      let residue = targetConflict;
      if (gitOwnership) residue = cleanupOwnership(gitOwnership, fs) || residue;
      if (stage) {
        if (!stageSnapshot) stageSnapshot = snapshotPrivateStage(stage, fs);
        residue = removePrivateStage(stage, stageSnapshot, fs) || residue;
      }
      residue = cleanupOwnership(generatedOwnership, fs) || residue;
      throw new CliError(
        residue
          ? 'Git initialization failed; concurrent or changed target residue was preserved.'
          : 'Git initialization failed; generated files were removed.',
        'REPOSITORY_CONFLICT',
      );
    }
  }

  assertTargetIdentity(target, fs);
  return Object.freeze({
    target: target.path,
    name,
    gitInitialized: request.gitInit === true,
    nextSteps: Object.freeze(['npm ci', 'npm run check']),
  });
}

export async function demoCommand(parsed, dependencies) {
  if (parsed.subcommand !== 'create' || parsed.operands.length !== 1 || typeof parsed.flags.name !== 'string') {
    throw new DemoInputError("Usage: rivet demo create <target> --name=<project-id> [--git-init]");
  }
  const result = await createDemo({
    target: parsed.operands[0],
    name: parsed.flags.name,
    gitInit: parsed.flags['git-init'] === true,
  }, dependencies);
  dependencies.output.log([
    `Created '${result.name}' in the requested local target directory.`,
    'Next steps:',
    '  npm ci',
    '  npm run check',
    result.gitInitialized ? 'Git was initialized locally; no remote was created.' : 'Git was not initialized. Re-run with --git-init to opt in.',
  ].join('\n'));
  return EXIT_CODES.SUCCESS;
}
