#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs';
import { basename, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const MAX_SOURCE_BYTES = 1024 * 1024;
const SAFE_ASSET_NAME = /^(?:\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DIST_CATEGORIES = ['skills', 'agents', 'mandatory', 'governance', 'v2'];
const SOURCE_DIRECTORIES = new Map();
const SOURCE_FILES = new Map();

class BuildFailure extends Error {}

function failBuild(message) {
  throw new BuildFailure(message);
}

function portableKey(value) {
  return value.normalize('NFKC').toLowerCase();
}

function assertSafeAssetName(name) {
  if (
    typeof name !== 'string'
    || name.length < 1
    || name.length > 128
    || name === '.'
    || name === '..'
    || name.normalize('NFKC') !== name
    || /[ .]$/.test(name)
    || WINDOWS_DEVICE_NAME.test(name)
    || !SAFE_ASSET_NAME.test(name)
  ) failBuild(`Unsafe asset name: ${name}`);
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

function sameNode(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function checkedFileStatus(status, label) {
  if (status.isSymbolicLink()) failBuild(`Source contains a symbolic link: ${label}`);
  if (!status.isFile() || status.nlink !== 1n || status.size > BigInt(MAX_SOURCE_BYTES)) {
    failBuild(`Source contains an unsupported entry: ${label}`);
  }
}

function snapshotFile(path, label, { record = true } = {}) {
  let before;
  try { before = lstatSync(path, { bigint: true }); }
  catch { failBuild(`Source is unavailable: ${label}`); }
  checkedFileStatus(before, label);

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    checkedFileStatus(opened, label);
    if (!sameIdentity(before, opened)) failBuild(`Source changed during snapshot: ${label}`);

    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count < 1) failBuild(`Source changed during snapshot: ${label}`);
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, size) !== 0) {
      failBuild(`Source changed during snapshot: ${label}`);
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, afterRead)) failBuild(`Source changed during snapshot: ${label}`);
    let afterPath;
    try { afterPath = lstatSync(path, { bigint: true }); }
    catch { failBuild(`Source changed during snapshot: ${label}`); }
    if (!sameIdentity(opened, afterPath)) failBuild(`Source changed during snapshot: ${label}`);
    if (record) {
      const prior = SOURCE_FILES.get(path);
      if (prior && !sameIdentity(prior.status, opened)) failBuild(`Source changed during snapshot: ${label}`);
      if (!prior) SOURCE_FILES.set(path, Object.freeze({ path, status: opened, label }));
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') failBuild(`Source contains a symbolic link: ${label}`);
    if (error?.code) failBuild(`Source could not be snapshotted: ${label}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function text(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { failBuild(`Source is not valid UTF-8: ${label}`); }
}

function directoryEntries(path, label, { required }) {
  const pathFromRoot = relative(ROOT, path);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    failBuild(`Source family '${label}' is outside the repository root.`);
  }
  const parts = pathFromRoot ? pathFromRoot.split(/[\\/]/) : [];
  const chain = [];
  let current = ROOT;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]);
    let status;
    try { status = lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error?.code === 'ENOENT' && !required) return null;
      if (error?.code === 'ENOENT') failBuild(`Required source family '${label}' is missing.`);
      failBuild(`Source family '${label}' is unavailable.`);
    }
    const componentLabel = index < 0 ? 'repository root' : parts.slice(0, index + 1).join('/');
    if (status.isSymbolicLink()) failBuild(`Source contains a symbolic link: ${componentLabel}`);
    if (!status.isDirectory()) failBuild(`Source contains an unsupported entry: ${componentLabel}`);
    const prior = SOURCE_DIRECTORIES.get(current);
    if (prior && !sameIdentity(prior.status, status)) failBuild(`Source family '${label}' changed during snapshot.`);
    if (!prior) SOURCE_DIRECTORIES.set(current, Object.freeze({ path: current, status, label: componentLabel }));
    chain.push(Object.freeze({ path: current, status, label: componentLabel }));
  }
  let entries;
  try { entries = readdirSync(path).sort((left, right) => left.localeCompare(right)); }
  catch { failBuild(`Source family '${label}' is unavailable.`); }
  return { entries, chain: Object.freeze(chain) };
}

function revalidateDirectories(chain, label) {
  for (const before of chain) {
    let after;
    try { after = lstatSync(before.path, { bigint: true }); }
    catch { failBuild(`Source family '${label}' changed during snapshot.`); }
    if (!sameIdentity(before.status, after)) failBuild(`Source family '${label}' changed during snapshot.`);
  }
}

function revalidateAllSourceDirectories() {
  revalidateDirectories([...SOURCE_DIRECTORIES.values()], 'source tree');
}

function revalidateAllSourceFiles() {
  for (const captured of SOURCE_FILES.values()) {
    let current;
    try { current = lstatSync(captured.path, { bigint: true }); }
    catch { failBuild(`Source changed after snapshot: ${captured.label}`); }
    if (!sameIdentity(captured.status, current)) failBuild(`Source changed after snapshot: ${captured.label}`);
  }
}

function collectMarkdownSources(path, label, { required = false } = {}) {
  const directory = directoryEntries(path, label, { required });
  if (!directory) return {};
  const results = {};
  const names = new Map();
  for (const entry of directory.entries) {
    if (extname(entry) !== '.md' || entry === 'README.md') continue;
    assertSafeAssetName(entry);
    const key = portableKey(basename(entry, '.md'));
    if (names.has(key)) failBuild(`Name collision in ${label}: ${entry}`);
    names.set(key, entry);
    const content = text(snapshotFile(join(path, entry), `${label}/${entry}`), `${label}/${entry}`);
    results[basename(entry, '.md')] = Object.freeze({ content });
  }
  revalidateDirectories(directory.chain, label);
  return results;
}

function collectAssetTree(root, label, { required }) {
  const files = [];
  const identities = new Set();

  function visit(directoryPath, relativeParts, familyRequired) {
    const relativeLabel = relativeParts.join('/') || label;
    const directory = directoryEntries(directoryPath, relativeLabel, { required: familyRequired });
    if (!directory) return;
    const siblingNames = new Map();
    for (const entry of directory.entries) {
      assertSafeAssetName(entry);
      const key = portableKey(entry);
      if (siblingNames.has(key)) failBuild(`Name collision in ${label}: ${entry}`);
      siblingNames.set(key, entry);
      const source = join(directoryPath, entry);
      const pathParts = [...relativeParts, entry];
      const relativePath = pathParts.join('/');
      let status;
      try { status = lstatSync(source, { bigint: true }); }
      catch { failBuild(`Source changed during snapshot: ${label}/${relativePath}`); }
      if (status.isSymbolicLink()) failBuild(`Source contains a symbolic link: ${label}/${relativePath}`);
      if (status.isDirectory()) {
        visit(source, pathParts, true);
        continue;
      }
      checkedFileStatus(status, `${label}/${relativePath}`);
      const identity = `${status.dev}:${status.ino}`;
      if (identities.has(identity)) failBuild(`Source asset collision: ${label}/${relativePath}`);
      identities.add(identity);
      files.push(Object.freeze({
        relativeParts: Object.freeze(pathParts),
        content: snapshotFile(source, `${label}/${relativePath}`),
      }));
    }
    revalidateDirectories(directory.chain, relativeLabel);
  }

  visit(root, [], required);
  return Object.freeze(files);
}

function extractDescription(content) {
  const lines = content.split('\n');
  let headingText = '';
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+)/);
    if (match) { headingText = match[1].trim(); headingIndex = index; break; }
  }
  if (headingIndex === -1) return '';
  let nonBlankCount = 0;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    nonBlankCount += 1;
    if (nonBlankCount > 10) break;
    if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)
      || trimmed.startsWith('```') || trimmed.startsWith('<') || trimmed.startsWith('|')
      || trimmed.startsWith('#')) continue;
    return trimmed.slice(0, 120);
  }
  return headingText.slice(0, 120);
}

