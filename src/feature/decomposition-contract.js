import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { immutableJson } from '../clients/contract.js';

export const FEATURE_DECOMPOSITION_KIND = 'agilno.feature-decomposition';

const schema = JSON.parse(readFileSync(
  new URL('../../schemas/feature-decomposition.schema.json', import.meta.url),
  'utf8',
));
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

export class FeatureDecompositionError extends Error {
  constructor() {
    super('Feature decomposition is invalid.');
    this.name = 'FeatureDecompositionError';
    this.code = 'ERR_INVALID_FEATURE_DECOMPOSITION';
    this.safeMessage = this.message;
  }
}

function fail() { throw new FeatureDecompositionError(); }

export function featureDecompositionResultContract() {
  return immutableJson({
    version: 1,
    kind: FEATURE_DECOMPOSITION_KIND,
    framing: 'Emit exactly one JSON object matching this result schema on stdout. Emit no Markdown or commentary.',
    instructions: [
      'Inspect the repository read-only and propose between one and sixteen implementation work items.',
      'Use only normalized repository-relative owned paths; never use .git, .rivet, or configured sensitive paths.',
      'Owned path components must not end in a dot or space or use Windows reserved names. Paths within each work item must be unique ignoring case.',
      'If contract.repair is present, a prior proposal was rejected for its reason code. Reinspect the repository and return a complete corrected decomposition under the same policy; do not omit required implementation work to avoid validation.',
      'List only files the work item is expected to change, including adjacent style modules, configuration, fixtures, and tests when they will be modified; do not include files that are merely read or reused, and never rely on an unlisted support file.',
      'Allocate every request acceptance criterion at least once using one-based acceptance-criterion indexes; criteria may support multiple work items.',
      'Do not emit roles, providers, authority, budgets, commands, evidence, dependencies, approval gates, or other policy fields.',
    ],
    schema,
  });
}

export function createFeatureDecomposition(value, acceptanceCriterionCount) {
  let result;
  try { result = immutableJson(value); } catch { fail(); }
  if (!Number.isSafeInteger(acceptanceCriterionCount) || acceptanceCriterionCount < 1 || acceptanceCriterionCount > 256
    || !validateSchema(result)) fail();
  const allocated = new Set();
  for (const item of result.workItems) {
    for (const index of item.acceptanceCriterionIndexes) {
      if (index > acceptanceCriterionCount) fail();
      allocated.add(index);
    }
  }
  if (allocated.size !== acceptanceCriterionCount) fail();
  return result;
}
