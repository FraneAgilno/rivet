import { graphFailure, sanitizeGraphOperation } from './validate.js';

const budget = (timeMinutes, tokenLimit, costUsd, taskLimit) => ({ timeMinutes, tokenLimit, costUsd, taskLimit });

function node({
  id, parentId, objective, role, ownerId, dependencies, authorityScopes,
  nodeBudget, completionProfile, requiredEvidenceTypes, evidenceRefs, status, approvalGate,
}) {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    objective,
    owner: { role, id: ownerId },
    dependencies,
    authorityScopes,
    budget: nodeBudget,
    completionProfile,
    requiredEvidenceTypes,
    evidenceRefs,
    status,
    ...(approvalGate ? { approvalGate } : {}),
  };
}

function commonNodes(goalPrefix = '') {
  return [
    node({
      id: 'boss-plan', objective: `${goalPrefix}Own the approved delivery goal`, role: 'boss', ownerId: 'portfolio-boss',
      dependencies: [], authorityScopes: ['plan', 'implement', 'delegate', 'verify'],
      nodeBudget: budget(480, 500000, 100, 100), completionProfile: 'delivery',
      requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'],
      evidenceRefs: ['boss-commit', 'boss-test', 'boss-review', 'boss-approval'], status: 'completed',
    }),
    node({
      id: 'manager-plan', parentId: 'boss-plan', objective: `${goalPrefix}Coordinate implementation`, role: 'manager', ownerId: 'engineering-manager',
      dependencies: ['boss-plan'], authorityScopes: ['implement', 'delegate', 'verify'],
      nodeBudget: budget(240, 250000, 50, 40), completionProfile: 'engineering',
      requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['manager-commit', 'manager-test'], status: 'completed',
    }),
  ];
}

function parallelFanIn() {
  const nodes = commonNodes();
  nodes.push(
    node({
      id: 'api-contract', parentId: 'manager-plan', objective: 'Define the completed API contract', role: 'worker', ownerId: 'api-contract-worker',
      dependencies: ['manager-plan'], authorityScopes: ['implement', 'verify'], nodeBudget: budget(60, 30000, 6, 5),
      completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['contract-commit', 'contract-test'], status: 'completed',
    }),
    node({
      id: 'design', parentId: 'manager-plan', objective: 'Implement approved component states', role: 'worker', ownerId: 'design-worker',
      dependencies: ['manager-plan'], authorityScopes: ['implement', 'verify'], nodeBudget: budget(90, 50000, 10, 8),
      completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['design-commit', 'design-test'], status: 'ready',
    }),
    node({
      id: 'api', parentId: 'manager-plan', objective: 'Implement the agenda API', role: 'worker', ownerId: 'api-worker',
      dependencies: ['api-contract'], authorityScopes: ['implement', 'verify'], nodeBudget: budget(120, 60000, 12, 10),
      completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test'], evidenceRefs: ['api-commit', 'api-test'], status: 'ready',
    }),
    node({
      id: 'integration', parentId: 'manager-plan', objective: 'Integrate UI and API journeys', role: 'worker', ownerId: 'integration-worker',
      dependencies: ['design', 'api'], authorityScopes: ['implement', 'verify'], nodeBudget: budget(120, 70000, 14, 12),
      completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test', 'journey'],
      evidenceRefs: ['integration-commit', 'integration-test', 'integration-journey'], status: 'ready',
    }),
    node({
      id: 'human-final', parentId: 'boss-plan', objective: 'Approve final delivery', role: 'boss', ownerId: 'portfolio-boss',
      dependencies: ['integration'], authorityScopes: ['verify'], nodeBudget: budget(30, 1000, 1, 1), completionProfile: 'delivery',
      requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'],
      evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], status: 'ready', approvalGate: 'final-delivery',
    }),
  );
  return { schemaVersion: 1, id: 'parallel-fan-in', goal: 'Deliver a dependency-aware conference demo', providerRefs: ['git-ci-main'], maxDelegationDepth: 3, status: 'approved', nodes };
}

function corrective() {
  const nodes = commonNodes();
  nodes[0].objective = 'Own the corrective delivery goal';
  nodes[1].objective = 'Coordinate the corrective task';
  nodes[0].budget = budget(240, 200000, 40, 40);
  nodes[1].budget = budget(180, 150000, 30, 30);
  nodes.push(
    node({
      id: 'fix-journey', parentId: 'manager-plan', objective: 'Correct the journey regression', role: 'worker', ownerId: 'quality-worker',
      dependencies: ['manager-plan'], authorityScopes: ['implement', 'verify'], nodeBudget: budget(90, 50000, 10, 8),
      completionProfile: 'engineering', requiredEvidenceTypes: ['commit', 'test', 'journey'],
      evidenceRefs: ['fix-commit', 'fix-test', 'fix-journey-result'], status: 'corrective',
    }),
    node({
      id: 'human-final', parentId: 'boss-plan', objective: 'Approve corrected delivery', role: 'boss', ownerId: 'portfolio-boss',
      dependencies: ['fix-journey'], authorityScopes: ['verify'], nodeBudget: budget(30, 1000, 1, 1), completionProfile: 'delivery',
      requiredEvidenceTypes: ['commit', 'test', 'review', 'human-approval'],
      evidenceRefs: ['final-commit', 'final-test', 'final-review', 'final-approval'], status: 'ready', approvalGate: 'final-delivery',
    }),
  );
  return { schemaVersion: 1, id: 'corrective-loop', goal: 'Correct a failed journey before delivery', providerRefs: ['git-ci-main'], maxDelegationDepth: 2, status: 'running', nodes };
}

const BUILDERS = Object.freeze({
  'parallel-fan-in': parallelFanIn,
  corrective,
});

function graphFixtureUnsafe(name) {
  const builder = BUILDERS[name];
  if (!builder) graphFailure('unknown-graph-fixture');
  return structuredClone(builder());
}

export function graphFixture(name) {
  return sanitizeGraphOperation(
    () => graphFixtureUnsafe(name),
    'invalid-graph-fixture',
  );
}
