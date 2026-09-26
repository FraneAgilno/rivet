import * as filesystem from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { EXIT_CODES } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { snapshot } from '../integrations/capabilities.js';
import { validateProjectConfiguration } from '../config/validate.js';
import { withPinnedTargetDirectory } from './install.js';
import { discoverGit } from '../discovery/git.js';
import {
  ProjectDiscoveryError,
  discoverProject,
  inspectBoundedFile,
  readStrictBoundedFile,
} from '../discovery/project.js';
import { discoverTools } from '../discovery/tools.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = Object.freeze(['project.yaml', 'providers.yaml', 'orchestration.yaml', 'quality.yaml']);
const MAX_TEMPLATE_BYTES = 256 * 1024;

function emit(output, json, value, exitCode) {
  if (json) {
    output.json(value, exitCode === EXIT_CODES.SUCCESS ? 'stdout' : 'stderr');
  } else if (exitCode === EXIT_CODES.SUCCESS) {
    output.log(value.message);
  } else {
    output.error(`ERROR: ${value.error.message}`);
  }
  return exitCode;
}

function failure(output, json, code, exitCode, message, details = {}) {
  return emit(output, json, {
    ok: false,
    error: { code, exitCode, message },
    ...details,
  }, exitCode);
}

function boundedTemplate(packageRoot, filename, fs) {
  const lexicalRoot = resolve(packageRoot);
  const rootMetadata = fs.lstatSync(lexicalRoot, { throwIfNoEntry: false });
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Project templates are unavailable');
  const root = fs.realpathSync(lexicalRoot);
  if (!sameIdentity(rootMetadata, fs.statSync(root))) throw new Error('Project templates are unavailable');
  const file = inspectBoundedFile(root, `templates/project/.rivet/${filename}`, fs, true);
  return YAML.parse(readStrictBoundedFile(file, fs, MAX_TEMPLATE_BYTES));
}

function provenanceRecord(source, kind, confidence) {
  return Object.freeze({ source, kind, confidence });
}

function collectLeafProvenance(value, prefix, record, target) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeafProvenance(item, `${prefix}[${index}]`, record, target));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectLeafProvenance(item, prefix ? `${prefix}.${key}` : key, record, target);
    }
  } else {
    target[prefix] = record;
  }
}

function replaceProvenance(provenance, prefix, record) {
  for (const path of Object.keys(provenance)) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) {
      provenance[path] = record;
    }
  }
}

function proposalProvenance(config, discovery, git) {
  const provenance = {};
  for (const [section, value] of Object.entries(config)) {
    collectLeafProvenance(
      value,
      section,
      provenanceRecord(`templates/project/.rivet/${section}.yaml`, 'template', 'exact'),
      provenance,
    );
  }
  for (const field of ['id', 'name', 'stack.framework', 'stack.language', 'stack.packageManager']) {
    const fallbackName = (field === 'id' || field === 'name')
      && discovery.provenance[field] === 'project directory basename';
    replaceProvenance(
      provenance,
      `project.${field}`,
      provenanceRecord(discovery.provenance[field], fallbackName ? 'inferred' : 'detected', fallbackName ? 'low' : 'high'),
    );
  }
  replaceProvenance(
    provenance,
    'project.repository.defaultBranch',
    provenanceRecord(
      git.repository === true && git.defaultBranchSource !== 'default'
        ? 'local git metadata' : 'templates/project/.rivet/project.yaml',
      git.repository === true && git.defaultBranchSource !== 'default' ? 'detected' : 'default',
      git.repository === true && git.defaultBranchSource !== 'default' ? 'high' : 'low',
    ),
  );
  for (const command of Object.keys(config.project.commands)) {
    const steps = config.project.schemaVersion === 1
      ? [{ prefix: `project.commands.${command}`, source: discovery.provenance[`commands.${command}`] }]
      : config.project.commands[command].steps.map((_, index) => ({
        prefix: `project.commands.${command}.steps[${index}]`,
        source: discovery.provenance[`commands.${command}.steps[${index}]`],
      }));
    for (const step of steps) {
      replaceProvenance(
        provenance,
        step.prefix,
        provenanceRecord(step.source, step.source.startsWith('safe-default') ? 'default' : 'detected', step.source.startsWith('safe-default') ? 'low' : 'high'),
      );
    }
  }
  for (const [index, gate] of config.quality.commandGates.entries()) {
    replaceProvenance(
      provenance,
      `quality.commandGates[${index}]`,
      provenanceRecord(`project.commands.${gate.command}`, 'inferred', 'high'),
    );
  }
  for (const field of ['storybook', 'playwright']) {
    replaceProvenance(
      provenance,
      `quality.expectations.${field}`,
      provenanceRecord(discovery.provenance[`features.${field}`], 'inferred', 'high'),
    );
  }
  const visualSource = 'Storybook feature inference';
  replaceProvenance(provenance, 'quality.expectations.visual', provenanceRecord(visualSource, 'inferred', 'medium'));
  replaceProvenance(provenance, 'quality.evidence.requireHumanBaseline', provenanceRecord(visualSource, 'inferred', 'medium'));
  return Object.freeze(provenance);
}

