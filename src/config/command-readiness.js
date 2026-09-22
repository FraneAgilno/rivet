import * as filesystem from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { compileQualitySteps } from './commands.js';

const MAX_MANIFEST_BYTES = 256 * 1024;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function runnerManager(runner) {
  return runner.toLowerCase().replace(/\.(?:cmd|exe)$/, '');
}

function directoryFor(root, cwd, fs) {
  let current = root;
  for (const component of cwd === '.' ? [] : cwd.split('/')) {
    current = join(current, component);
    const before = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!before?.isDirectory() || before.isSymbolicLink()) return { status: 'unsafe-directory' };
    const canonical = fs.realpathSync(current);
    const after = fs.statSync(canonical);
    if (!within(root, canonical)) return { status: 'unsafe-directory' };
    if (!sameIdentity(before, after)) return { status: 'directory-identity-changed' };
  }
  const metadata = fs.lstatSync(current, { throwIfNoEntry: false });
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return { status: 'unsafe-directory' };
  const canonical = fs.realpathSync(current);
  const canonicalMetadata = fs.statSync(canonical);
  if (!within(root, canonical)) return { status: 'unsafe-directory' };
  if (!sameIdentity(metadata, canonicalMetadata)) return { status: 'directory-identity-changed' };
  return { status: 'ready', path: canonical, identity: metadata };
}

function directoryIdentityStatus(directory, fs) {
  try {
    const current = fs.lstatSync(directory.path, { throwIfNoEntry: false });
    if (!current?.isDirectory() || current.isSymbolicLink()
      || !sameIdentity(directory.identity, current)) return 'directory-identity-changed';
    const canonical = fs.realpathSync(directory.path);
    const canonicalMetadata = fs.statSync(canonical);
    return canonical === directory.path && sameIdentity(directory.identity, canonicalMetadata)
      ? 'ready' : 'directory-identity-changed';
  } catch {
    return 'directory-identity-changed';
  }
}

function readManifest(directory, fs) {
  const path = join(directory.path, 'package.json');
  const before = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!before) return { status: 'missing-manifest' };
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_MANIFEST_BYTES) {
    return { status: 'unsafe-manifest' };
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > MAX_MANIFEST_BYTES) {
      return { status: 'manifest-identity-changed' };
    }
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) return { status: 'unsafe-manifest' };
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_MANIFEST_BYTES) return { status: 'unsafe-manifest' };
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!current?.isFile() || current.isSymbolicLink() || !sameIdentity(opened, after)
      || !sameIdentity(after, current) || after.size !== current.size) return { status: 'manifest-identity-changed' };
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    } catch { return { status: 'invalid-manifest' }; }
    return { status: 'ready', manifest: parsed };
  } catch {
    return { status: 'unsafe-manifest' };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozen(child)])));
  }
  return value;
}

export function inspectCommandReadiness(projectRoot, config, options = {}) {
  const fs = options.fs ?? filesystem;
  const tools = options.tools ?? {};
  const lexicalRoot = resolve(projectRoot);
  const rootMetadata = fs.lstatSync(lexicalRoot, { throwIfNoEntry: false });
  const root = rootMetadata?.isDirectory() && !rootMetadata.isSymbolicLink()
    ? fs.realpathSync(lexicalRoot) : lexicalRoot;
  const rootSafe = rootMetadata?.isDirectory() && !rootMetadata.isSymbolicLink()
    && sameIdentity(rootMetadata, fs.statSync(root));
  const expectedManager = config.project.stack.packageManager;
  const steps = compileQualitySteps(config).map(step => {
    const manager = runnerManager(step.argv[0]);
    let status = 'ready';
    if (!rootSafe) status = 'unsafe-directory';
    else if (config.project.schemaVersion === 2 && manager !== expectedManager) status = 'manager-mismatch';
    else if (tools[manager]?.present !== true || tools[manager]?.supported !== true
      || tools[manager]?.runtimeResolved === false) status = 'tool-unavailable';
    else {
      const directory = directoryFor(root, step.cwd, fs);
      status = directory.status;
      if (status === 'ready') {
        status = directoryIdentityStatus(directory, fs);
        const manifest = status === 'ready' ? readManifest(directory, fs) : null;
        if (manifest) status = manifest.status;
        const finalDirectoryStatus = directoryIdentityStatus(directory, fs);
        if (finalDirectoryStatus !== 'ready') status = finalDirectoryStatus;
        if (status === 'ready' && manifest) {
          const scripts = manifest.manifest?.scripts;
          status = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
            && typeof scripts[step.argv[2]] === 'string' ? 'ready' : 'missing-script';
        }
      }
    }
    return {
      id: step.id,
      logicalId: step.logicalId,
      cwd: step.cwd,
      argv: step.argv,
      script: step.argv[2],
      manager,
      required: step.required,
      status,
      available: status === 'ready',
    };
  });
  return frozen({
    ready: steps.filter(step => step.required).every(step => step.status === 'ready'),
    allReady: steps.every(step => step.status === 'ready'),
    steps,
  });
}

export { MAX_MANIFEST_BYTES as MAX_COMMAND_MANIFEST_BYTES };
