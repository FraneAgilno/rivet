import { reference, runtimeSkill } from './project-reference.js';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { CliError, EXIT_CODES } from '../cli/output.js';
import {
  createMutationGuard,
  ensureContainedDirectory,
  findProjectRoot,
  withPinnedTargetDirectory,
} from '../commands/install.js';

const MANIFEST_NAME = '.rivet-install.json';
const SKILL_NAME = 'SKILL.md';
const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = '@agilno/rivet';

function conflict(message, cause) {
  return new CliError(message, 'REPOSITORY_CONFLICT', cause ? { cause } : {});
}

function lstatIfExists(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function identity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRegularFile(path, fs, { maxBytes, label, missing = false }) {
  const before = lstatIfExists(path, fs);
  if (!before) {
    if (missing) return null;
    throw new CliError(`${label} is missing.`, 'MISSING_CONFIGURATION');
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw conflict(`${label} is not a safe regular file.`);
  }

  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes || !sameIdentity(identity(before), identity(opened))) {
      throw conflict(`${label} changed during validation.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = lstatIfExists(path, fs);
    if (!after || !sameIdentity(identity(opened), identity(after))) {
      throw conflict(`${label} changed during validation.`);
    }
    return { bytes, identity: identity(opened), hash: sha256(bytes) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw conflict(`Could not safely read ${label}.`, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readSource(dependencies, projectRoot) {
  const { fs, packageRoot } = dependencies;
  let metadata;
  try {
    const packageFile = readRegularFile(join(packageRoot, 'package.json'), fs, {
      maxBytes: MAX_PACKAGE_BYTES,
      label: 'Rivet package metadata',
    });
    metadata = JSON.parse(packageFile.bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Rivet package metadata is invalid.', 'MISSING_CONFIGURATION', { cause: error });
  }
  if (
    metadata?.name !== PACKAGE_NAME
    || typeof metadata.version !== 'string'
    || metadata.version.length < 1
    || metadata.version.length > 128
  ) {
    throw new CliError('Rivet package metadata is invalid.', 'MISSING_CONFIGURATION');
  }
  const skill = readRegularFile(join(packageRoot, 'templates', 'harness', SKILL_NAME), fs, {
    maxBytes: MAX_SKILL_BYTES,
    label: 'Rivet harness skill template',
  });
  const pinned = projectRoot ? reference(projectRoot, fs) : null;
  const skillBytes = dependencies.managedSkillBytes ?? (pinned ? runtimeSkill(skill.bytes, pinned.id) : skill.bytes);
  if (!Buffer.isBuffer(skillBytes) || skillBytes.length > MAX_SKILL_BYTES) throw conflict('Managed skill source is invalid.');
  return Object.freeze({
    package: Object.freeze({ name: PACKAGE_NAME, version: metadata.version }),
    skillBytes,
    skillHash: sha256(skillBytes),
  });
}

function selectedTargets(flags) {
  if (flags.claude && flags.codex) return ['claude', 'codex'];
  if (flags.claude) return ['claude'];
  if (flags.codex) return ['codex'];
  const requested = typeof flags.target === 'string' ? flags.target.toLowerCase() : flags.target;
  if (requested === undefined || requested === 'both') return ['claude', 'codex'];
  if (requested === 'claude' || requested === 'codex') return [requested];
  throw new CliError("Invalid --target value. Use 'claude', 'codex', or 'both'.", 'INVALID_INPUT');
}

function projectScope(parsed, dependencies) {
  const { fs } = dependencies;
  if (parsed.flags.global) return null;

  if (parsed.flags.project !== undefined) {
    if (typeof parsed.flags.project !== 'string' || parsed.flags.project.length === 0) {
      throw new CliError('The --project value must be a directory path.', 'INVALID_INPUT');
    }
    const root = resolve(dependencies.cwd(), parsed.flags.project);
    const status = lstatIfExists(root, fs);
    if (!status || status.isSymbolicLink() || !status.isDirectory()) {
      throw new CliError('The selected project must be an existing regular directory.', 'INVALID_INPUT');
    }
    return root;
  }

  const discovered = findProjectRoot(dependencies.cwd(), fs);
  if (!discovered) {
    throw new CliError(
      'Could not find project root (no .git or package.json found in any parent directory).\nRun from inside a project, pass --project, or use --global.',
      'INVALID_INPUT',
    );
  }
  return discovered;
}

function targetLocation(target, parsed, dependencies, projectRoot) {
  const global = parsed.flags.global === true;
  const scopeRoot = global ? resolve(dependencies.home()) : projectRoot;
  const skillsDir = global
    ? join(scopeRoot, target === 'claude' ? '.claude' : '.agents', 'skills')
    : join(scopeRoot, target === 'claude' ? '.claude' : '.agents', 'skills');
  const guard = createMutationGuard(scopeRoot, skillsDir, dependencies.fs);
  const skillDir = join(guard.targetDir, 'rivet');
  return { target, skillsDir: guard.targetDir, skillDir, guard };
}

function validateManifest(value, expectedTarget) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || !value.package
    || typeof value.package !== 'object'
    || value.package.name !== PACKAGE_NAME
    || typeof value.package.version !== 'string'
    || value.package.version.length < 1
    || value.package.version.length > 128
    || value.target !== expectedTarget
    || !Array.isArray(value.files)
    || value.files.length !== 1
    || value.files[0]?.path !== SKILL_NAME
    || !SHA256.test(value.files[0]?.sha256)
  ) {
    throw conflict('The Rivet install manifest is invalid or unsupported.');
  }
  return value;
}

function manifestBytes(source, target) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: source.package,
    target,
    files: [{ path: SKILL_NAME, sha256: source.skillHash }],
  }, null, 2)}\n`);
}

function inspectTarget(location, operation, source, fs) {
  const { guard, skillDir, target } = location;
  guard.assertPath(location.skillsDir);
  guard.assertPath(skillDir);
  guard.assertPath(join(skillDir, SKILL_NAME));
  guard.assertPath(join(skillDir, MANIFEST_NAME));

  const directoryStatus = lstatIfExists(skillDir, fs);
  if (!directoryStatus) {
    return {
      ...location,
      action: operation === 'install' ? 'install' : 'unchanged',
      directoryIdentity: null,
      manifest: null,
      manifestIdentity: null,
      skillIdentity: null,
      skillHash: null,
    };
  }
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw conflict(`The managed ${target} skill destination is not a safe directory.`);
  }

  const manifestFile = readRegularFile(join(skillDir, MANIFEST_NAME), fs, {
    maxBytes: MAX_MANIFEST_BYTES,
    label: `Rivet ${target} install manifest`,
    missing: true,
  });
  if (!manifestFile) {
    if (operation === 'uninstall') {
      return {
        ...location,
        action: 'unchanged',
        directoryIdentity: identity(directoryStatus),
        manifest: null,
        manifestIdentity: null,
        skillIdentity: null,
        skillHash: null,
      };
    }
    throw conflict(`The ${target} rivet skill directory already exists and is not managed by this package.`);
  }

  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestFile.bytes.toString('utf8')), target);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw conflict(`The Rivet ${target} install manifest is invalid.`, error);
  }
  const skillFile = readRegularFile(join(skillDir, SKILL_NAME), fs, {
    maxBytes: MAX_SKILL_BYTES,
    label: `Managed Rivet ${target} skill`,
    missing: true,
  });
  const recordedHash = manifest.files[0].sha256;
  let action;
  if (operation === 'uninstall') {
    if (skillFile && skillFile.hash !== recordedHash) {
      throw conflict(`The managed ${target} Rivet skill was edited; it was preserved.`);
    }
    action = 'uninstall';
  } else if (!skillFile) {
    action = 'repair';
  } else if (skillFile.hash === recordedHash) {
    action = skillFile.hash === source.skillHash
      && manifest.package.version === source.package.version
      ? 'unchanged'
      : 'update';
  } else if (skillFile.hash === source.skillHash) {
    // The skill rename completed but the manifest rename did not. Only the
    // exact bytes currently shipped by this package are safe to recover.
    action = 'repair-manifest';
  } else {
    throw conflict(`The managed ${target} Rivet skill was edited; it was preserved.`);
  }

  return {
    ...location,
    action,
    directoryIdentity: identity(directoryStatus),
    manifest,
    manifestIdentity: manifestFile.identity,
    manifestHash: manifestFile.hash,
    skillIdentity: skillFile?.identity ?? null,
    skillHash: skillFile?.hash ?? null,
  };
}