function proposalFromTemplates(discovery, git, packageRoot, fs) {
  const config = {
    project: boundedTemplate(packageRoot, 'project.yaml', fs),
    providers: boundedTemplate(packageRoot, 'providers.yaml', fs),
    orchestration: boundedTemplate(packageRoot, 'orchestration.yaml', fs),
    quality: boundedTemplate(packageRoot, 'quality.yaml', fs),
  };
  config.project.id = discovery.proposal.id;
  config.project.name = discovery.proposal.name;
  config.project.schemaVersion = discovery.proposal.schemaVersion;
  config.project.stack = discovery.proposal.stack;
  config.project.repository.defaultBranch = git.defaultBranch ?? 'main';
  config.project.commands = discovery.proposal.commands;
  for (const command of ['lint', 'typecheck']) {
    if (config.project.commands[command]) {
      config.quality.commandGates.push({ id: command, command, required: false });
    }
  }
  config.quality.expectations.storybook = discovery.features.storybook ? 'required' : 'optional';
  config.quality.expectations.playwright = discovery.features.playwright ? 'required' : 'optional';
  config.quality.expectations.visual = discovery.features.storybook ? 'human-baseline' : 'none';
  config.quality.evidence.requireHumanBaseline = discovery.features.storybook;
  validateProjectConfiguration(config);
  return {
    config,
    provenance: proposalProvenance(config, discovery, git),
    files: Object.fromEntries(FILES.map(filename => {
      const key = filename.replace('.yaml', '');
      return [filename, YAML.stringify(config[key], { lineWidth: 0 })];
    })),
  };
}

