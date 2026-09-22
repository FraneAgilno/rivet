import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { immutableJson } from '../clients/contract.js';
import { validateLaunchPayload } from '../prompts/launch-contract.js';

export const WORK_ACTION_KIND = 'agilno.work-action';

const schema = JSON.parse(readFileSync(new URL('../../schemas/work-action.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

export class WorkActionError extends Error {
  constructor() {
    super('Host work action is invalid.');
    this.name = 'WorkActionError';
    this.code = 'ERR_INVALID_WORK_ACTION';
    this.safeMessage = this.message;
  }
}

function fail() { throw new WorkActionError(); }

export function createWorkAction(input) {
  return validateWorkAction({ schemaVersion: 1, kind: WORK_ACTION_KIND, ...input });
}

export function validateWorkAction(input) {
  let captured;
  try { captured = immutableJson(input); } catch { fail(); }
  if (!validateSchema(captured)) fail();
  let contract;
  try { contract = validateLaunchPayload(captured.payload); } catch { fail(); }
  if (contract.nodeId !== captured.nodeId
    || contract.worktree.reservationId !== captured.reservationId) fail();
  return captured;
}