function publicPlan(internal) {
  return {
    schemaVersion: 1,
    operation: internal.operation,
    scope: internal.scope,
    ...(internal.projectRoot ? { projectRoot: internal.projectRoot } : {}),
    targets: internal.targets.map(target => ({
      target: target.target,
      skillsDir: target.skillsDir,
      skillDir: target.skillDir,
      manifestPath: join(target.skillDir, MANIFEST_NAME),
      action: target.action,
      ownedFiles: [SKILL_NAME],
    })),
  };
}

function buildPlan(parsed, dependencies) {
  if (!parsed?.flags || parsed.flags.minimal !== true) {
    throw new CliError('Managed installation requires --minimal.', 'INVALID_INPUT');
  }
  const operation = parsed.command === 'uninstall' ? 'uninstall' : 'install';
  const projectRoot = projectScope(parsed, dependencies);
  const source = readSource(dependencies, projectRoot);
  const locations = selectedTargets(parsed.flags)
    .map(target => targetLocation(target, parsed, dependencies, projectRoot));
  const targets = locations.map(location => inspectTarget(
    location,
    operation,
    source,
    dependencies.fs,
  ));
  return {
    operation,
    scope: parsed.flags.global ? 'global' : 'project',
    projectRoot,
    source,
    targets,
  };
}

