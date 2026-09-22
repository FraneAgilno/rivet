import { CliError, EXIT_CODES } from '../cli/output.js';
import { collectEvidenceBundle } from '../evidence/collect.js';

export async function createEvidence(input) {
  const bundle = await collectEvidenceBundle(input);
  return Object.freeze({
    ok: true,
    status: bundle.manifest.status,
    bundle,
  });
}

export async function evidenceCommand(parsed, dependencies = {}) {
  if (!parsed || parsed.command !== 'evidence' || parsed.subcommand !== null
    || !Array.isArray(parsed.operands) || parsed.operands.length !== 0
    || !parsed.flags || Reflect.ownKeys(parsed.flags).some(key => key !== 'json')) {
    throw new CliError('Evidence command options are invalid.', 'INVALID_INPUT');
  }
  const context = dependencies.evidence;
  if (!context || typeof context.requestFor !== 'function') {
    throw new CliError('Evidence collection is not configured.', 'MISSING_CONFIGURATION');
  }
  const request = await context.requestFor(Object.freeze({ command: 'evidence' }));
  const result = await createEvidence(request);
  if (parsed.flags.json) {
    dependencies.output.json({
      ok: true,
      command: 'evidence',
      result: {
        status: result.status,
        runDirectory: result.bundle.runDirectory,
        manifestPath: result.bundle.manifestPath,
        manifestChecksum: result.bundle.manifestChecksum,
        archivePath: result.bundle.archivePath,
        archiveChecksum: result.bundle.archiveChecksum,
        durablyPublished: result.bundle.durablyPublished,
        publication: result.bundle.publication,
      },
    });
  } else {
    dependencies.output.log('Evidence: ' + result.status + '. Archive SHA-256: ' + result.bundle.archiveChecksum + '.');
  }
  return EXIT_CODES.SUCCESS;
}
