import * as filesystem from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_DISCOVERY_FILE_BYTES = 256 * 1024;
const MAX_DISCOVERY_AGGREGATE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 256;
const MAX_DISCOVERY_MANIFESTS = 64;
const LOCK_FILES = Object.freeze([
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
]);
const IGNORED_CHILD_DIRECTORIES = new Set([
  '.git', '.next', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'generated',
]);
const OPTIONAL_FILES = Object.freeze([
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts',
  'AGENTS.md', 'CLAUDE.md', 'README.md',
  '.storybook/main.js', '.storybook/main.mjs', '.storybook/main.ts',
  '.github/copilot-instructions.md',
]);

export class ProjectDiscoveryError extends Error {
  constructor(code, details = {}) {
    super(code === 'PACKAGE_MANAGER_CONFLICT'
      ? 'Conflicting package-manager evidence was detected.'
      : 'Project discovery failed safely.');
    this.name = 'ProjectDiscoveryError';
    this.code = code;
    this.details = Object.freeze({ code, ...details });
  }
}

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

function safeLockfilePresence(root, relativePath, fs) {
  const components = relativePath.split('/');
  let path = root;
  for (let index = 0; index < components.length; index += 1) {
    path = join(path, components[index]);
    const metadata = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!metadata) return false;
    if (metadata.isSymbolicLink()) throw new Error('Package-manager evidence must not use symbolic links');
    const canonical = fs.realpathSync(path);
    if (!isWithin(root, canonical) || !sameIdentity(metadata, fs.statSync(canonical))) {
      throw new Error('Package-manager evidence changed identity');
    }
    if (index < components.length - 1) {
      if (!metadata.isDirectory()) throw new Error('Package-manager evidence has a non-directory ancestor');
    } else if (!metadata.isFile()) {
      throw new Error('Package-manager evidence must be a regular file');
    }
  }
  return true;
}

function managerEvidence(root, packagePaths, fs, inspectedFiles) {
  const evidence = [];
  for (const packagePath of packagePaths) {
    for (const [filename, manager] of LOCK_FILES) {
      const relativePath = packagePath === '.' ? filename : `${packagePath}/${filename}`;
      if (safeLockfilePresence(root, relativePath, fs)) {
        evidence.push({ manager, relativePath });
        inspectedFiles.add(relativePath);
      }
    }
  }
  const managers = [...new Set(evidence.map(item => item.manager))];
  if (managers.length > 1) {
    throw new ProjectDiscoveryError('PACKAGE_MANAGER_CONFLICT', { managers: managers.sort() });
  }
  return managers.length === 1
    ? [managers[0], evidence.find(item => item.manager === managers[0]).relativePath]
    : ['npm', 'package.json'];
}

function scriptsFor(manifest) {
  return manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
    ? manifest.scripts : {};
}

function scriptFor(scripts, logicalId) {
  if (typeof scripts[logicalId] === 'string') return logicalId;
  if (logicalId === 'typecheck' && typeof scripts['type-check'] === 'string') return 'type-check';
  return null;
}