export function inspectManagedInstall(parsed, dependencies) {
  return publicPlan(buildPlan(parsed, dependencies));
}

function writeAll(descriptor, bytes, fs) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isInteger(count) || count < 1) throw new Error('Managed file write made no progress.');
    offset += count;
  }
}

function writeNewFile(name, bytes, fs, mode = 0o644) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      name,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    );
    writeAll(descriptor, bytes, fs);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function allocateName(prefix, fs) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `${prefix}-${randomUUID()}`;
    if (!lstatIfExists(name, fs)) return name;
  }
  throw conflict('Could not allocate a private managed-install entry.');
}

function cleanupTempFile(name, fs) {
  try {
    const status = lstatIfExists(name, fs);
    if (status && !status.isSymbolicLink() && status.isFile()) fs.unlinkSync(name);
  } catch {
    // Private temporary residue is safer than deleting an entry we did not verify.
  }
}

function atomicReplace(name, bytes, fs, expectedIdentity, expectedHash) {
  const temporary = allocateName('.rivet-write', fs);
  try {
    writeNewFile(temporary, bytes, fs);
    if (expectedIdentity) {
      const current = readRegularFile(name, fs, {
        maxBytes: MAX_SKILL_BYTES,
        label: 'Managed destination',
      });
      if (!sameIdentity(expectedIdentity, current.identity) || current.hash !== expectedHash) {
        throw conflict('Managed destination changed during update.');
      }
    } else if (lstatIfExists(name, fs)) {
      throw conflict('Managed destination appeared during update.');
    }
    fs.renameSync(temporary, name);
  } finally {
    cleanupTempFile(temporary, fs);
  }
}