function publicGitSummary(git) {
  return {
    repository: git.repository === true,
    currentBranch: git.currentBranch ?? null,
    defaultBranch: git.defaultBranch ?? null,
    detached: git.detached === true,
    dirty: git.dirty === true,
    baseFreshness: git.baseFreshness ?? 'not_checked',
    worktreeCount: Array.isArray(git.worktrees) ? git.worktrees.length : 0,
    occupiedCandidateCount: Array.isArray(git.occupiedCandidatePaths)
      ? git.occupiedCandidatePaths.length : 0,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedRegular(path, expected, fs) {
  return readStrictBoundedFile({
    path,
    identity: Object.freeze({ dev: expected.dev, ino: expected.ino }),
  }, fs, MAX_TEMPLATE_BYTES);
}

function contentDigest(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function targetState(root, files, fs) {
  const directory = join(root, '.rivet');
  const directoryStatus = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (directoryStatus?.isSymbolicLink() || (directoryStatus && !directoryStatus.isDirectory())) {
    throw new Error('Target .rivet path is not a safe directory');
  }
  if (directoryStatus) {
    const unexpected = fs.readdirSync(directory).filter(name => !FILES.includes(name));
    if (unexpected.length > 0) throw new Error('Target .rivet directory contains unexpected entries');
  }
  const existing = [];
  const diffs = {};
  const identities = {};
  const snapshots = {};
  for (const filename of FILES) {
    const path = join(directory, filename);
    const status = fs.lstatSync(path, { throwIfNoEntry: false });
    if (status?.isSymbolicLink() || (status && !status.isFile())) {
      throw new Error('Target configuration contains an unsafe entry');
    }
    if (status) {
      if (status.size > MAX_TEMPLATE_BYTES) {
        throw new Error('Target configuration is too large to compare safely');
      }
      existing.push(filename);
      identities[filename] = Object.freeze({ dev: status.dev, ino: status.ino });
      const prior = readBoundedRegular(path, status, fs);
      snapshots[filename] = Object.freeze({
        dev: status.dev,
        ino: status.ino,
        size: status.size,
        mode: status.mode & 0o7777,
        digest: contentDigest(prior),
      });
      diffs[filename] = {
        action: prior === files[filename] ? 'unchanged' : 'replace',
        beforeBytes: Buffer.byteLength(prior),
        afterBytes: Buffer.byteLength(files[filename]),
      };
    } else {
      identities[filename] = null;
      snapshots[filename] = null;
      diffs[filename] = { action: 'create', beforeBytes: 0, afterBytes: Buffer.byteLength(files[filename]) };
    }
  }
  return {
    directory,
    directoryExists: Boolean(directoryStatus),
    directoryIdentity: directoryStatus
      ? Object.freeze({ dev: directoryStatus.dev, ino: directoryStatus.ino }) : null,
    existing,
    diffs,
    identities,
    snapshots,
  };
}

function assertContained(root, target) {
  const path = relative(resolve(root), resolve(target));
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) return;
  throw new Error('Configuration target escapes the project root');
}

class InitTransactionError extends Error {
  constructor(recovery) {
    super('Project configuration transaction failed safely');
    this.recovery = recovery;
  }
}

function recoveryDetails(residueCount = 0, remediation = 'Retry initialization after resolving the local filesystem condition.') {
  return {
    residueCount,
    recoverable: true,
    remediation,
  };
}

function verifiedRoot(root, fs) {
  const lexical = resolve(root);
  const metadata = fs.lstatSync(lexical, { throwIfNoEntry: false });
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new InitTransactionError(recoveryDetails());
  const canonical = fs.realpathSync(lexical);
  if (!sameIdentity(metadata, fs.statSync(canonical))) throw new InitTransactionError(recoveryDetails());
  return { path: canonical, identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }) };
}

function acquireInitLock(root, fs) {
  const anchor = verifiedRoot(root, fs);
  const name = '.rivet-init.lock';
  const path = join(anchor.path, '.rivet-init.lock');
  assertContained(anchor.path, path);
  let created = false;
  try {
    withPinnedTargetDirectory(anchor.path, anchor.identity, fs, () => {
      fs.mkdirSync(name, { mode: 0o700 });
      created = true;
      fs.writeFileSync(join(name, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
    });
  } catch {
    const metadata = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!created && metadata?.isDirectory() && !metadata.isSymbolicLink()) {
      const owner = fs.lstatSync(join(path, 'owner.json'), { throwIfNoEntry: false });
      throw new InitTransactionError({
        ...recoveryDetails(1, 'Inspect and remove the local initialization lock after confirming no writer is active.'),
        lockPresent: true,
        lockAgeMs: Number.isFinite(metadata.mtimeMs) ? Math.max(0, Date.now() - metadata.mtimeMs) : null,
        ownerMetadataPresent: Boolean(owner?.isFile() && !owner.isSymbolicLink()),
      });
    }
    try {
      withPinnedTargetDirectory(anchor.path, anchor.identity, fs, () => {
        try { fs.unlinkSync(join(name, 'owner.json')); } catch {}
        try { fs.rmdirSync(name); } catch {}
      });
    } catch {}
    throw new InitTransactionError({
      ...recoveryDetails(metadata ? 1 : 0),
      lockPresent: Boolean(metadata),
    });
  }
  const metadata = fs.lstatSync(path);
  return { path, name, anchor, identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }) };
}

