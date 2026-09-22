import { EVIDENCE_TYPES } from '../config/defaults.js';
import { graphFailure, sanitizeGraphOperation, validatedGraphSnapshot } from './validate.js';

const EVIDENCE_TYPE_SET = new Set(EVIDENCE_TYPES);
const INTERNAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function capturedArray(value, maximum, reason, transform = item => item) {
  if (!Array.isArray(value)) graphFailure(reason);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maximum) graphFailure(reason);
  const captured = [];
  for (let index = 0; index < length; index += 1) captured.push(transform(value[index], index));
  return captured;
}

function validInternalId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && INTERNAL_ID.test(value);
}

function capturedEvidenceItems(items) {
  const ids = new Set();
  return capturedArray(items, 1000, 'invalid-evidence-items', item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) graphFailure('invalid-evidence-item');
    const captured = {
      id: item.id,
      type: item.type,
      approvalState: item.approvalState,
    };
    if (!validInternalId(captured.id) || !EVIDENCE_TYPE_SET.has(captured.type)) {
      graphFailure('invalid-evidence-item');
    }
    if (ids.has(captured.id)) graphFailure('duplicate-evidence-item');
    ids.add(captured.id);
    return captured;
  });
}

function capturedRequiredEvidence(required) {
  const captured = capturedArray(required, EVIDENCE_TYPES.length, 'invalid-required-evidence');
  if (captured.length < 1) {
    graphFailure('invalid-required-evidence');
  }
  if (captured.some(type => !EVIDENCE_TYPE_SET.has(type)) || new Set(captured).size !== captured.length) {
    graphFailure('invalid-required-evidence');
  }
  return captured;
}

function capturedReferences(references) {
  const captured = capturedArray(references, 64, 'invalid-evidence-references');
  if (captured.length < 1 || captured.some(reference => !validInternalId(reference)) || new Set(captured).size !== captured.length) {
    graphFailure('invalid-evidence-references');
  }
  return captured;
}

function capturedNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) graphFailure('invalid-node');
  const id = node.id;
  const requiredEvidenceTypes = node.requiredEvidenceTypes;
  const evidenceRefs = node.evidenceRefs;
  const completionProfile = node.completionProfile;
  if (!validInternalId(id) || !validInternalId(completionProfile)) graphFailure('invalid-node');
  return {
    id,
    requiredEvidenceTypes: capturedRequiredEvidence(requiredEvidenceTypes),
    evidenceRefs: capturedReferences(evidenceRefs),
    completionProfile,
  };
}

function capturedProfile(profile) {
  if (profile === undefined) return undefined;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) graphFailure('invalid-completion-profile');
  const id = profile.id;
  const requiredEvidence = profile.requiredEvidence;
  if (!validInternalId(id)) graphFailure('invalid-completion-profile');
  return { id, requiredEvidence: capturedRequiredEvidence(requiredEvidence) };
}

function evidenceReferenceStatus(node, evidenceItems) {
  const references = new Set(node.evidenceRefs);
  const supplied = new Set(evidenceItems.map(item => item.id));
  return {
    missingRefs: sorted([...references].filter(reference => !supplied.has(reference))),
    unboundRefs: sorted([...supplied].filter(reference => !references.has(reference))),
  };
}

function completionStatusCaptured(node, evidenceItems, profile) {
  if (profile && profile.id !== node.completionProfile) {
    graphFailure('completion-profile-mismatch');
  }

  const required = node.requiredEvidenceTypes;
  const sortedRequired = sorted(required);
  const sortedProfileRequired = profile ? sorted(profile.requiredEvidence) : sortedRequired;
  const profileExact = !profile || (
    sortedProfileRequired.length === sortedRequired.length
    && sortedProfileRequired.every((type, index) => type === sortedRequired[index])
  );
  const requiredCounts = counts(required);
  const actualCounts = counts(evidenceItems.map(item => item.type));
  const missing = [];
  const unexpected = [];

  for (const [type, count] of requiredCounts) {
    for (let index = actualCounts.get(type) ?? 0; index < count; index += 1) missing.push(type);
  }
  for (const [type, count] of actualCounts) {
    for (let index = requiredCounts.get(type) ?? 0; index < count; index += 1) unexpected.push(type);
  }
  const unapproved = evidenceItems
    .filter(item => requiredCounts.has(item.type) && item.approvalState !== 'approved')
    .map(item => item.type);
  const { missingRefs, unboundRefs } = evidenceReferenceStatus(node, evidenceItems);

  const status = {
    complete: (
      profileExact
      && missing.length === 0
      && unexpected.length === 0
      && unapproved.length === 0
      && missingRefs.length === 0
      && unboundRefs.length === 0
    ),
    missing: sorted(missing),
    unexpected: sorted(unexpected),
    unapproved: sorted(unapproved),
    missingRefs,
    unboundRefs,
  };
  return status;
}

export function completionStatus(node, evidenceItems, profile) {
  return sanitizeGraphOperation(
    () => completionStatusCaptured(
      capturedNode(node),
      capturedEvidenceItems(evidenceItems),
      capturedProfile(profile),
    ),
    'invalid-evidence-item',
  );
}

function graphCompletionStatusUnsafe(graph, evidenceItems, profiles) {
  const stableGraph = validatedGraphSnapshot(graph);
  const stableEvidenceItems = capturedEvidenceItems(evidenceItems);
  const stableProfiles = capturedArray(profiles, 32, 'invalid-completion-profiles', capturedProfile);
  const profileMap = new Map();
  for (const profile of stableProfiles) {
    if (profileMap.has(profile.id)) graphFailure('invalid-completion-profile');
    profileMap.set(profile.id, profile);
  }

  const nodes = stableGraph.nodes.map(node => {
    const references = new Set(node.evidenceRefs);
    const selected = stableEvidenceItems.filter(item => references.has(item.id));
    const profile = profileMap.get(node.completionProfile);
    if (stableProfiles.length > 0 && !profile) graphFailure('missing-completion-profile');
    const evidence = completionStatusCaptured(node, selected, profile);
    return { id: node.id, complete: node.status === 'completed' && evidence.complete, evidence };
  });
  const referenced = new Set(stableGraph.nodes.flatMap(node => node.evidenceRefs));
  const unreferenced = sorted(stableEvidenceItems.filter(item => !referenced.has(item.id)).map(item => item.id));
  return {
    complete: stableGraph.status === 'completed' && nodes.every(node => node.complete) && unreferenced.length === 0,
    nodes,
    unreferenced,
  };
}

export function graphCompletionStatus(graph, evidenceItems, profiles = []) {
  return sanitizeGraphOperation(
    () => graphCompletionStatusUnsafe(graph, evidenceItems, profiles),
    'invalid-evidence-item',
  );
}