function cleanupStage(name, fs) {
  try {
    const status = lstatIfExists(name, fs);
    if (!status || status.isSymbolicLink() || !status.isDirectory()) return;
    for (const child of fs.readdirSync(name)) {
      if (child !== SKILL_NAME && child !== MANIFEST_NAME) return;
      const childPath = join(name, child);
      const childStatus = lstatIfExists(childPath, fs);
      if (!childStatus || childStatus.isSymbolicLink() || !childStatus.isFile()) return;
    }
    for (const child of fs.readdirSync(name)) fs.unlinkSync(join(name, child));
    fs.rmdirSync(name);
  } catch {
    // Best effort only; never recurse through an entry that could have changed.
  }
}

function installNewTarget(target, source, fs) {
  const stage = allocateName('.rivet-install', fs);
  try {
    fs.mkdirSync(stage, { mode: 0o755 });
    const stageStatus = fs.lstatSync(stage);
    withPinnedTargetDirectory(stage, identity(stageStatus), fs, () => {
      writeNewFile(SKILL_NAME, source.skillBytes, fs);
      writeNewFile(MANIFEST_NAME, manifestBytes(source, target.target), fs);
    });
    if (lstatIfExists('rivet', fs)) {
      throw conflict(`The ${target.target} rivet skill destination appeared during installation.`);
    }
    fs.renameSync(stage, 'rivet');
  } finally {
    cleanupStage(stage, fs);
  }
}

function readCurrentHash(name, expectedIdentity, fs, label, missing = false) {
  const file = readRegularFile(name, fs, { maxBytes: MAX_SKILL_BYTES, label, missing });
  if (expectedIdentity && (!file || !sameIdentity(expectedIdentity, file.identity))) {
    throw conflict(`${label} changed after prevalidation.`);
  }
  if (!expectedIdentity && file) throw conflict(`${label} appeared after prevalidation.`);
  return file;
}

function installExistingTarget(target, source, fs) {
  const skill = readCurrentHash(
    SKILL_NAME,
    target.skillIdentity,
    fs,
    `Managed Rivet ${target.target} skill`,
    true,
  );
  const manifest = readRegularFile(MANIFEST_NAME, fs, {
    maxBytes: MAX_MANIFEST_BYTES,
    label: `Rivet ${target.target} install manifest`,
  });
  if (!sameIdentity(target.manifestIdentity, manifest.identity) || manifest.hash !== target.manifestHash) {
    throw conflict(`Rivet ${target.target} install manifest changed after prevalidation.`);
  }
  if (skill && skill.hash !== target.skillHash) {
    throw conflict(`Managed Rivet ${target.target} skill changed after prevalidation.`);
  }

  if (target.action === 'update' || target.action === 'repair') {
    atomicReplace(SKILL_NAME, source.skillBytes, fs, skill?.identity ?? null, skill?.hash ?? null);
  }
  atomicReplace(
    MANIFEST_NAME,
    manifestBytes(source, target.target),
    fs,
    manifest.identity,
    manifest.hash,
  );
}

function installTarget(target, source, fs) {
  target.guard.assertPath(target.skillsDir);
  const skillsIdentity = ensureContainedDirectory(target.guard, fs);
  target.guard.assertPath(target.skillDir);
  withPinnedTargetDirectory(target.skillsDir, skillsIdentity, fs, () => {
    if (target.action === 'install') {
      installNewTarget(target, source, fs);
      return;
    }
    if (target.action === 'unchanged') return;
    const currentDirectory = lstatIfExists('rivet', fs);
    if (!currentDirectory || currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
      || !sameIdentity(target.directoryIdentity, identity(currentDirectory))) {
      throw conflict(`The ${target.target} rivet skill directory changed after prevalidation.`);
    }
    withPinnedTargetDirectory('rivet', target.directoryIdentity, fs, () => {
      installExistingTarget(target, source, fs);
    });
  });
  target.guard.assertPath(target.skillDir);
}