function releaseInitLock(lock, fs) {
  let residueCount = 0;
  try {
    withPinnedTargetDirectory(lock.anchor.path, lock.anchor.identity, fs, () => {
      const current = fs.lstatSync(lock.name, { throwIfNoEntry: false });
      if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, lock.identity)) {
        residueCount += 1;
        return;
      }
      try { fs.unlinkSync(join(lock.name, 'owner.json')); } catch { residueCount += 1; }
      try { fs.rmdirSync(lock.name); } catch { residueCount += 1; }
    });
  } catch {
    residueCount += 1;
  }
  return residueCount === 0 ? { residueCount: 0 } : recoveryDetails(residueCount,
    'Inspect and remove the local initialization lock after confirming no writer is active.');
}

function verifyTargetState(state, fs) {
  const unexpected = fs.readdirSync(state.directory).filter(name => !FILES.includes(name));
  if (unexpected.length > 0) throw new Error('Target configuration changed during validation');
  for (const filename of FILES) {
    const current = fs.lstatSync(join(state.directory, filename), { throwIfNoEntry: false });
    if (current?.isSymbolicLink() || (current && !current.isFile())) throw new Error('Target configuration changed during validation');
    const expected = state.identities[filename];
    if ((expected === null && current) || (expected && (!current || !sameIdentity(expected, current)))) {
      throw new Error('Target configuration changed during validation');
    }
  }
}

function directoryMatches(path, identity, fs) {
  try {
    const metadata = fs.lstatSync(path, { throwIfNoEntry: false });
    return metadata?.isDirectory() && !metadata.isSymbolicLink() && sameIdentity(metadata, identity);
  } catch {
    return false;
  }
}

function identityOf(metadata) {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function strictDirectoryEntry(name, expectedIdentity, fs) {
  const metadata = fs.lstatSync(name, { throwIfNoEntry: false });
  return metadata?.isDirectory() && !metadata.isSymbolicLink() && sameIdentity(metadata, expectedIdentity)
    ? metadata : null;
}

function fileMatchesSnapshot(path, metadata, snapshot, fs) {
  if (!metadata?.isFile() || metadata.isSymbolicLink() || !snapshot
    || metadata.dev !== snapshot.dev || metadata.ino !== snapshot.ino
    || metadata.size !== snapshot.size || (metadata.mode & 0o7777) !== snapshot.mode) {
    return false;
  }
  try {
    return contentDigest(readBoundedRegular(path, metadata, fs)) === snapshot.digest;
  } catch {
    return false;
  }
}

function verifyDirectorySnapshot(name, directoryIdentity, snapshots, fs) {
  if (!strictDirectoryEntry(name, directoryIdentity, fs)) return false;
  const expectedEntries = Object.keys(snapshots).filter(filename => snapshots[filename] !== null).sort();
  let entries;
  try { entries = fs.readdirSync(name).sort(); } catch { return false; }
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) return false;
  return expectedEntries.every(filename => {
    const path = join(name, filename);
    return fileMatchesSnapshot(path, fs.lstatSync(path, { throwIfNoEntry: false }), snapshots[filename], fs);
  });
}

function verifyStateRelative(state, fs) {
  const directory = fs.lstatSync('.rivet', { throwIfNoEntry: false });
  if (state.directoryIdentity === null) {
    if (directory) throw new Error('Target configuration appeared during initialization');
    return;
  }
  if (!directory?.isDirectory() || directory.isSymbolicLink()
    || !sameIdentity(directory, state.directoryIdentity)) {
    throw new Error('Target configuration directory changed during initialization');
  }
  const unexpected = fs.readdirSync('.rivet').filter(name => !FILES.includes(name));
  if (unexpected.length > 0) throw new Error('Target configuration changed during initialization');
  for (const filename of FILES) {
    const current = fs.lstatSync(join('.rivet', filename), { throwIfNoEntry: false });
    const expected = state.snapshots[filename];
    if (current?.isSymbolicLink() || (current && !current.isFile())
      || (expected === null && current) || (expected && !fileMatchesSnapshot(join('.rivet', filename), current, expected, fs))) {
      throw new Error('Target configuration changed during initialization');
    }
  }
}

