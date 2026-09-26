# Deterministic fixture sources

The evaluation catalog selects exact named fixture assertions from these maintained suites. It reuses their setup and teardown rather than keeping a second copy of the same fixture logic.

| Scenario | Fixture mechanics |
| --- | --- |
| intake | In-memory Jira/Linear and Figma observations with fixed source identities and timestamps; no network. |
| host | Disposable Git repository, private run state and worktrees; deterministic worker edits and a local fixture gate executable; no coding harness. |
| repository-adapter | Injected GitHub transport responses and conditional mutation assertions; no GitHub requests. |
| authority | In-memory authority envelopes and approval receipts. |
| recovery | In-memory versioned runtime state, heartbeat/retry and corrective-node fixtures. |
| model | Injected hosted response/transport and invalid profile cases; no model server or provider request. |

`evals/scenarios.json` identifies the exact suite and named test for every criterion. `evals/catalog.mjs` fixes the allowed selection. Fixture mode rejects a manifest that differs from that catalog. A changed catalog requires code review, like a changed test.

These are workflow mechanics evaluations. They do not implement a shared feature/bugfix live-model benchmark or a human pilot. Memory continuity remains not implemented in this evaluation lane.
