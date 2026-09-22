import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CliError, EXIT_CODES } from '../cli/output.js';
import {
  checkForUpdate,
  installedSkillName,
  getAgentNames,
  getMandatoryNames,
  getSkillNames,
  resolveTargetLocation,
  withPinnedTargetDirectory,
} from './install.js';

function lstatIfExists(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function fileIdentity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function allocateQuarantineName(fs) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.rivet-uninstall-${randomUUID()}`;
    if (!lstatIfExists(name, fs)) return name;
  }
  throw new CliError('Could not allocate a private uninstall entry.', 'REPOSITORY_CONFLICT');
}

function restoreQuarantine(fs, quarantineName, destinationName, expectedIdentity, requireIdentity = true) {
  const quarantineStatus = lstatIfExists(quarantineName, fs);
  if (!quarantineStatus) return false;
  if (requireIdentity && !sameFileIdentity(expectedIdentity, quarantineStatus)) return false;
  if (lstatIfExists(destinationName, fs)) return false;
  fs.renameSync(quarantineName, destinationName);
  return true;
}

function removeSelectedEntry(name, fs) {
  const selectedStatus = lstatIfExists(name, fs);
  if (!selectedStatus) return false;
  if (selectedStatus.isSymbolicLink()) {
    throw new CliError('Managed uninstall entry is a symbolic link.', 'REPOSITORY_CONFLICT');
  }

  const expectedIdentity = fileIdentity(selectedStatus);
  const quarantineName = allocateQuarantineName(fs);
  fs.renameSync(name, quarantineName);

  const quarantinedStatus = lstatIfExists(quarantineName, fs);
  if (!quarantinedStatus || !sameFileIdentity(expectedIdentity, quarantinedStatus)) {
    try {
      restoreQuarantine(fs, quarantineName, name, expectedIdentity, false);
    } catch {
      // A mismatched entry is never recursively removed.
    }
    throw new CliError('Managed uninstall entry changed during validation.', 'REPOSITORY_CONFLICT');
  }

  try {
    fs.rmSync(quarantineName, { recursive: true, force: false });
  } catch (error) {
    try {
      restoreQuarantine(fs, quarantineName, name, expectedIdentity, true);
    } catch {
      // Best-effort rollback preserves a matching quarantine for manual recovery.
    }
    throw error;
  }
  return true;
}

async function resolveTargets(parsed, dependencies) {
  if (parsed.flags.claude && parsed.flags.codex) return ['claude', 'codex'];
  if (parsed.flags.claude) return ['claude'];
  if (parsed.flags.codex) return ['codex'];

  const target = parsed.flags.target;
  if (typeof target === 'string') {
    const normalized = target.toLowerCase();
    if (normalized === 'both') return ['claude', 'codex'];
    if (normalized === 'claude' || normalized === 'codex') return [normalized];
  }
  if (target) {
    throw new CliError("Invalid --target value. Use 'claude', 'codex', or 'both'.", 'INVALID_INPUT');
  }

  try {
    const selected = await dependencies.prompt({
      message: 'Select destinations to uninstall:',
      choices: [
        { name: 'Claude Code', value: 'claude', checked: true },
        { name: 'Codex', value: 'codex', checked: true },
      ],
    });
    if (selected.length === 0) {
      dependencies.output.log('No destinations selected. Nothing to do.');
      return null;
    }
    return selected;
  } catch {
    dependencies.output.log('\nCancelled.');
    return null;
  }
}

export async function uninstall(parsed, dependencies) {
  const { fs, output, prompt } = dependencies;
  const targets = await resolveTargets(parsed, dependencies);
  if (!targets) return EXIT_CODES.SUCCESS;
  const targetDirs = targets.map(target => resolveTargetLocation(target, parsed, dependencies));

  for (const targetLocation of targetDirs) {
    targetLocation.identity = targetLocation.guard.assertPath(targetLocation.dir);
  }

  const existingTargetDirs = targetDirs.filter(({ dir }) => fs.existsSync(dir));
  if (existingTargetDirs.length === 0) {
    output.warn('Warning: skills directories not found for selected targets. Nothing to uninstall.');
    return EXIT_CODES.SUCCESS;
  }

  const mandatorySet = new Set(getMandatoryNames(dependencies).map(installedSkillName));
  const existingOptional = new Set();
  const existingMandatory = new Set();
  const packageNames = [
    ...getSkillNames(dependencies),
    ...getAgentNames(dependencies),
    ...getMandatoryNames(dependencies),
  ].map(installedSkillName);
  for (const { dir } of existingTargetDirs) {
    for (const name of packageNames) {
      if (fs.existsSync(join(dir, name))) {
        if (mandatorySet.has(name)) existingMandatory.add(name);
        else existingOptional.add(name);
      }
    }
  }

  const allOptional = [...existingOptional];
  const allMandatory = [...existingMandatory];
  if (allOptional.length === 0 && allMandatory.length === 0) {
    output.warn("Warning: None of this package's skills were found at selected targets. Nothing removed.");
    return EXIT_CODES.SUCCESS;
  }

  let selectedOptional;
  let removeMandatory = false;
  if (parsed.flags.all) {
    selectedOptional = allOptional;
    removeMandatory = true;
  } else {
    if (allMandatory.length > 0) {
      output.log('\nMandatory skills (included in uninstall by default):');
      allMandatory.forEach(name => output.log(`  [required]  ${name}`));
    }
    try {
      const choices = [
        ...allMandatory.map(name => ({ name: `${name} [mandatory]`, value: `mandatory:${name}`, checked: true })),
        ...allOptional.map(name => ({ name, value: name, checked: true })),
      ];
      const raw = await prompt({
        message: 'Select skills to uninstall (mandatory included by default):',
        choices,
      });
      selectedOptional = raw.filter(value => !value.startsWith('mandatory:')).map(value => value);
      removeMandatory = raw.some(value => value.startsWith('mandatory:'));
    } catch {
      output.log('\nCancelled.');
      return EXIT_CODES.SUCCESS;
    }
    if (!removeMandatory && selectedOptional.length === 0) {
      output.log('No skills selected. Nothing uninstalled.');
      return EXIT_CODES.SUCCESS;
    }
  }

  const selected = [
    ...(removeMandatory ? allMandatory : []),
    ...selectedOptional,
  ];
  const removed = [];
  for (const name of selected) {
    let removedSomewhere = false;
    for (const { dir, guard, identity } of existingTargetDirs) {
      const destination = join(dir, name);
      guard.assertPath(destination);
      if (fs.existsSync(destination)) {
        try {
          guard.assertPath(destination);
          const didRemove = withPinnedTargetDirectory(
            dir,
            identity,
            fs,
            () => removeSelectedEntry(name, fs),
          );
          guard.assertPath(dir);
          removedSomewhere ||= didRemove;
        } catch (error) {
          throw new CliError(`Failed to uninstall '${name}'.`, 'REPOSITORY_CONFLICT', {
            cause: error,
          });
        }
      }
    }
    if (removedSomewhere) removed.push(name);
  }

  output.log(`Uninstalled ${removed.length} skills for: ${targets.join(', ')}`);
  removed.forEach(name => output.log(`  -  ${name}`));
  existingTargetDirs.forEach(({ target, displayDir }) => {
    output.log(`  -> ${target}: ${displayDir}`);
  });
  await checkForUpdate(dependencies);
  return EXIT_CODES.SUCCESS;
}