function validateStagedDirectory(stagePath, stageIdentity, files, fs) {
  const snapshots = {};
  withPinnedTargetDirectory(stagePath, stageIdentity, fs, () => {
    const entries = fs.readdirSync('.').sort();
    if (entries.length !== FILES.length || entries.some((name, index) => name !== [...FILES].sort()[index])) {
      throw new Error('Staged configuration is incomplete');
    }
    const config = {};
    for (const filename of FILES) {
      const metadata = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('Staged configuration is unsafe');
      const source = readBoundedRegular(filename, metadata, fs);
      if (source !== files[filename]) throw new Error('Staged configuration content changed');
      snapshots[filename] = Object.freeze({
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mode: metadata.mode & 0o7777,
        digest: contentDigest(source),
      });
      config[filename.replace('.yaml', '')] = YAML.parse(source);
    }
    validateProjectConfiguration(config);
  });
  return Object.freeze(snapshots);
}

function residueCount(name, fs) {
  try {
    const metadata = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!metadata) return 0;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return 1;
    return Math.max(1, fs.readdirSync(name).length);
  } catch {
    return 1;
  }
}

function removeOwnedDirectory(name, directoryIdentity, snapshots, fs) {
  if (!verifyDirectorySnapshot(name, directoryIdentity, snapshots, fs)) return false;
  const expectedEntries = Object.keys(snapshots).filter(filename => snapshots[filename] !== null).sort();
  let ok = true;
  for (const filename of expectedEntries) {
    try { fs.unlinkSync(join(name, filename)); } catch { ok = false; }
  }
  if (ok) {
    try { fs.rmdirSync(name); } catch { ok = false; }
  }
  return ok;
}

function rollbackWholeDirectory(context, fs) {
  let errors = 0;
  try {
    withPinnedTargetDirectory(context.anchor.path, context.anchor.identity, fs, () => {
      const live = fs.lstatSync('.rivet', { throwIfNoEntry: false });
      if (context.published) {
        if (live?.isDirectory() && !live.isSymbolicLink() && sameIdentity(live, context.stageIdentity)
          && !fs.lstatSync(context.stageName, { throwIfNoEntry: false })) {
          try {
            fs.renameSync('.rivet', context.stageName);
            if (!strictDirectoryEntry(context.stageName, context.stageIdentity, fs)) errors += 1;
          } catch { errors += 1; }
        } else {
          errors += 1;
        }
      }
      if (context.backupIdentity) {
        const backup = strictDirectoryEntry(context.backupName, context.backupIdentity, fs);
        const target = fs.lstatSync('.rivet', { throwIfNoEntry: false });
        if (backup && !target) {
          try {
            fs.renameSync(context.backupName, '.rivet');
            if (!strictDirectoryEntry('.rivet', context.state.directoryIdentity, fs)) errors += 1;
          } catch { errors += 1; }
        } else if (backup) {
          errors += 1;
        }
      }
      if (strictDirectoryEntry(context.stageName, context.stageIdentity, fs)
        && !removeOwnedDirectory(context.stageName, context.stageIdentity, context.stageSnapshots, fs)) {
        errors += 1;
      }
    });
  } catch {
    errors += 1;
  }
  const residue = residueCount(context.stagePath, fs) + residueCount(context.backupPath, fs);
  return recoveryDetails(Math.max(errors, residue), errors > 0
    ? 'Recover the preserved sibling stage or backup before retrying.'
    : 'Retry initialization after resolving the local filesystem conflict.');
}

function cleanupCommittedBackup(context, fs, options) {
  if (!context.backupIdentity) return { residueCount: 0 };
  let removed = false;
  try {
    withPinnedTargetDirectory(context.anchor.path, context.anchor.identity, fs, () => {
      options.beforeBackupCleanup?.();
      removed = removeOwnedDirectory(context.backupName, context.backupIdentity, context.state.snapshots, fs);
    });
  } catch {}
  const residue = removed ? 0 : residueCount(context.backupPath, fs);
  return residue === 0 ? { residueCount: 0 } : {
    ...recoveryDetails(residue, 'Retry cleanup after resolving the local filesystem condition.'),
    recoveryStored: true,
    warning: 'Committed configuration has private sibling backup cleanup residue.',
  };
}