function destinationStatus(path, label) {
  let status;
  try { status = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    failBuild(`Destination is unavailable: ${label}`);
  }
  if (status.isSymbolicLink()) failBuild(`Destination contains a symbolic link: ${label}`);
  return status;
}

function validateDestinationTree(root) {
  const rootStatus = destinationStatus(root, 'dist');
  if (!rootStatus) return null;
  if (!rootStatus.isDirectory()) failBuild('Destination dist must be a directory.');
  const manifest = new Map([['', rootStatus]]);

  function visit(path, relativeParts) {
    let entries;
    try { entries = readdirSync(path).sort((left, right) => left.localeCompare(right)); }
    catch { failBuild(`Destination is unavailable: ${relativeParts.join('/') || 'dist'}`); }
    const siblings = new Map();
    for (const entry of entries) {
      assertSafeAssetName(entry);
      const key = portableKey(entry);
      if (siblings.has(key)) failBuild(`Destination name collision: ${[...relativeParts, entry].join('/')}`);
      siblings.set(key, entry);
      const childParts = [...relativeParts, entry];
      const childLabel = childParts.join('/');
      const status = destinationStatus(join(path, entry), childLabel);
      manifest.set(childLabel, status);
      if (status.isDirectory()) visit(join(path, entry), childParts);
      else if (!status.isFile() || status.nlink !== 1n) failBuild(`Destination contains an unsupported entry: ${childLabel}`);
    }
  }
  visit(root, []);
  for (const category of DIST_CATEGORIES) {
    const status = destinationStatus(join(root, category), category);
    if (status && !status.isDirectory()) failBuild(`Destination category '${category}' must be a directory.`);
  }
  return Object.freeze({ rootStatus, manifest });
}

