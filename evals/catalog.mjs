// Executable selection lives in trusted source, never in a profile or JSON command.
const scenario = (id, file, entries) => ({ id, file, criteria: entries.map(([id, test]) => ({ id, test })) });
export const catalog = {
  schemaVersion: 1,
  scenarios: [
    scenario('intake', 'test/integrations/context-intake.test.js', [
      ['sourced-criteria', 'normalizes both trackers and linked design context with source assurance and user additions'],
      ['reject-forged-context', 'rejects missing criteria, resource ambiguity, wrong project, auth failures and forged assurance'],
    ]),
    scenario('host', 'test/feature/host-execution.test.js', [
      ['durable-handoff', 'prepare and nextAction durably hand one Worker to the host without a model client'],
      ['verified-human-gate', 'submitResult integrates an exact restarted host action and verify stops at final human approval'],
    ]),
    scenario('repository-adapter', 'test/adapters/github.test.js', [
      ['source-contract', 'reads GitHub repository, branch, PR, check, review, and artifact metadata'],
      ['conditional-authority', 'GitHub child comments require trusted atomic parent-state compare-and-mutate'],
    ]),
    scenario('authority', 'test/core/authority.test.js', [
      ['delegation-ceiling', 'worker cannot inherit authority its manager does not have'],
      ['approval-binding', 'approval authority, principal, policy, and decision mismatches fail closed'],
    ]),
    scenario('recovery', 'test/runtime/recovery.test.js', [
      ['version-authority', 'retry and cancellation mutations require exact version and structural authority'],
      ['bounded-recovery', 'corrective and stale recovery nodes stay bounded, parented, and evidence-reasoned'],
    ]),
    scenario('model', 'test/models/delegation.test.js', [
      ['unverified-output', 'delegation makes one pinned hosted request and returns explicitly unverified output'],
      ['reject-unsupported', 'invalid profiles, prompts, credentials, spend limits and unsupported providers fail before network'],
    ]),
  ],
  deferred: [{ id: 'memory-continuity', status: 'not-implemented', reason: 'Shared memory and two-user continuity are post-MVP.' }],
};
