import * as filesystem from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_DISCOVERY_FILE_BYTES = 256 * 1024;
const OPTIONAL_FILES = Object.freeze([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts',
  'AGENTS.md', 'CLAUDE.md', 'README.md',
  '.storybook/main.js', '.storybook/main.mjs', '.storybook/main.ts',
  '.github/copilot-instructions.md',
]);

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function safeFile(root, relativePath, fs, required = false) {
  const components = relativePath.split('/');
  let path = root;
  for (let index = 0; index < components.length; index += 1) {
    path = join(path, components[index]);
    const metadata = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!metadata) {
      if (required) throw new Error(`${relativePath} must be a regular bounded file`);
      return null;
    }
    if (metadata.isSymbolicLink()) {
      if (index === components.length - 1) {
        throw new Error(`${relativePath} must be a regular bounded file`);
      }
      throw new Error(`${relativePath} has a symbolic link ancestor in an allowlisted path`);
    }
    const canonical = fs.realpathSync(path);
    const canonicalMetadata = fs.statSync(canonical);
    if (!isWithin(root, canonical) || !sameIdentity(metadata, canonicalMetadata)) {
      throw new Error(`${relativePath} changed identity outside its allowlisted path`);
    }
    if (index < components.length - 1) {
      if (!metadata.isDirectory()) throw new Error(`${relativePath} has a non-directory allowlisted ancestor`);
      continue;
    }
    if (!metadata.isFile() || metadata.size > MAX_DISCOVERY_FILE_BYTES) {
      throw new Error(`${relativePath} must be a regular bounded file`);
    }
    return {
      path,
      relativePath,
      size: metadata.size,
      identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }),
    };
  }
  return null;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readStrictBoundedFile(file, fs = filesystem, maxBytes = MAX_DISCOVERY_FILE_BYTES) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file.path, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(opened, file.identity)) {
      throw new Error('Bounded file changed identity before reading');
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
      if (capacity <= 0) break;
      const buffer = Buffer.allocUnsafe(capacity);
      const count = fs.readSync(descriptor, buffer, 0, capacity, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error('Bounded file exceeds the byte limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectBoundedFile(root, relativePath, fs = filesystem, required = true) {
  return safeFile(root, relativePath, fs, required);
}

function slug(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const candidate = /^[a-z]/.test(normalized) ? normalized : `project-${normalized || 'local'}`;
  return candidate.slice(0, 64).replace(/-+$/g, '');
}

function packageManager(files) {
  if (files.has('pnpm-lock.yaml')) return ['pnpm', 'pnpm-lock.yaml'];
  if (files.has('yarn.lock')) return ['yarn', 'yarn.lock'];
  if (files.has('bun.lock') || files.has('bun.lockb')) return ['bun', files.has('bun.lock') ? 'bun.lock' : 'bun.lockb'];
  return ['npm', files.has('package-lock.json') ? 'package-lock.json' : 'package.json'];
}

function commandRegistry(scripts, manager) {
  const commands = {};
  const provenance = {};
  for (const key of ['build', 'test', 'lint', 'typecheck', 'dev']) {
    if (typeof scripts[key] === 'string') {
      commands[key] = [manager, 'run', key];
      provenance[`commands.${key}`] = 'package.json#scripts';
    }
  }
  for (const required of ['build', 'test']) {
    if (!commands[required]) {
      commands[required] = [manager, 'run', required];
      provenance[`commands.${required}`] = 'safe-default (script availability requires review)';
    }
  }
  return { commands, provenance };
}

export async function discoverProject(projectRoot, options = {}) {
  const fs = options.fs ?? filesystem;
  const lexicalRoot = resolve(projectRoot);
  const rootMetadata = fs.lstatSync(lexicalRoot, { throwIfNoEntry: false });
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Project root must be a regular directory');
  }
  const root = fs.realpathSync(lexicalRoot);
  if (!sameIdentity(rootMetadata, fs.statSync(root))) {
    throw new Error('Project root changed identity during validation');
  }
  const manifestFile = safeFile(root, 'package.json', fs, true);
  const files = new Map([['package.json', manifestFile]]);
  for (const name of OPTIONAL_FILES) {
    const file = safeFile(root, name, fs);
    if (file) files.set(name, file);
  }
  let manifest;
  try {
    manifest = JSON.parse(readStrictBoundedFile(manifestFile, fs));
  } catch {
    throw new Error('package.json must contain valid bounded JSON');
  }
  const [manager, managerSource] = packageManager(files);
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const framework = Object.hasOwn(dependencies, 'next') ? 'nextjs' : 'other';
  const language = Object.hasOwn(dependencies, 'typescript') || files.has('next.config.ts') ? 'typescript' : 'javascript';
  const registry = commandRegistry(manifest.scripts ?? {}, manager);
  const inferredName = typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim() : basename(root);
  const nameSource = typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? 'package.json#name' : 'project directory basename';
  const storybook = Object.keys(dependencies).some(name => name === 'storybook' || name.startsWith('@storybook/'))
    || [...files.keys()].some(name => name.startsWith('.storybook/'));
  const playwright = Object.hasOwn(dependencies, '@playwright/test')
    || [...files.keys()].some(name => name.startsWith('playwright.config.'));
  const configMetadata = fs.lstatSync(join(root, '.rivet'), { throwIfNoEntry: false });
  if (configMetadata?.isSymbolicLink()) throw new Error('.rivet must not be a symbolic link');
  const existingConfig = configMetadata !== undefined;
  return {
    root,
    inspectedFiles: [...files.keys()],
    proposal: {
      id: slug(inferredName),
      name: inferredName.slice(0, 120),
      stack: { framework, language, packageManager: manager },
      commands: registry.commands,
    },
    features: { storybook, playwright },
    architectureHints: files.has('AGENTS.md') ? ['AGENTS.md'] : [],
    existingConfig,
    provenance: {
      id: nameSource,
      name: nameSource,
      'stack.framework': 'package.json#dependencies',
      'stack.language': 'package.json#dependencies',
      'stack.packageManager': managerSource,
      'features.storybook': storybook ? 'known Storybook dependency/config filename' : 'known-file allowlist',
      'features.playwright': playwright ? 'known Playwright dependency/config filename' : 'known-file allowlist',
      ...registry.provenance,
    },
  };
}

export { MAX_DISCOVERY_FILE_BYTES };