function assertDestinationUnchanged(root, expected) {
  const current = validateDestinationTree(root);
  if (!expected) {
    if (current) failBuild('Destination dist changed before publication.');
    return;
  }
  if (!current || current.manifest.size !== expected.manifest.size) {
    failBuild('Destination dist changed before publication.');
  }
  for (const [path, status] of expected.manifest) {
    if (!current.manifest.has(path) || !sameIdentity(status, current.manifest.get(path))) {
      failBuild('Destination dist changed before publication.');
    }
  }
}

function ensureStageDirectory(relativeParts) {
  let current = '';
  for (const part of relativeParts) {
    assertSafeAssetName(part);
    current = current ? join(current, part) : part;
    let status;
    try { status = lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error?.code !== 'ENOENT') failBuild('Private staging is unavailable.');
      try { mkdirSync(current); }
      catch { failBuild('Private staging could not be created.'); }
      status = lstatSync(current, { bigint: true });
    }
    if (status.isSymbolicLink() || !status.isDirectory()) failBuild('Private staging topology changed.');
  }
}

function exclusiveStageWrite(relativeParts, content, expectedFiles) {
  ensureStageDirectory(relativeParts.slice(0, -1));
  const relativePath = relativeParts.join('/');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let descriptor;
  try {
    descriptor = openSync(
      join(...relativeParts),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written < 1) failBuild('Private staging leaf changed during write.');
      offset += written;
    }
    const status = fstatSync(descriptor, { bigint: true });
    if (!status.isFile() || status.nlink !== 1n || status.size !== BigInt(bytes.length)) {
      failBuild('Private staging leaf changed during write.');
    }
  } catch (error) {
    if (error instanceof BuildFailure) throw error;
    failBuild(`Private staging write failed: ${relativePath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  expectedFiles.set(relativePath, bytes);
}

function writeGeneratedCategory(name, sources, label, expectedFiles) {
  ensureStageDirectory([name]);
  for (const sourceName of Object.keys(sources).sort((left, right) => left.localeCompare(right))) {
    const content = sources[sourceName].content;
    const frontmatter = `---\nname: rivet-${sourceName}\ndescription: ${JSON.stringify(extractDescription(content))}\n---\n\n`;
    exclusiveStageWrite([name, sourceName, 'SKILL.md'], frontmatter + content, expectedFiles);
    console.log(`  ${label}: ${sourceName}`);
  }
}

function writeAssetTree(files, destinationParts, expectedFiles) {
  for (const file of files) {
    exclusiveStageWrite([...destinationParts, ...file.relativeParts], file.content, expectedFiles);
  }
}

function removeOwnedTree(path, expectedStatus) {
  let current;
  try { current = lstatSync(path, { bigint: true }); }
  catch (error) { return error?.code === 'ENOENT'; }
  if (!sameNode(current, expectedStatus) || !current.isDirectory()) return false;
  try { rmSync(path, { recursive: true, force: false }); }
  catch { return false; }
  return true;
}

function verifyPublishedTree(root, publishedStatus, expectedFiles) {
  const current = validateDestinationTree(root);
  if (!current || !sameNode(current.rootStatus, publishedStatus)) failBuild('Published dist identity changed.');
  const actualFiles = [...current.manifest]
    .filter(([, status]) => status.isFile())
    .map(([path]) => path)
    .sort((left, right) => left.localeCompare(right));
  const expectedPaths = [...expectedFiles.keys()].sort((left, right) => left.localeCompare(right));
  if (actualFiles.length !== expectedPaths.length
    || actualFiles.some((path, index) => path !== expectedPaths[index])) {
    failBuild('Published dist content is incomplete.');
  }
  for (const path of expectedPaths) {
    const bytes = snapshotFile(join(root, ...path.split('/')), `published dist/${path}`, { record: false });
    if (!bytes.equals(expectedFiles.get(path))) failBuild('Published dist content changed.');
  }
  const after = destinationStatus(root, 'dist');
  if (!after || !sameNode(after, publishedStatus)) failBuild('Published dist identity changed.');
}

function createStagedTree(writeTree) {
  let stagePath;
  let stageStatus;
  try { stagePath = mkdtempSync(join(ROOT, '.dist-stage-')); }
  catch { failBuild('Private staging could not be created.'); }
  try {
    stageStatus = lstatSync(stagePath, { bigint: true });
    if (!stageStatus.isDirectory() || stageStatus.isSymbolicLink()) failBuild('Private staging is unavailable.');
    const originalCwd = process.cwd();
    try {
      process.chdir(stagePath);
      const pinned = statSync('.', { bigint: true });
      if (!sameNode(stageStatus, pinned)) failBuild('Private staging identity changed.');
      for (const category of DIST_CATEGORIES) ensureStageDirectory([category]);
      writeTree();
      const after = statSync('.', { bigint: true });
      if (!sameNode(stageStatus, after)) failBuild('Private staging identity changed.');
    } finally {
      process.chdir(originalCwd);
    }
    const staged = validateDestinationTree(stagePath);
    if (!staged || !sameNode(stageStatus, staged.rootStatus)) failBuild('Private staging identity changed.');
    return Object.freeze({ path: stagePath, status: stageStatus });
  } catch (error) {
    if (stageStatus) removeOwnedTree(stagePath, stageStatus);
    throw error;
  }
}

function restoreOwnedBackup(distRoot, backupPath, backupStatus) {
  if (!backupPath) return;
  let dist;
  try { dist = lstatSync(distRoot, { bigint: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') return;
  }
  if (dist) return;
  let backup;
  try { backup = lstatSync(backupPath, { bigint: true }); }
  catch { return; }
  if (!sameNode(backup, backupStatus)) return;
  try { renameSync(backupPath, distRoot); }
  catch {}
}

function publishStagedTree(distRoot, originalDist, stage, expectedFiles, rootStatus) {
  const rootNow = lstatSync(ROOT, { bigint: true });
  if (!sameNode(rootStatus, rootNow)) failBuild('Repository root changed before publication.');
  assertDestinationUnchanged(distRoot, originalDist);

  let backupPath;
  let backupStatus;
  if (originalDist) {
    let reservation;
    try {
      backupPath = mkdtempSync(join(ROOT, '.dist-backup-'));
      reservation = lstatSync(backupPath, { bigint: true });
    } catch { failBuild('Destination backup could not be reserved.'); }
    if (!removeOwnedTree(backupPath, reservation)) failBuild('Destination backup reservation changed.');
    assertDestinationUnchanged(distRoot, originalDist);
    try { renameSync(distRoot, backupPath); }
    catch { failBuild('Destination dist changed during publication.'); }
    backupStatus = lstatSync(backupPath, { bigint: true });
    if (!sameNode(originalDist.rootStatus, backupStatus)) {
      restoreOwnedBackup(distRoot, backupPath, backupStatus);
      failBuild('Destination dist changed during publication.');
    }
  }

  try {
    if (destinationStatus(distRoot, 'dist')) failBuild('Destination dist changed during publication.');
    renameSync(stage.path, distRoot);
    const publishedStatus = lstatSync(distRoot, { bigint: true });
    if (!sameNode(stage.status, publishedStatus)) failBuild('Published dist identity changed.');
    verifyPublishedTree(distRoot, publishedStatus, expectedFiles);
    if (backupPath && !removeOwnedTree(backupPath, backupStatus)) {
      failBuild('Destination backup identity changed before cleanup.');
    }
  } catch (error) {
    let publicStatus;
    try { publicStatus = lstatSync(distRoot, { bigint: true }); }
    catch {}
    if (publicStatus && sameNode(publicStatus, stage.status)) {
      try { renameSync(distRoot, stage.path); }
      catch {}
    }
    restoreOwnedBackup(distRoot, backupPath, backupStatus);
    throw error;
  }
}

function build() {
  let rootStatus;
  try { rootStatus = lstatSync(ROOT, { bigint: true }); }
  catch { failBuild('Repository root is unavailable.'); }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) failBuild('Repository root is unsafe.');

  const skills = collectMarkdownSources(join(ROOT, 'optional', 'skills'), 'optional/skills');
  const agents = collectMarkdownSources(join(ROOT, 'optional', 'agents'), 'optional/agents');
  const mandatory = collectMarkdownSources(join(ROOT, 'mandatory', 'skills'), 'mandatory/skills');
  const governance = collectMarkdownSources(join(ROOT, 'optional', 'governance'), 'optional/governance');
  const v2Assets = Object.freeze({
    protocols: collectAssetTree(join(ROOT, 'protocols'), 'protocols', { required: true }),
    schemas: collectAssetTree(join(ROOT, 'schemas'), 'schemas', { required: true }),
    templates: collectAssetTree(join(ROOT, 'templates'), 'templates', { required: true }),
  });
  const allNames = [
    ...Object.keys(skills).map(name => ({ name, source: 'optional/skills/' })),
    ...Object.keys(agents).map(name => ({ name, source: 'optional/agents/' })),
    ...Object.keys(mandatory).map(name => ({ name, source: 'mandatory/skills/' })),
  ];
  const seen = new Map();
  const collisions = [];
  for (const { name, source } of allNames) {
    const key = portableKey(name);
    if (seen.has(key)) collisions.push(`  ${name}.md (${seen.get(key)} and ${source})`);
    else seen.set(key, source);
  }
  if (collisions.length > 0) {
    failBuild(`Name collisions detected:\n${collisions.join('\n')}\nRename one of the conflicting files before building.`);
  }

  const distRoot = join(ROOT, 'dist');
  const originalDist = validateDestinationTree(distRoot);
  const expectedFiles = new Map();
  let stage;
  let published = false;
  try {
    revalidateAllSourceDirectories();
    revalidateAllSourceFiles();
    stage = createStagedTree(() => {
      writeGeneratedCategory('skills', skills, 'skill', expectedFiles);
      writeGeneratedCategory('agents', agents, 'agent', expectedFiles);
      writeGeneratedCategory('mandatory', mandatory, 'mandatory', expectedFiles);

      for (const name of Object.keys(governance).sort((left, right) => left.localeCompare(right))) {
        const filename = `${name}.md`;
        exclusiveStageWrite(['governance', filename], governance[name].content, expectedFiles);
        console.log(`  governance: ${filename}`);
      }

      for (const category of Object.keys(v2Assets).sort()) {
        writeAssetTree(v2Assets[category], ['v2', category], expectedFiles);
        console.log(`  v2 ${category}: ${v2Assets[category].length}`);
      }
    });
    publishStagedTree(distRoot, originalDist, stage, expectedFiles, rootStatus);
    published = true;
  } finally {
    if (!published && stage) removeOwnedTree(stage.path, stage.status);
  }

  console.log(`\nDone. ${Object.keys(mandatory).length} mandatory + ${Object.keys(skills).length} skills + ${Object.keys(agents).length} agents + ${Object.keys(governance).length} governance files written to dist/`);
}

try {
  build();
} catch (error) {
  console.error(`ERROR: ${error instanceof BuildFailure ? error.message : 'Build failed.'}`);
  process.exitCode = 1;
}