function commandRegistry(packages, manager) {
  const commands = {};
  const provenance = {};
  const unresolved = [];
  const warnings = [];
  const root = packages[0];
  let structured = false;
  for (const key of ['build', 'test', 'lint', 'typecheck']) {
    const rootScript = scriptFor(root.scripts, key);
    let selected = rootScript ? [{ packagePath: '.', script: rootScript }] : packages.slice(1)
      .map(item => ({ packagePath: item.path, script: scriptFor(item.scripts, key) }))
      .filter(item => item.script !== null);
    if (selected.length === 0 && (key === 'build' || key === 'test')) {
      selected = [{ packagePath: '.', script: key, unresolved: true }];
      unresolved.push({ command: key, reason: 'no-script-in-supported-scope' });
    }
    if (selected.length === 0) continue;
    if (selected.some(item => item.packagePath !== '.')) structured = true;
    commands[key] = selected.map(item => ({
      cwd: item.packagePath,
      argv: [manager, 'run', item.script],
      unresolved: item.unresolved === true,
    }));
  }
  for (const item of packages.slice(1)) {
    const hasCoverageCandidate = scriptFor(item.scripts, 'build') || scriptFor(item.scripts, 'typecheck');
    if (hasCoverageCandidate && !scriptFor(item.scripts, 'test')) {
      warnings.push({
        code: 'package-missing-test',
        package: item.path,
        message: `Package '${item.path}' has build/typecheck coverage but no test script.`,
      });
    }
  }
  const serialized = {};
  for (const [key, steps] of Object.entries(commands)) {
    if (structured) {
      serialized[key] = { steps: steps.map(({ cwd, argv }) => ({ cwd, argv })) };
      steps.forEach((step, index) => {
        provenance[`commands.${key}.steps[${index}]`] = step.unresolved
          ? 'safe-default (script availability requires review)'
          : `${step.cwd === '.' ? '' : `${step.cwd}/`}package.json#scripts.${step.argv[2]}`;
      });
    } else {
      serialized[key] = steps[0].argv;
      provenance[`commands.${key}`] = steps[0].unresolved
        ? 'safe-default (script availability requires review)'
        : 'package.json#scripts';
    }
  }
  if (!structured && typeof root.scripts.dev === 'string') {
    serialized.dev = [manager, 'run', 'dev'];
    provenance['commands.dev'] = 'package.json#scripts.dev';
  }
  return { schemaVersion: structured ? 2 : 1, commands: serialized, provenance, unresolved, warnings };
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
  const entries = fs.readdirSync(root);
  if (!Array.isArray(entries) || entries.length > MAX_DISCOVERY_ENTRIES) {
    throw new Error('Project discovery entry limit exceeded');
  }
  const packageFiles = [{ path: '.', file: manifestFile }];
  for (const name of [...entries].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    if (name.startsWith('.') || IGNORED_CHILD_DIRECTORIES.has(name)) continue;
    const metadata = fs.lstatSync(join(root, name), { throwIfNoEntry: false });
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    const canonical = fs.realpathSync(join(root, name));
    if (!isWithin(root, canonical) || !sameIdentity(metadata, fs.statSync(canonical))) {
      throw new Error('Child package directory changed identity');
    }
    const childManifest = safeFile(root, `${name}/package.json`, fs);
    if (childManifest) packageFiles.push({ path: name, file: childManifest });
  }
  if (packageFiles.length > MAX_DISCOVERY_MANIFESTS) throw new Error('Project discovery manifest limit exceeded');
  if (packageFiles.reduce((total, item) => total + item.file.size, 0) > MAX_DISCOVERY_AGGREGATE_BYTES) {
    throw new Error('Project discovery aggregate read limit exceeded');
  }
  const packages = [];
  for (const item of packageFiles) {
    let parsed;
    try { parsed = JSON.parse(readStrictBoundedFile(item.file, fs)); }
    catch { throw new Error(`${item.path === '.' ? '' : `${item.path}/`}package.json must contain valid bounded JSON`); }
    packages.push({ path: item.path, manifest: parsed, scripts: scriptsFor(parsed) });
    files.set(item.path === '.' ? 'package.json' : `${item.path}/package.json`, item.file);
  }
  const manifest = packages[0].manifest;
  const inspectedFiles = new Set(files.keys());
  const [manager, managerSource] = managerEvidence(root, packages.map(item => item.path), fs, inspectedFiles);
  const dependencies = Object.assign({}, ...packages.map(item => ({
    ...(item.manifest.dependencies ?? {}), ...(item.manifest.devDependencies ?? {}),
  })));
  const framework = Object.hasOwn(dependencies, 'next') ? 'nextjs' : 'other';
  const language = Object.hasOwn(dependencies, 'typescript') || files.has('next.config.ts') ? 'typescript' : 'javascript';
  const registry = commandRegistry(packages, manager);
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
    inspectedFiles: [...inspectedFiles].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    proposal: {
      schemaVersion: registry.schemaVersion,
      id: slug(inferredName),
      name: inferredName.slice(0, 120),
      stack: { framework, language, packageManager: manager },
      commands: registry.commands,
    },
    features: { storybook, playwright },
    architectureHints: files.has('AGENTS.md') ? ['AGENTS.md'] : [],
    existingConfig,
    warnings: registry.warnings,
    unresolved: registry.unresolved,
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

export {
  MAX_DISCOVERY_AGGREGATE_BYTES,
  MAX_DISCOVERY_ENTRIES,
  MAX_DISCOVERY_FILE_BYTES,
  MAX_DISCOVERY_MANIFESTS,
};
