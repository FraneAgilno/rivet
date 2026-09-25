import { validateWorkRequest } from '../work-request/contract.js';
import { immutableJson } from '../clients/contract.js';
import { DeliveryError } from './contract.js';

const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
function requireTarget(condition) {
  if (!condition) throw new DeliveryError('tracker-target');
}

function issueUrl(value, kind, issueKey) {
  requireTarget(typeof value === 'string' && value.length <= 2048);
  const url = new URL(value);
  requireTarget(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  const segments = url.pathname.split('/').filter(Boolean);
  requireTarget(kind === 'jira'
    ? segments.length === 2 && segments[0] === 'browse' && segments[1] === issueKey
    : [3, 4].includes(segments.length) && segments[1] === 'issue' && segments[2] === issueKey);
  return value;
}

/** Derive a tracker identity from the approved run; callers cannot supply a different ticket. */
export function trackerTargetFromRun(run, candidate) {
  try {
    requireTarget(typeof run?.runId === 'string' && run.runId.length > 0 && run.runId === candidate?.runId);
    // Snapshot source data before validation so the validated identity cannot change afterward.
    const request = immutableJson(run.workRequest);
    validateWorkRequest(request);
    requireTarget(run.featurePlan?.workRequestDigest === request.digest);
    let kind = request.source.kind;
    let issueKey = request.source.ref;
    let url = request.source.url;
    if (kind === 'host-observation') {
      const sources = request.context.sources;
      const primary = sources[0];
      const matches = sources.filter(source => `${source.providerId}:${source.resourceId}` === request.source.ref);
      requireTarget(matches.length === 1 && matches[0] === primary);
      requireTarget(request.source.revision === `sha256:${primary.contentDigest}` && url === primary.url);
      requireTarget(primary.content.title === request.title && primary.content.description === request.description);
      requireTarget(Array.isArray(primary.content.acceptanceCriteria));
      const criteria = [...new Set([...primary.content.acceptanceCriteria, ...request.context.userAcceptanceCriteria])];
      requireTarget(JSON.stringify(criteria) === JSON.stringify(request.acceptanceCriteria));
      kind = primary.provider;
      issueKey = primary.resourceId;
      url = primary.url;
    }
    requireTarget(['jira', 'linear'].includes(kind) && typeof issueKey === 'string' && ISSUE_KEY.test(issueKey));
    return Object.freeze({ kind, issueKey, issueUrl: issueUrl(url, kind, issueKey), requestDigest: request.digest });
  } catch {
    throw new DeliveryError('tracker-target');
  }
}
