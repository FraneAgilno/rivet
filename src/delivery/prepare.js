import { createHash } from 'node:crypto';
import { createHostExecution } from '../feature/host-execution.js';
import { acquireHostRunLock } from '../feature/host-run-lock.js';
import { resolveExistingFeatureRunPaths } from '../state/paths.js';
import { loadProjectConfig } from '../config/load.js';
import { discoverRepositoryRemotes, selectConfiguredRepositoryRemote } from '../repositories/index.js';
import { immutableJson } from '../clients/contract.js';

export class DeliveryPreparationError extends Error {
  constructor(message = 'Delivery requires a verified run and unchanged integration checkout. Inspect work status and verification results.') {
    super(message);
    this.name = 'DeliveryPreparationError';
    this.code = 'ERR_DELIVERY_PREPARATION';
    this.safeMessage = this.message;
  }
}
function fail() {
  throw new DeliveryPreparationError();
}

// Only the application reads local verification. CLI inputs never stand in for evidence.
export async function loadDeliveryCandidate({ project, runId, remoteName, gitClient, runner }) {
  const paths = await resolveExistingFeatureRunPaths(project, runId, runner ? { runner } : {});
  if (paths === null) fail();
  const lock = await acquireHostRunLock(paths);
  try {
    const execution = createHostExecution({ gitClient });
    const observed = await execution.status({ project, runId });
    const config = await loadProjectConfig(project);
    const { run, verification, checkout } = observed;
    const source = await gitClient.inspectRepository(project);
    if (
      source.dirty ||
      source.detached ||
      source.headSha !== run.featurePlan.baselineCommit ||
      source.branch !== config.project.repository.defaultBranch
    )
      fail();
    if (
      !observed.deliveryReady ||
      verification.failure !== null ||
      verification.checks.some(
        (check) =>
          check.required &&
          (check.status !== 'passed' || check.exitCode !== 0 || check.executionStatus !== 'success')
      ) ||
      !config.quality.commandGates
        .filter((gate) => gate.required)
        .every((gate) =>
          verification.checks.some(
            (check) => check.id === gate.id && check.required && check.status === 'passed'
          )
        ) ||
      !run.evidenceRefs.includes(`commit:${checkout.acceptedCommit}`)
    )
      fail();
    const remotes = await discoverRepositoryRemotes(project, runner ? { runner } : {});
    let selected;
    try { selected = selectConfiguredRepositoryRemote(remotes, config.project.repository.remote, remoteName); }
    catch { throw new DeliveryPreparationError('Repository remote is missing, ambiguous or changed. Review setup --remote=<name> or select --remote=<name> for this delivery operation.'); }
    const { remoteName: _remote, ...repository } = selected;
    const final = await gitClient.inspectRepository(checkout.path);
    if (final.dirty || final.headSha !== checkout.acceptedCommit || final.branch !== checkout.branch) fail();
    return immutableJson({
      runId,
      repository,
      sourceBranch: checkout.branch,
      targetBranch: config.project.repository.defaultBranch,
      localVerification: {
        runId,
        status: 'passed',
        headSha: checkout.acceptedCommit,
        evidenceDigest: createHash('sha256')
          .update(
            JSON.stringify({
              proposalDigest: run.proposalDigest,
              verification,
            })
          )
          .digest('hex'),
        verifiedAt: verification.checkedAt,
      },
    });
  } catch (error) {
    if (error instanceof DeliveryPreparationError) throw error;
    fail();
  } finally {
    await lock.release();
  }
}
