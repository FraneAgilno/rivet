import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { CliError, EXIT_CODES } from '../cli/output.js';

const SKILL_CATEGORIES = {
  Backend: ['backend-nestjs', 'backend-nestjs-agent', 'backend-django', 'backend-django-agent', 'backend-agent'],
  'Frontend & Mobile': ['frontend-nextjs', 'frontend-nextjs-agent', 'frontend-web-agent', 'mobile-react-native', 'mobile-agent'],
  'Data & Contracts': ['api-contract', 'postgres-analytics', 'data-performance-agent', 'database-migration'],
  'Quality & Testing': ['qa-bug-analysis', 'testing-quality', 'qa-agent', 'jest-agent', 'vitest-agent', 'playwright-agent', 'debugging'],
  'Delivery & Planning': ['product-jira-ticketing', 'bug-ticket-creation', 'sprint-planning', 'delivery-ticketing-agent', 'refactoring', 'documentation'],
  Operations: ['devops-infra', 'devops-agent', 'cloudwatch-troubleshooting', 'kubernetes-troubleshooting', 'incident-postmortem', 'incident-response-agent', 'security-review'],
};

export const installedSkillName = name => `rivet-${name}`;

const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 750;
const DEFAULT_MAX_UPDATE_RESPONSE_BYTES = 32 * 1024;

function distributionPaths(packageRoot) {
  return {
    skills: join(packageRoot, 'dist', 'skills'),
    agents: join(packageRoot, 'dist', 'agents'),
    mandatory: join(packageRoot, 'dist', 'mandatory'),
  };
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (
    !isAbsolute(pathFromRoot)
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
  );
}

function throwSymlinkConflict() {
  throw new CliError('Target path contains a symbolic link.', 'REPOSITORY_CONFLICT');
}