async function atomicWrite(root, files, state, fs, options = {}) {
  assertContained(root, state.directory);
  const anchor = verifiedRoot(root, fs);
  const marker = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stageName = `.rivet-stage-${marker}`;
  const backupName = `.rivet-backup-${marker}`;
  const context = {
    anchor,
    state,
    stageName,
    stagePath: join(anchor.path, stageName),
    backupName,
    backupPath: join(anchor.path, backupName),
    stageIdentity: null,
    stageSnapshots: {},
    backupIdentity: null,
    published: false,
  };
  try {
    withPinnedTargetDirectory(anchor.path, anchor.identity, fs, () => {
      fs.mkdirSync(stageName, { mode: 0o700 });
      const staged = fs.lstatSync(stageName);
      if (!staged.isDirectory() || staged.isSymbolicLink()) throw new Error('Staged directory is unsafe');
      context.stageIdentity = identityOf(staged);
    });
    withPinnedTargetDirectory(context.stagePath, context.stageIdentity, fs, () => {
      for (const filename of FILES) {
        fs.writeFileSync(filename, files[filename], { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
    });
    context.stageSnapshots = validateStagedDirectory(context.stagePath, context.stageIdentity, files, fs);
    options.beforePublish?.();
    withPinnedTargetDirectory(anchor.path, anchor.identity, fs, () => {
      verifyStateRelative(state, fs);
      options.beforeFirstMutation?.();
      if (state.directoryIdentity) {
        verifyStateRelative(state, fs);
        if (!verifyDirectorySnapshot(stageName, context.stageIdentity, context.stageSnapshots, fs)) {
          throw new Error('Staged directory changed');
        }
        fs.renameSync('.rivet', backupName);
        const backup = strictDirectoryEntry(backupName, state.directoryIdentity, fs);
        if (!backup || !verifyDirectorySnapshot(backupName, state.directoryIdentity, state.snapshots, fs)) {
          throw new Error('Backup directory identity verification failed');
        }
        context.backupIdentity = identityOf(backup);
      }
      options.beforePublishRename?.();
      if (fs.lstatSync('.rivet', { throwIfNoEntry: false })) throw new Error('Target configuration appeared before publish');
      if (!verifyDirectorySnapshot(stageName, context.stageIdentity, context.stageSnapshots, fs)) {
        throw new Error('Staged directory changed before publish');
      }
      if (context.backupIdentity
        && !verifyDirectorySnapshot(backupName, context.backupIdentity, state.snapshots, fs)) {
        throw new Error('Backup directory changed before publish');
      }
      fs.renameSync(stageName, '.rivet');
      const published = strictDirectoryEntry('.rivet', context.stageIdentity, fs);
      if (!published || !verifyDirectorySnapshot('.rivet', context.stageIdentity, context.stageSnapshots, fs)) {
        throw new Error('Published directory identity verification failed');
      }
      context.published = true;
    });
    const loaded = await (options.configLoader ?? loadProjectConfig)(anchor.path, { fs });
    validateProjectConfiguration(loaded);
  } catch {
    throw new InitTransactionError(rollbackWholeDirectory(context, fs));
  }
  return cleanupCommittedBackup(context, fs, options);
}

export async function init(parsed, dependencies = {}) {
  const fs = dependencies.fs ?? filesystem;
  const output = dependencies.output;
  const json = parsed.flags.json === true;
  const projectRoot = resolve(parsed.flags.project ?? dependencies.cwd?.() ?? process.cwd());
  try {
    const discovery = await (dependencies.projectDiscovery ?? discoverProject)(projectRoot, { fs });
    const git = await (dependencies.gitDiscovery ?? discoverGit)(projectRoot, { runner: dependencies.runner });
    const tools = await (dependencies.toolDiscovery ?? discoverTools)({
      packageManager: discovery.proposal.stack.packageManager,
      playwright: discovery.features.playwright,
      storybook: discovery.features.storybook,
    }, { cwd: projectRoot, runner: dependencies.runner });
    const proposal = proposalFromTemplates(discovery, git, dependencies.packageRoot ?? PACKAGE_ROOT, fs);
    if (!parsed.flags.write) {
      const state = targetState(projectRoot, proposal.files, fs);
      const result = {
        ok: true,
        status: 'proposal',
        project: { id: discovery.proposal.id, root: '.' },
        proposal: {
          schemaVersion: discovery.proposal.schemaVersion,
          commands: discovery.proposal.commands,
          qualityGates: proposal.config.quality.commandGates,
          files: proposal.files,
          provenance: proposal.provenance,
          diffs: state.diffs,
        },
        discovery: {
          features: discovery.features,
          git: publicGitSummary(git),
          tools,
          warnings: discovery.warnings,
          unresolved: discovery.unresolved,
        },
        checksExecuted: false,
      };
      result.message = `Proposed ${FILES.length} configuration files; no files were written.\n${FILES.map(filename => `  ${filename}: ${state.diffs[filename].action}`).join('\n')}`;
      return emit(output, json, result, EXIT_CODES.SUCCESS);
    }
    const lock = acquireInitLock(projectRoot, fs);
    let lockCleanup = { residueCount: 0 };
    let result;
    try {
      const state = targetState(projectRoot, proposal.files, fs);
      result = {
        ok: true,
        status: 'written',
        project: { id: discovery.proposal.id, root: '.' },
        proposal: {
          schemaVersion: discovery.proposal.schemaVersion,
          commands: discovery.proposal.commands,
          qualityGates: proposal.config.quality.commandGates,
          files: proposal.files,
          provenance: proposal.provenance,
          diffs: state.diffs,
        },
        discovery: {
          features: discovery.features,
          git: publicGitSummary(git),
          tools,
          warnings: discovery.warnings,
          unresolved: discovery.unresolved,
        },
        checksExecuted: false,
      };
      if (state.existing.length > 0 && !parsed.flags.overwrite) {
        if (json || typeof dependencies.confirmOverwrite !== 'function') {
          return failure(output, json, 'REPOSITORY_CONFLICT', EXIT_CODES.REPOSITORY_CONFLICT,
            'Existing configuration requires both --write and --overwrite.', { diffs: state.diffs });
        }
        output.log(`Proposed overwrite:\n${FILES.map(filename => `  ${filename}: ${state.diffs[filename].action}`).join('\n')}`);
        const confirmed = await dependencies.confirmOverwrite(state.diffs);
        if (!confirmed) {
          return failure(output, json, 'REPOSITORY_CONFLICT', EXIT_CODES.REPOSITORY_CONFLICT,
            'Configuration write was cancelled.', { diffs: state.diffs });
        }
      }
      result.cleanup = await atomicWrite(projectRoot, proposal.files, state, fs, {
        beforePublish: dependencies.beforePublish,
        beforeFirstMutation: dependencies.beforeFirstMutation,
        beforePublishRename: dependencies.beforePublishRename,
        beforeBackupCleanup: dependencies.beforeBackupCleanup,
        configLoader: dependencies.configLoader,
      });
    } finally {
      lockCleanup = releaseInitLock(lock, fs);
    }
    if (lockCleanup.residueCount > 0) {
      result.cleanup = {
        ...result.cleanup,
        residueCount: result.cleanup.residueCount + lockCleanup.residueCount,
        warning: lockCleanup.remediation,
        remediation: lockCleanup.remediation,
      };
    }
    result.message = `Wrote ${FILES.length} configuration files to .rivet/.${result.cleanup.residueCount > 0 ? ' Backup cleanup requires attention.' : ''}`;
    return emit(output, json, result, EXIT_CODES.SUCCESS);
  } catch (error) {
    return failure(output, json, 'REPOSITORY_CONFLICT', EXIT_CODES.REPOSITORY_CONFLICT,
      'Project configuration could not be proposed or written safely.',
      error instanceof InitTransactionError ? { recovery: error.recovery }
        : error instanceof ProjectDiscoveryError ? { discovery: error.details } : {});
  }
}

/** Append providers under the init lock without replacing the .rivet directory.
 * Protocols stay in place; all four configuration snapshots must remain current.
 */
export async function prepareProviderAppend(root, options = {}) {
  const fs = options.fs ?? filesystem;
  const anchor = verifiedRoot(root, fs);
  const directory = join(anchor.path, '.rivet');
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Existing configuration is required');
  const directoryIdentity = identityOf(metadata);
  const files = {}, snapshots = {};
  let entries, protocolsIdentity;
  const config = await loadProjectConfig(anchor.path, { fs });
  withPinnedTargetDirectory(directory, directoryIdentity, fs, () => {
    entries = fs.readdirSync('.').sort();
    if (entries.includes('protocols')) protocolsIdentity = identityOf(fs.lstatSync('protocols'));
    for (const name of FILES) {
      const before = fs.lstatSync(name);
      const content = readBoundedRegular(name, before, fs);
      files[name] = content;
      snapshots[name] = { dev: before.dev, ino: before.ino, size: before.size, mode: before.mode & 0o7777, digest: contentDigest(content) };
    }
  });
  const verifyTopology = (temporary) => {
    const current = fs.readdirSync('.').filter(name => name !== temporary).sort();
    if (JSON.stringify(current) !== JSON.stringify(entries)
      || (protocolsIdentity && !directoryMatches('protocols', protocolsIdentity, fs))) throw new Error('Configuration topology changed');
  };
  const verify = () => {
    if (!directoryMatches(anchor.path, anchor.identity, fs) || !directoryMatches(directory, directoryIdentity, fs)) throw new Error('Configuration identity changed');
    withPinnedTargetDirectory(directory, directoryIdentity, fs, () => {
      verifyTopology();
      for (const name of FILES) if (!fileMatchesSnapshot(name, fs.lstatSync(name, { throwIfNoEntry: false }), snapshots[name], fs)) throw new Error('Configuration changed');
    });
  };
  // Bind the parsed values to the byte snapshots, including any edits during load.
  const reloaded = await loadProjectConfig(anchor.path, { fs });
  if (JSON.stringify(config) !== JSON.stringify(reloaded)) throw new Error('Configuration changed');
  verify();
  let committed = false;
  return Object.freeze({ config, propose(additions) {
    const added = snapshot(additions, MAX_TEMPLATE_BYTES);
    if (!Array.isArray(added) || !added.length) throw new Error('Provider additions are required');
    const updated = { ...config, providers: { ...config.providers, providers: [...config.providers.providers, ...added] } };
    validateProjectConfiguration(updated);
    const document = YAML.parseDocument(files['providers.yaml']);
    for (const provider of added) document.get('providers', true).add(provider);
    const proposed = String(document);
    if (Buffer.byteLength(proposed, 'utf8') > MAX_TEMPLATE_BYTES) throw new Error('Provider configuration is too large');
    return Object.freeze({ providersYaml: proposed, async commit() {
      if (committed) throw new Error('Configuration proposal has already been used');
      committed = true;
      verify();
      const lock = acquireInitLock(anchor.path, fs);
      const temporary = `.rivet-providers-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      let staged = null, cleanup;
      try {
        verify();
        withPinnedTargetDirectory(directory, directoryIdentity, fs, () => {
          fs.writeFileSync(temporary, proposed, { encoding: 'utf8', flag: 'wx', mode: snapshots['providers.yaml'].mode });
          const metadata = fs.lstatSync(temporary);
          staged = { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mode: metadata.mode & 0o7777, digest: contentDigest(proposed) };
          verifyTopology(temporary);
          for (const name of FILES) if (!fileMatchesSnapshot(name, fs.lstatSync(name, { throwIfNoEntry: false }), snapshots[name], fs)) throw new Error('Configuration changed');
          if (!fileMatchesSnapshot(temporary, metadata, staged, fs)) throw new Error('Staged providers changed');
          fs.renameSync(temporary, 'providers.yaml');
          staged = null;
        });
      } finally {
        if (staged) {
          try { withPinnedTargetDirectory(directory, directoryIdentity, fs, () => {
            if (fileMatchesSnapshot(temporary, fs.lstatSync(temporary, { throwIfNoEntry: false }), staged, fs)) fs.unlinkSync(temporary);
          }); } catch {}
        }
        cleanup = releaseInitLock(lock, fs);
      }
      return cleanup;
    } });
  } });
}

export { atomicWrite };