function unlinkVerified(name, expectedIdentity, fs, label) {
  const status = lstatIfExists(name, fs);
  if (!status) {
    if (expectedIdentity) throw conflict(`${label} disappeared after prevalidation.`);
    return;
  }
  if (status.isSymbolicLink() || !status.isFile() || !sameIdentity(expectedIdentity, identity(status))) {
    throw conflict(`${label} changed after prevalidation.`);
  }
  fs.unlinkSync(name);
}

function uninstallTarget(target, fs) {
  if (target.action === 'unchanged') return;
  const skillsStatus = lstatIfExists(target.skillsDir, fs);
  if (!skillsStatus || skillsStatus.isSymbolicLink() || !skillsStatus.isDirectory()) {
    throw conflict(`The ${target.target} skills directory changed after prevalidation.`);
  }
  target.guard.assertPath(target.skillDir);
  withPinnedTargetDirectory(target.skillsDir, identity(skillsStatus), fs, () => {
    const directoryStatus = lstatIfExists('rivet', fs);
    if (!directoryStatus || directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()
      || !sameIdentity(target.directoryIdentity, identity(directoryStatus))) {
      throw conflict(`The ${target.target} rivet skill directory changed after prevalidation.`);
    }
    withPinnedTargetDirectory('rivet', target.directoryIdentity, fs, () => {
      if (target.skillIdentity) {
        const skill = readRegularFile(SKILL_NAME, fs, {
          maxBytes: MAX_SKILL_BYTES,
          label: `Managed Rivet ${target.target} skill`,
        });
        if (!sameIdentity(target.skillIdentity, skill.identity) || skill.hash !== target.skillHash) {
          throw conflict(`Managed Rivet ${target.target} skill changed after prevalidation.`);
        }
        unlinkVerified(SKILL_NAME, target.skillIdentity, fs, `Managed Rivet ${target.target} skill`);
      }
      const manifest = readRegularFile(MANIFEST_NAME, fs, {
        maxBytes: MAX_MANIFEST_BYTES,
        label: `Rivet ${target.target} install manifest`,
      });
      if (!sameIdentity(target.manifestIdentity, manifest.identity) || manifest.hash !== target.manifestHash) {
        throw conflict(`Rivet ${target.target} install manifest changed after prevalidation.`);
      }
      unlinkVerified(MANIFEST_NAME, target.manifestIdentity, fs, `Rivet ${target.target} install manifest`);
    });
    const remaining = fs.readdirSync('rivet');
    if (remaining.length === 0) fs.rmdirSync('rivet');
  });
}

function emitSuccess(parsed, dependencies, plan) {
  const changed = plan.targets.filter(target => target.action !== 'unchanged').length;
  const result = publicPlan(plan);
  if (parsed.flags.json) {
    dependencies.output.json({ ok: true, command: plan.operation, result });
  } else if (plan.operation === 'install') {
    dependencies.output.log(`Installed the Rivet entry skill ${plan.scope === 'global' ? 'globally' : 'in the project'} for: ${plan.targets.map(target => target.target).join(', ')}`);
    plan.targets.forEach(target => dependencies.output.log(`  -> ${target.target}: ${target.skillDir}`));
  } else if (changed === 0) {
    dependencies.output.log(`No managed Rivet entry skill found for: ${plan.targets.map(target => target.target).join(', ')}`);
  } else {
    dependencies.output.log(`Uninstalled the Rivet entry skill for: ${plan.targets.map(target => target.target).join(', ')}`);
    plan.targets.forEach(target => dependencies.output.log(`  -> ${target.target}: ${target.skillDir}`));
  }
}

export async function managedInstall(parsed, dependencies) {
  const plan = buildPlan(parsed, dependencies);
  for (const target of plan.targets) {
    if (plan.operation === 'install') installTarget(target, plan.source, dependencies.fs);
    else uninstallTarget(target, dependencies.fs);
  }
  emitSuccess(parsed, dependencies, plan);
  return EXIT_CODES.SUCCESS;
}