function lstatIfExists(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoSymlinkTree(path, fs) {
  const status = lstatIfExists(path, fs);
  if (!status) return;
  if (status.isSymbolicLink()) throwSymlinkConflict();
  if (!status.isDirectory()) return;
  for (const entry of fs.readdirSync(path)) {
    assertNoSymlinkTree(join(path, entry), fs);
  }
}

function canonicalizePlan(lexicalAnchor, lexicalTarget, fs) {
  const absoluteAnchor = resolve(lexicalAnchor);
  const absoluteTarget = resolve(lexicalTarget);
  const targetFromAnchor = relative(absoluteAnchor, absoluteTarget);
  if (!isWithin(absoluteAnchor, absoluteTarget)) {
    throw new CliError('Target path escapes its authorized root.', 'REPOSITORY_CONFLICT');
  }

  let existingAnchor = absoluteAnchor;
  const missingSegments = [];
  while (!fs.existsSync(existingAnchor)) {
    const parent = dirname(existingAnchor);
    if (parent === existingAnchor) {
      throw new CliError('Could not establish an authorized target root.', 'REPOSITORY_CONFLICT');
    }
    missingSegments.unshift(basename(existingAnchor));
    existingAnchor = parent;
  }

  try {
    const canonicalBoundary = fs.realpathSync(existingAnchor);
    const boundaryStatus = fs.lstatSync(canonicalBoundary);
    if (boundaryStatus.isSymbolicLink() || !boundaryStatus.isDirectory()) {
      throw new CliError('Authorized target root is not a directory.', 'REPOSITORY_CONFLICT');
    }
    const canonicalAnchor = join(canonicalBoundary, ...missingSegments);
    return {
      anchor: canonicalAnchor,
      boundary: canonicalBoundary,
      boundaryIdentity: Object.freeze({ dev: boundaryStatus.dev, ino: boundaryStatus.ino }),
      target: resolve(canonicalAnchor, targetFromAnchor),
    };
  } catch (error) {
    throw new CliError('Could not validate the authorized target root.', 'REPOSITORY_CONFLICT', {
      cause: error,
    });
  }
}

export function createMutationGuard(lexicalAnchor, lexicalTarget, fs) {
  const plan = canonicalizePlan(lexicalAnchor, lexicalTarget, fs);

  const assertPath = (candidate) => {
    const absoluteCandidate = resolve(candidate);
    if (!isWithin(plan.target, absoluteCandidate)) {
      throw new CliError('Mutation path escapes its authorized target.', 'REPOSITORY_CONFLICT');
    }
    const segments = relative(plan.boundary, absoluteCandidate).split(sep).filter(Boolean);
    let current = plan.boundary;
    let candidateIdentity = null;
    try {
      for (const segment of segments) {
        current = join(current, segment);
        const status = lstatIfExists(current, fs);
        if (!status) continue;
        if (status.isSymbolicLink()) throwSymlinkConflict();
        const canonicalCurrent = fs.realpathSync(current);
        if (!isWithin(plan.boundary, canonicalCurrent)) {
          throw new CliError('Target path escapes its authorized root.', 'REPOSITORY_CONFLICT');
        }
        if (current === absoluteCandidate) {
          candidateIdentity = Object.freeze({ dev: status.dev, ino: status.ino });
        }
      }
      return candidateIdentity;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('Could not validate target path containment.', 'REPOSITORY_CONFLICT', {
        cause: error,
      });
    }
  };

  return Object.freeze({
    authorizationBoundary: plan.boundary,
    authorizationBoundaryIdentity: plan.boundaryIdentity,
    authorizationRoot: plan.anchor,
    targetDir: plan.target,
    assertPath,
  });
}

function assertSourceTree(source, fs) {
  try {
    assertNoSymlinkTree(source, fs);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError('Distribution data contains an unsupported symbolic link.', 'MISSING_CONFIGURATION', {
        cause: error,
      });
    }
    throw new CliError('Could not validate distribution data.', 'MISSING_CONFIGURATION', {
      cause: error,
    });
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// The resolved authorization boundary is the trusted root. Descendant
// mutations must remain synchronous and cwd-pinned so replacing their pathnames
// cannot redirect an in-flight operation; callers must control that root itself.
export function withPinnedTargetDirectory(directory, expectedIdentity, fs, operation) {
  const originalCwd = process.cwd();
  let changedDirectory = false;
  let operationStarted = false;
  try {
    if (!expectedIdentity) {
      throw new CliError('Target directory has no trusted identity.', 'REPOSITORY_CONFLICT');
    }
    process.chdir(directory);
    changedDirectory = true;
    const pinned = fs.statSync('.');
    if (!sameFileIdentity(expectedIdentity, pinned)) {
      throw new CliError('Target directory changed during validation.', 'REPOSITORY_CONFLICT');
    }
    operationStarted = true;
    return operation();
  } catch (error) {
    if (operationStarted || error instanceof CliError) throw error;
    throw new CliError('Could not pin the validated target directory.', 'REPOSITORY_CONFLICT', {
      cause: error,
    });
  } finally {
    if (changedDirectory) process.chdir(originalCwd);
  }
}

export function ensureContainedDirectory(guard, fs) {
  const segments = relative(guard.authorizationBoundary, guard.targetDir)
    .split(sep)
    .filter(Boolean);
  if (!isWithin(guard.authorizationBoundary, guard.targetDir)) {
    throw new CliError('Target path escapes its authorized root.', 'REPOSITORY_CONFLICT');
  }

  let targetIdentity = guard.authorizationBoundaryIdentity;
  withPinnedTargetDirectory(
    guard.authorizationBoundary,
    guard.authorizationBoundaryIdentity,
    fs,
    () => {
      for (const segment of segments) {
        let status = lstatIfExists(segment, fs);
        if (!status) {
          fs.mkdirSync(segment);
          status = fs.lstatSync(segment);
        }
        if (status.isSymbolicLink()) throwSymlinkConflict();
        if (!status.isDirectory()) {
          throw new CliError('Target path is not a directory.', 'REPOSITORY_CONFLICT');
        }
        const expected = Object.freeze({ dev: status.dev, ino: status.ino });
        process.chdir(segment);
        const pinned = fs.statSync('.');
        if (!sameFileIdentity(expected, pinned)) {
          throw new CliError('Target directory changed during validation.', 'REPOSITORY_CONFLICT');
        }
        targetIdentity = expected;
      }
    },
  );
  return targetIdentity;
}

function fileIdentity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

export function copyFileIntoPinnedDirectory(source, destinationName, fs) {
  const sourceStatus = fs.lstatSync(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw new CliError('Distribution data contains an unsupported entry.', 'MISSING_CONFIGURATION');
  }

  const sourceData = fs.readFileSync(source);
  const destinationStatus = lstatIfExists(destinationName, fs);
  if (destinationStatus?.isSymbolicLink() || (destinationStatus && !destinationStatus.isFile())) {
    throw new CliError('Managed destination path is not a regular file.', 'REPOSITORY_CONFLICT');
  }

  const expectedIdentity = destinationStatus ? fileIdentity(destinationStatus) : null;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = destinationStatus
    ? fs.constants.O_RDWR | noFollow
    : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;

  let descriptor;
  let openedIdentity;
  let originalData;
  let originalMode;
  let mutationStarted = false;

  const writeAll = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('Managed destination write did not make progress');
      }
      offset += written;
    }
  };

  try {
    descriptor = fs.openSync(destinationName, flags, sourceStatus.mode & 0o777);
    const openedStatus = fs.fstatSync(descriptor);
    if (!openedStatus.isFile()) {
      throw new CliError('Managed destination path is not a regular file.', 'REPOSITORY_CONFLICT');
    }
    openedIdentity = fileIdentity(openedStatus);
    if (expectedIdentity && !sameFileIdentity(expectedIdentity, openedIdentity)) {
      throw new CliError('Managed destination changed during validation.', 'REPOSITORY_CONFLICT');
    }
    const openedPathStatus = lstatIfExists(destinationName, fs);
    if (
      !openedPathStatus
      || openedPathStatus.isSymbolicLink()
      || !openedPathStatus.isFile()
      || !sameFileIdentity(openedIdentity, openedPathStatus)
    ) {
      throw new CliError('Managed destination changed during validation.', 'REPOSITORY_CONFLICT');
    }

    if (destinationStatus) {
      originalData = fs.readFileSync(descriptor);
      originalMode = openedStatus.mode & 0o777;
    }

    mutationStarted = true;
    fs.ftruncateSync(descriptor, 0);
    writeAll(sourceData);
    fs.fchmodSync(descriptor, sourceStatus.mode & 0o777);
    fs.fsyncSync(descriptor);

    const publishedStatus = lstatIfExists(destinationName, fs);
    if (!publishedStatus || !sameFileIdentity(openedIdentity, publishedStatus)) {
      throw new CliError('Managed destination changed during update.', 'REPOSITORY_CONFLICT');
    }
  } catch (error) {
    if (descriptor !== undefined && destinationStatus && mutationStarted && originalData !== undefined) {
      try {
        fs.ftruncateSync(descriptor, 0);
        writeAll(originalData);
        fs.fchmodSync(descriptor, originalMode);
        fs.fsyncSync(descriptor);
      } catch {
        // Best-effort restoration stays bound to the already verified descriptor.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function overlaySourceDirectory(sourceDirectory, fs) {
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = join(sourceDirectory, entry.name);
    const sourceStatus = fs.lstatSync(source);
    if (sourceStatus.isSymbolicLink()) {
      throw new CliError('Distribution data contains an unsupported symbolic link.', 'MISSING_CONFIGURATION');
    }
    if (sourceStatus.isFile()) {
      copyFileIntoPinnedDirectory(source, entry.name, fs);
      continue;
    }
    if (!sourceStatus.isDirectory()) {
      throw new CliError('Distribution data contains an unsupported entry.', 'MISSING_CONFIGURATION');
    }

    let destinationStatus = lstatIfExists(entry.name, fs);
    if (!destinationStatus) {
      fs.mkdirSync(entry.name, { mode: sourceStatus.mode & 0o777 });
      destinationStatus = fs.lstatSync(entry.name);
    }
    if (destinationStatus.isSymbolicLink()) throwSymlinkConflict();
    if (!destinationStatus.isDirectory()) {
      throw new CliError('Managed destination path is not a directory.', 'REPOSITORY_CONFLICT');
    }
    withPinnedTargetDirectory(
      entry.name,
      fileIdentity(destinationStatus),
      fs,
      () => overlaySourceDirectory(source, fs),
    );
  }
}

function overlayManagedDirectory(source, destinationName, fs) {
  const sourceStatus = fs.lstatSync(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isDirectory()) {
    throw new CliError('Distribution data contains an unsupported entry.', 'MISSING_CONFIGURATION');
  }

  let destinationStatus = lstatIfExists(destinationName, fs);
  if (!destinationStatus) {
    fs.mkdirSync(destinationName, { mode: sourceStatus.mode & 0o777 });
    destinationStatus = fs.lstatSync(destinationName);
  }
  if (destinationStatus.isSymbolicLink()) throwSymlinkConflict();
  if (!destinationStatus.isDirectory()) {
    throw new CliError('Managed destination path is not a directory.', 'REPOSITORY_CONFLICT');
  }
  withPinnedTargetDirectory(
    destinationName,
    fileIdentity(destinationStatus),
    fs,
    () => overlaySourceDirectory(source, fs),
  );
}

function buildGroupedChoices(skillNames, agentNames, separator) {
  const agentSet = new Set(agentNames);
  const remaining = new Set([...skillNames, ...agentNames]);
  const choices = [];

  for (const [label, members] of Object.entries(SKILL_CATEGORIES)) {
    const inGroup = members.filter(member => remaining.has(member));
    if (inGroup.length === 0) continue;
    choices.push(separator(`── ${label} ──`));
    for (const name of inGroup) {
      choices.push({
        name: agentSet.has(name) ? `${name}  [agent]` : name,
        value: name,
        checked: true,
      });
      remaining.delete(name);
    }
  }

  if (remaining.size > 0) {
    choices.push(separator('── Other ──'));
    for (const name of remaining) {
      choices.push({
        name: agentSet.has(name) ? `${name}  [agent]` : name,
        value: name,
        checked: true,
      });
    }
  }
  return choices;
}

export function findProjectRoot(startDir, fs) {
  let directory = resolve(startDir);
  while (true) {
    if (fs.existsSync(join(directory, '.git')) || fs.existsSync(join(directory, 'package.json'))) {
      return directory;
    }
    const parent = join(directory, '..');
    if (parent === directory) return null;
    directory = parent;
  }
}

function normalizeTarget(target) {
  if (!target) return null;
  if (target === 'both') return ['claude', 'codex'];
  if (target === 'claude' || target === 'codex') return [target];
  return null;
}

export function resolveTargetDir(platform, parsed, dependencies) {
  const { cwd, env, fs, home } = dependencies;
  if (parsed.flags.global) {
    if (platform === 'claude') return join(home(), '.claude', 'skills');
    const codexHome = env.CODEX_HOME ? resolve(cwd(), env.CODEX_HOME) : join(home(), '.codex');
    return join(codexHome, 'skills');
  }

  const root = findProjectRoot(cwd(), fs);
  if (!root) {
    throw new CliError(
      'Could not find project root (no .git or package.json found in any parent directory).\nRun from inside a project, or use --global to install globally.',
      'INVALID_INPUT',
    );
  }

  if (platform === 'claude') return join(root, '.claude', 'skills');
  return join(root, '.codex', 'skills');
}

function resolveAuthorizationAnchor(platform, parsed, dependencies) {
  const { cwd, env, fs, home } = dependencies;
  if (!parsed.flags.global) {
    const root = findProjectRoot(cwd(), fs);
    if (!root) {
      throw new CliError(
        'Could not find project root (no .git or package.json found in any parent directory).\nRun from inside a project, or use --global to install globally.',
        'INVALID_INPUT',
      );
    }
    return root;
  }
  if (platform === 'codex' && env.CODEX_HOME) {
    return dirname(resolve(cwd(), env.CODEX_HOME));
  }
  return home();
}

export function resolveTargetLocation(platform, parsed, dependencies) {
  const lexicalTarget = resolveTargetDir(platform, parsed, dependencies);
  const authorizationAnchor = resolveAuthorizationAnchor(platform, parsed, dependencies);
  const guard = createMutationGuard(authorizationAnchor, lexicalTarget, dependencies.fs);
  return {
    target: platform,
    dir: guard.targetDir,
    displayDir: lexicalTarget,
    authorizationAnchor: guard.authorizationRoot,
    guard,
  };
}

async function resolveTargets(action, parsed, dependencies) {
  const { output, prompt } = dependencies;
  if (parsed.flags.claude && parsed.flags.codex) return ['claude', 'codex'];
  if (parsed.flags.claude) return ['claude'];
  if (parsed.flags.codex) return ['codex'];

  const target = parsed.flags.target;
  const fromTargetFlag = typeof target === 'string'
    ? normalizeTarget(target.toLowerCase())
    : null;
  if (target && !fromTargetFlag) {
    throw new CliError("Invalid --target value. Use 'claude', 'codex', or 'both'.", 'INVALID_INPUT');
  }
  if (fromTargetFlag) return fromTargetFlag;

  let selected;
  try {
    selected = await prompt({
      message: `Select destinations to ${action}:`,
      choices: [
        { name: 'Claude Code', value: 'claude', checked: true },
        { name: 'Codex', value: 'codex', checked: true },
      ],
    });
  } catch {
    output.log('\nCancelled.');
    return null;
  }

  if (selected.length === 0) {
    output.log('No destinations selected. Nothing to do.');
    return null;
  }
  return selected;
}

function directoryNames(directory, fs, { required = false } = {}) {
  if (!fs.existsSync(directory)) {
    if (required) {
      throw new CliError(
        "dist/skills/ not found. Run 'npm run build' or reinstall the package.",
        'MISSING_CONFIGURATION',
      );
    }
    return [];
  }
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    throw new CliError('Could not read the installed distribution data.', 'MISSING_CONFIGURATION', {
      cause: error,
    });
  }
}

