import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, realpath, readdir, rm, writeFile, link } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@agilno/rivet';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT = 64 * 1024 * 1024;
const MANIFEST = 'release-manifest.json';
const SUMS = 'SHA256SUMS';
export class ReleaseArtifactError extends Error {
  constructor(reason) { super(`Release artifact stopped: ${reason}.`); this.code = `ERR_RELEASE_${reason.replaceAll('-', '_').toUpperCase()}`; }
}
function requireValue(condition, reason = 'invalid-input') { if (!condition) throw new ReleaseArtifactError(reason); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function tagVersion(tag) { requireValue(typeof tag === 'string' && tag.startsWith('v') && VERSION.test(tag.slice(1)), 'invalid-prerelease-tag'); return tag.slice(1); }
function filename(version) { return `agilno-rivet-${version}.tgz`; }
function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
async function regularFile(path, limit, allowEmpty = false) {
  const before = await lstat(path, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && (allowEmpty || before.size > 0n) && before.size <= BigInt(limit), 'unsafe-file');
  const handle = await open(path, 'r');
  try {
    requireValue(identity(await handle.stat({ bigint: true })) === identity(before), 'changed-file');
    const bytes = await handle.readFile();
    requireValue(bytes.length <= limit && identity(await handle.stat({ bigint: true })) === identity(before) && identity(await lstat(path, { bigint: true })) === identity(before), 'changed-file');
    return bytes;
  } finally { await handle.close(); }
}
function parseJson(bytes) { try { return JSON.parse(bytes); } catch { throw new ReleaseArtifactError('invalid-json'); } }
function exactKeys(value, keys) { requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid-manifest'); }
function command(executable, args, cwd, env) {
  try { return execFileSync(executable, args, { cwd, env, shell: false, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new ReleaseArtifactError('local-command-failed'); }
}
function environment(scratch) {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    npm_config_cache: join(scratch, 'cache'), npm_config_userconfig: join(scratch, 'user.npmrc'), npm_config_globalconfig: join(scratch, 'global.npmrc'), npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' };
}
function git(args, sourceRoot, env) { return command('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', ...args], sourceRoot, env); }
async function packingSnapshot(sourceRoot, snapshotRoot, commit, env) {
  // Status/index flags are not evidence of file contents. Bind each snapshot
  // byte to the unreplaced commit tree; npm never reads the working checkout.
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', commit], sourceRoot, env).split('\0').filter(Boolean);
  const tracked = new Set(); let totalBytes = 0;
  await mkdir(snapshotRoot);
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    requireValue(match, 'unsupported-source-entry');
    const [, mode, blob, path] = match;
    requireValue(!isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git'), 'unsafe-source-path');
    const sourcePath = join(sourceRoot, path);
    // A symlinked parent must not redirect reads outside the source checkout.
    requireValue(await realpath(sourcePath) === sourcePath, 'unsafe-source-path');
    const bytes = await regularFile(sourcePath, MAX_ARTIFACT, true);
    totalBytes += bytes.length; requireValue(totalBytes <= 256 * 1024 * 1024, 'source-size-limit');
    const actualBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    requireValue(actualBlob === blob, 'source-blob-mismatch');
    const target = join(snapshotRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
    tracked.add(path);
  }
  return tracked;
}
async function inspectSource(sourceRoot, tag, expectedSourceSha, env) {
  requireValue(git(['rev-parse', '--show-toplevel'], sourceRoot, env).trim() === sourceRoot, 'source-must-be-repository-root');
  requireValue(git(['rev-parse', '--verify', 'HEAD'], sourceRoot, env).trim() === expectedSourceSha, 'source-revision-mismatch');
  requireValue(git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], sourceRoot, env).trim() === expectedSourceSha, 'tag-revision-mismatch');
  requireValue(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], sourceRoot, env) === '', 'dirty-source');
  const packageBytes = await regularFile(join(sourceRoot, 'package.json'), 1024 * 1024);
  const lockBytes = await regularFile(join(sourceRoot, 'package-lock.json'), 4 * 1024 * 1024);
  const pkg = parseJson(packageBytes), lock = parseJson(lockBytes);
  requireValue(pkg.name === PACKAGE_NAME && pkg.private === true && pkg.license === 'UNLICENSED', 'package-identity-mismatch');
  requireValue(pkg.version === tagVersion(tag), 'package-version-mismatch');
  // npm 10 can still run prepare despite --ignore-scripts during pack. The
  // candidate has no packaging hooks; reject their addition before calling npm.
  requireValue(!['prepack', 'prepare', 'postpack'].some(name => Object.hasOwn(pkg.scripts ?? {}, name)), 'pack-lifecycle-hooks-unsupported');
  requireValue(lock.name === pkg.name && lock.version === pkg.version && lock.packages?.['']?.name === pkg.name && lock.packages[''].version === pkg.version, 'lockfile-identity-mismatch');
  return { package: { name: pkg.name, version: pkg.version, private: true, license: pkg.license }, packageSha256: hash(packageBytes), lockfileSha256: hash(lockBytes) };
}
function checksumText(manifest, manifestBytes) { return `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n${hash(manifestBytes)}  ${MANIFEST}\n`; }
function validateManifest(value) {
  exactKeys(value, ['schemaVersion', 'package', 'source', 'artifact', 'packageSha256', 'lockfileSha256', 'build', 'qualification']);
  requireValue(value.schemaVersion === 1, 'invalid-manifest');
  exactKeys(value.package, ['name', 'version', 'private', 'license']);
  requireValue(value.package.name === PACKAGE_NAME && value.package.private === true && value.package.license === 'UNLICENSED', 'package-identity-mismatch');
  exactKeys(value.source, ['commit', 'tag']);
  requireValue(SHA.test(value.source.commit) && tagVersion(value.source.tag) === value.package.version, 'source-identity-mismatch');
  exactKeys(value.artifact, ['filename', 'sha256', 'bytes']);
  requireValue(value.artifact.filename === filename(value.package.version) && DIGEST.test(value.artifact.sha256) && Number.isSafeInteger(value.artifact.bytes) && value.artifact.bytes > 0 && value.artifact.bytes <= MAX_ARTIFACT, 'invalid-artifact');
  requireValue(DIGEST.test(value.packageSha256) && DIGEST.test(value.lockfileSha256), 'invalid-manifest');
  exactKeys(value.build, ['node', 'npm', 'platform', 'architecture']);
  for (const item of Object.values(value.build)) requireValue(typeof item === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(item), 'invalid-manifest');
  exactKeys(value.qualification, ['candidateChecks', 'publishedChannel', 'independentPilot']);
  requireValue(value.qualification.candidateChecks === 'external-evidence-required' && value.qualification.publishedChannel === 'not-tested' && value.qualification.independentPilot === 'not-evaluated', 'unsupported-qualification');
  return value;
}
export async function createReleaseArtifact({ sourceRoot, outputDirectory, tag, expectedSourceSha }) {
  requireValue(['darwin', 'linux'].includes(process.platform), 'unsupported-platform');
  requireValue(Number(process.versions.node.split('.')[0]) >= 22, 'unsupported-node');
  requireValue(typeof sourceRoot === 'string' && isAbsolute(sourceRoot) && typeof outputDirectory === 'string' && isAbsolute(outputDirectory));
  tagVersion(tag); requireValue(SHA.test(expectedSourceSha), 'invalid-source-revision');
  requireValue(await realpath(sourceRoot) === sourceRoot, 'noncanonical-source');
  const parent = dirname(outputDirectory);
  requireValue(await realpath(parent) === parent && resolve(outputDirectory) === outputDirectory, 'noncanonical-output');
  const within = relative(sourceRoot, outputDirectory);
  requireValue(within === '..' || within.startsWith('../') || isAbsolute(within), 'output-inside-source');
  requireValue(await lstat(outputDirectory).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }), 'output-exists');
  const scratch = await mkdtemp(join(parent, '.rivet-artifact-'));
  const scratchIdentity = await lstat(scratch);
  try {
    const env = environment(scratch);
    const source = await inspectSource(sourceRoot, tag, expectedSourceSha, env);
    const npmCli = await realpath(join(dirname(process.execPath), 'npm'));
    const npmRelative = relative(sourceRoot, npmCli);
    requireValue(npmRelative === '..' || npmRelative.startsWith('../') || isAbsolute(npmRelative), 'project-local-npm');
    requireValue((await lstat(npmCli)).isFile(), 'invalid-npm-executable');
    const snapshotRoot = join(scratch, 'source');
    const tracked = await packingSnapshot(sourceRoot, snapshotRoot, expectedSourceSha, env);
    requireValue(hash(await regularFile(join(snapshotRoot, 'package.json'), 1024 * 1024)) === source.packageSha256
      && hash(await regularFile(join(snapshotRoot, 'package-lock.json'), 4 * 1024 * 1024)) === source.lockfileSha256, 'source-changed-during-pack');
    const npm = args => command(process.execPath, [npmCli, ...args], snapshotRoot, env);
    const npmVersion = npm(['--version']).trim();
    requireValue(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(npmVersion), 'invalid-npm-version');
    // Exactly one offline pack. Packaging hooks were rejected above.
    const packed = parseJson(npm(['pack', '.', '--workspaces=false', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch]));
    requireValue(Array.isArray(packed) && packed.length === 1 && packed[0].name === PACKAGE_NAME && packed[0].version === source.package.version && packed[0].filename === filename(source.package.version), 'invalid-pack-result');
    requireValue(Array.isArray(packed[0].files) && packed[0].files.some(file => file.path === 'bin/cli.js') && packed[0].files.every(file => typeof file.path === 'string' && tracked.has(file.path)) && !packed[0].files.some(file => /(?:^|\/)(?:\.git|node_modules|test|tests|evals|plans|\.env|\.npmrc)(?:\/|$)/.test(file.path)), 'invalid-pack-contents');
    const artifactPath = join(scratch, packed[0].filename);
    const artifactBytes = await regularFile(artifactPath, MAX_ARTIFACT);
    const after = await inspectSource(sourceRoot, tag, expectedSourceSha, env);
    requireValue(JSON.stringify(after) === JSON.stringify(source), 'source-changed-during-pack');
    const manifest = validateManifest({ schemaVersion: 1, ...source, source: { commit: expectedSourceSha, tag },
      artifact: { filename: packed[0].filename, sha256: hash(artifactBytes), bytes: artifactBytes.length },
      build: { node: process.version, npm: npmVersion, platform: process.platform, architecture: process.arch },
      qualification: { candidateChecks: 'external-evidence-required', publishedChannel: 'not-tested', independentPilot: 'not-evaluated' } });
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(scratch, MANIFEST), manifestBytes, { flag: 'wx', mode: 0o644 });
    await writeFile(join(scratch, SUMS), checksumText(manifest, manifestBytes), { flag: 'wx', mode: 0o644 });
    // mkdir is the exclusive reservation. Never replace any existing destination.
    // If publication fails afterward, retain partial output for explicit inspection.
    await mkdir(outputDirectory, { mode: 0o755 });
    for (const name of [manifest.artifact.filename, SUMS, MANIFEST]) await link(join(scratch, name), join(outputDirectory, name));
    return manifest;
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    throw new ReleaseArtifactError('filesystem-operation-failed');
  } finally {
    const current = await lstat(scratch).catch(() => null);
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino) await rm(scratch, { recursive: true, force: true });
  }
}
export async function verifyReleaseArtifact({ directory, expectedSourceSha, tag, expectedArtifactSha256 }) {
  requireValue(typeof directory === 'string' && isAbsolute(directory));
  requireValue(await realpath(directory) === directory, 'noncanonical-output');
  if (expectedSourceSha !== undefined) requireValue(SHA.test(expectedSourceSha), 'invalid-source-revision');
  if (tag !== undefined) tagVersion(tag);
  if (expectedArtifactSha256 !== undefined) requireValue(DIGEST.test(expectedArtifactSha256), 'invalid-digest');
  const manifestBytes = await regularFile(join(directory, MANIFEST), 65536);
  const manifest = validateManifest(parseJson(manifestBytes));
  requireValue(expectedSourceSha === undefined || manifest.source.commit === expectedSourceSha, 'source-revision-mismatch');
  requireValue(tag === undefined || manifest.source.tag === tag, 'tag-revision-mismatch');
  const actualFiles = (await readdir(directory)).sort();
  requireValue(JSON.stringify(actualFiles) === JSON.stringify([manifest.artifact.filename, MANIFEST, SUMS].sort()), 'unexpected-output-files');
  const artifact = await regularFile(join(directory, manifest.artifact.filename), MAX_ARTIFACT);
  requireValue(artifact.length === manifest.artifact.bytes && hash(artifact) === manifest.artifact.sha256 && (expectedArtifactSha256 === undefined || hash(artifact) === expectedArtifactSha256), 'artifact-checksum-mismatch');
  const checksums = await regularFile(join(directory, SUMS), 1024);
  requireValue(checksums.toString('utf8') === checksumText(manifest, manifestBytes), 'checksum-manifest-mismatch');
  return manifest;
}
export function parseReleaseArguments(args) {
  const [command, ...flags] = args; requireValue(['build', 'verify'].includes(command));
  const allowed = command === 'build' ? ['source', 'out', 'tag', 'sha'] : ['directory', 'tag', 'sha', 'artifact-sha256'];
  const values = {};
  for (const flag of flags) {
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(flag);
    requireValue(match && allowed.includes(match[1]) && !Object.hasOwn(values, match[1])); values[match[1]] = match[2];
  }
  requireValue((command === 'build' ? allowed : ['directory']).every(key => Object.hasOwn(values, key)));
  if (values.tag !== undefined) tagVersion(values.tag);
  if (values.sha !== undefined) requireValue(SHA.test(values.sha));
  return { command, ...values };
}
async function main() {
  try {
    const args = parseReleaseArguments(process.argv.slice(2));
    const result = args.command === 'build'
      ? await createReleaseArtifact({ sourceRoot: args.source, outputDirectory: args.out, tag: args.tag, expectedSourceSha: args.sha })
      : await verifyReleaseArtifact({ directory: args.directory, tag: args.tag, expectedSourceSha: args.sha, expectedArtifactSha256: args['artifact-sha256'] });
    console.log(JSON.stringify({ ok: true, manifest: result }));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error instanceof ReleaseArtifactError ? error.code : 'ERR_RELEASE_INVALID_ENVIRONMENT' })); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
