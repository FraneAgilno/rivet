# Delivery lifecycle

Rivet can prepare a delivery record from a verified active-harness run. This is the first T13 foundation: native GitHub, Bitbucket and GitLab delivery executors and live qualification remain pending.

## Prepare verified work

From a configured project root or nested folder:

```sh
rivet delivery prepare
rivet delivery status
```

Rivet selects the only eligible run. When there is more than one, use the run ID shown by `rivet work status` or your task output:

```sh
rivet delivery prepare --run=my-run --remote=upstream
rivet delivery status --run=my-run --json
```

`--project=/absolute/project` is optional when running elsewhere. Select `--remote` when multiple repository destinations exist. Preparation reads Git identity and local evidence without making provider requests.

Preparation requires an accepted integration commit, passing recorded verification and an unchanged clean source and integration checkout. The source must still match the approved baseline and configured default branch. Failed or stale verification stops preparation. The candidate records the repository, source and target branches, exact commit and verification digest in private run state. Repeating preparation for the same candidate returns its existing record.

`status` reads the saved record. It does not refresh CI, reviews or remote delivery state. A locally verified record does not mean a pull request was created or the work was merged.

## Separate delivery stages

| Recorded stage | Meaning |
| --- | --- |
| Locally verified | Accepted commit and verification evidence are recorded. |
| Review requested | A review request was confirmed externally. |
| Checks passed | A trusted executor observed known required-check and review policies satisfied for the candidate commit. |
| Merge approved | Exact delivery authority was accepted and dispatch intent was persisted. The merge outcome may still be unknown. |
| Merged | A confirmed merge outcome and resulting commit are recorded. |
| Deployed | A confirmed deployment outcome is recorded. |
| Tracker updated | A confirmed tracker update is recorded. Inspect operation history for deployment status. |

The service also records each operation separately. A failed deployment or tracker update preserves an earlier successful merge. An unknown outcome remains visible until reconciled.

## Executor and approval boundary

The application service supports separate review-request, merge, deployment and tracker-update operations through a trusted executor interface. A qualified executor must enforce the candidate commit, provide required-policy evidence, verify external results and reconcile uncertain outcomes. The common [repository inspection adapters](./repositories.md) are read-only and cannot perform these operations.

Each action has its own proposal and authority check. Approval binds the repository, source and target refs, commit, current facts, action and payload. Deployment and tracker proposals also bind the confirmed merge receipt and resulting commit, including squash/rebase merges. Changed facts or expired proposals require a new proposal. Unknown policy, missing required review or failed CI blocks merge.

Dispatch intent and consumed approval identity are saved before a write. A timeout or uncertain response is recorded as indeterminate. It must be reconciled before another attempt; blindly repeating a write can duplicate an external action.

Reopening persisted state after a released lock is covered by automated tests. A process crash while holding the delivery operation lock still requires explicit stale-lock recovery through the existing state API; a delivery CLI recovery command and crash qualification remain pending.

The current CLI exposes only `prepare` and `status`. It does not accept supplied success receipts, raw verification JSON, merge flags or deployment commands. Native provider executors, deployment configuration, tracker delivery and live sandbox qualification are the next delivery work.