export function getSkillNames(dependencies) {
  return directoryNames(distributionPaths(dependencies.packageRoot).skills, dependencies.fs, { required: true });
}

export function getAgentNames(dependencies) {
  return directoryNames(distributionPaths(dependencies.packageRoot).agents, dependencies.fs);
}

export function getMandatoryNames(dependencies) {
  return directoryNames(distributionPaths(dependencies.packageRoot).mandatory, dependencies.fs);
}

async function readBoundedUpdateResponse(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Update metadata exceeds the response limit');
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error('Update metadata exceeds the response limit');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Update metadata exceeds the response limit');
    }
    return text;
  }

  if (typeof response.json === 'function') {
    const text = JSON.stringify(await response.json());
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Update metadata exceeds the response limit');
    }
    return text;
  }

  throw new Error('Update metadata has no readable body');
}

export async function checkForUpdate(dependencies) {
  const { fetch, fs, output, packageRoot } = dependencies;
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8')); }
  catch { return; }
  // This standalone prerelease has no published namespace or update channel yet.
  if (metadata.private === true) return;
  const timeoutMs = Number.isFinite(dependencies.updateCheckTimeoutMs)
    ? Math.max(1, dependencies.updateCheckTimeoutMs)
    : DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  const maxResponseBytes = Number.isFinite(dependencies.maxUpdateResponseBytes)
    ? Math.max(1, dependencies.maxUpdateResponseBytes)
    : DEFAULT_MAX_UPDATE_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(metadata.name ?? '@agilno/rivet')}`,
      { signal: controller.signal },
    );
    if (!response.ok) return;
    const data = JSON.parse(await readBoundedUpdateResponse(response, maxResponseBytes));
    const latest = data['dist-tags']?.latest;
    const current = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    if (latest && latest !== current) {
      output.log(`\nUpdate available: ${current} → ${latest}`);
      output.log('Run: npm install -g @agilno/rivet@latest');
    }
  } catch {
    // The install/uninstall operation must not depend on registry availability.
  } finally {
    clearTimeout(timeout);
  }
}

export async function install(parsed, dependencies) {
  if (parsed.flags['project-runtime']) {
    const { projectRuntimeInstall } = await import('../install/project-runtime.js');
    return projectRuntimeInstall(parsed, dependencies);
  }
  if (parsed.flags.minimal) {
    const { managedInstall } = await import('../install/managed.js');
    return managedInstall(parsed, dependencies);
  }
  const { fs, output, packageRoot, separator } = dependencies;
  const paths = distributionPaths(packageRoot);
  const mandatoryNames = getMandatoryNames(dependencies);
  const skillNames = getSkillNames(dependencies);
  const agentNames = getAgentNames(dependencies);
  const agentSet = new Set(agentNames);

  if (mandatoryNames.length > 0) {
    output.log('\nMandatory skills (always installed — cannot be deselected):');
    mandatoryNames.forEach(name => output.log(`  ✔  ${name}`));
    output.log('');
  }

  const targets = await resolveTargets('install', parsed, dependencies);
  if (!targets) return EXIT_CODES.SUCCESS;
  const targetDirs = targets.map(target => resolveTargetLocation(target, parsed, dependencies));

  let selectedOptional;
  if (parsed.flags.all) {
    selectedOptional = [...skillNames, ...agentNames];
  } else {
    try {
      selectedOptional = await dependencies.prompt({
        message: 'Select optional skills to install:',
        choices: buildGroupedChoices(skillNames, agentNames, separator),
      });
    } catch {
      output.log('\nCancelled.');
      return EXIT_CODES.SUCCESS;
    }
  }

  for (const targetLocation of targetDirs) {
    const { target, dir, guard } = targetLocation;
    try {
      guard.assertPath(dir);
      targetLocation.identity = ensureContainedDirectory(guard, fs);
      guard.assertPath(dir);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`Could not create the ${target} target directory.`, 'REPOSITORY_CONFLICT', {
        cause: error,
      });
    }
  }

  for (const { target, dir, guard, identity } of targetDirs) {
    for (const name of mandatoryNames) {
      const source = join(paths.mandatory, name);
      const destination = join(dir, installedSkillName(name));
      try {
        assertSourceTree(source, fs);
        guard.assertPath(destination);
        withPinnedTargetDirectory(dir, identity, fs, () => {
          overlayManagedDirectory(source, installedSkillName(name), fs);
        });
        guard.assertPath(destination);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(
          `Failed to install mandatory skill '${name}' to ${target}.`,
          'REPOSITORY_CONFLICT',
          { cause: error },
        );
      }
    }
  }

  for (const { target, dir, guard, identity } of targetDirs) {
    for (const name of selectedOptional) {
      const sourceRoot = agentSet.has(name) ? paths.agents : paths.skills;
      const source = join(sourceRoot, name);
      const destination = join(dir, installedSkillName(name));
      try {
        assertSourceTree(source, fs);
        guard.assertPath(destination);
        withPinnedTargetDirectory(dir, identity, fs, () => {
          overlayManagedDirectory(source, installedSkillName(name), fs);
        });
        guard.assertPath(destination);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`Failed to install '${name}' to ${target}.`, 'REPOSITORY_CONFLICT', {
          cause: error,
        });
      }
    }
  }

  const selectedSkills = selectedOptional.filter(name => !agentSet.has(name));
  const selectedAgents = selectedOptional.filter(name => agentSet.has(name));
  const scope = parsed.flags.global ? 'globally' : 'in project';
  const totalCount = mandatoryNames.length + selectedOptional.length;
  output.log(`\nInstalled ${totalCount} skills ${scope} for: ${targets.join(', ')}`);
  if (mandatoryNames.length > 0) {
    output.log(`  Mandatory (${mandatoryNames.length}):`);
    mandatoryNames.forEach(name => output.log(`    /  ${installedSkillName(name)}`));
  }
  if (selectedSkills.length > 0) {
    output.log(`  Skills (${selectedSkills.length}):`);
    selectedSkills.forEach(name => output.log(`    /  ${installedSkillName(name)}`));
  }
  if (selectedAgents.length > 0) {
    output.log(`  Agents (${selectedAgents.length}):`);
    selectedAgents.forEach(name => output.log(`    /  ${installedSkillName(name)}`));
  }
  targetDirs.forEach(({ target, displayDir }) => output.log(`  -> ${target}: ${displayDir}`));

  const governanceSource = join(packageRoot, 'dist', 'governance');
  if (fs.existsSync(governanceSource) && targets.includes('claude')) {
    const claudeTarget = targetDirs.find(({ target }) => target === 'claude');
    const claudeDir = join(claudeTarget.dir, '..');
    const displayClaudeDir = join(claudeTarget.displayDir, '..');
    const governanceGuard = createMutationGuard(
      claudeTarget.authorizationAnchor,
      claudeDir,
      fs,
    );
    const safeClaudeDir = governanceGuard.targetDir;
    let governanceIdentity;
    try {
      governanceGuard.assertPath(safeClaudeDir);
      governanceIdentity = ensureContainedDirectory(governanceGuard, fs);
      governanceGuard.assertPath(safeClaudeDir);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('Could not create the Claude governance directory.', 'REPOSITORY_CONFLICT', {
        cause: error,
      });
    }
    let files;
    try {
      files = fs.readdirSync(governanceSource).filter(file => file.endsWith('.md'));
    } catch (error) {
      throw new CliError('Could not read governance distribution data.', 'MISSING_CONFIGURATION', {
        cause: error,
      });
    }
    const copied = [];
    for (const file of files) {
      const source = join(governanceSource, file);
      const destination = join(safeClaudeDir, file);
      if (!fs.existsSync(destination)) {
        try {
          assertSourceTree(source, fs);
          governanceGuard.assertPath(destination);
          withPinnedTargetDirectory(safeClaudeDir, governanceIdentity, fs, () => {
            const status = lstatIfExists(file, fs);
            if (status?.isSymbolicLink()) throwSymlinkConflict();
            if (status) {
              throw new CliError('Governance destination changed during validation.', 'REPOSITORY_CONFLICT');
            }
            copyFileIntoPinnedDirectory(source, file, fs);
          });
          governanceGuard.assertPath(destination);
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(`Failed to copy governance template '${file}'.`, 'REPOSITORY_CONFLICT', {
            cause: error,
          });
        }
        copied.push(file);
      }
    }
    if (copied.length > 0) {
      output.log(`\nCopied governance templates to ${displayClaudeDir}:`);
      copied.forEach(file => output.log(`  ${file}`));
      output.log('Customize these files for your project.');
    }
  }

  await checkForUpdate(dependencies);
  return EXIT_CODES.SUCCESS;
}
