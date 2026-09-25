# Delivery lifecycle

Rivet can prepare a delivery record from a verified active-harness run. A native GitHub.com executor can merge an existing pull request under the supported protection policy below. Native Bitbucket/GitLab delivery, review creation, deployment and tracker execution, and live qualification remain pending.

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

## Merge an existing GitHub pull request

After host verification, publish the accepted integration branch and open its PR through your normal repository tools. Rivet currently requires that PR to exist and to match the prepared source branch, target branch and exact commit. It does not push branches or create PRs in this flow.

```sh
rivet delivery prepare
rivet delivery refresh
rivet delivery merge
rivet delivery status
```

`merge` defaults to squash. Use `--method=merge` or `--method=rebase` when appropriate for the repository. The terminal shows the PR, exact source and target commits, and method before asking for approval. Declining makes no merge request. Head, checks, reviews, local verification and policy are rechecked before dispatch. Already-confirmed merges return the stored result without prompting or writing again.

Merge requires an interactive terminal; `--json` and unattended confirmation flags are unavailable. `refresh`, `status` and `reconcile` support `--json`. Add `--provider=<id>` when more than one configured provider matches. Project/run selection follows the same rules as preparation.

Configure a scoped entry in `.rivet/providers.yaml` before starting the feature run:

```yaml
- id: team-github
  kind: git-ci
  mode: read-write-with-approval
  transport: direct-api
  capabilities: [repository-read, checks-read, merge]
  endpoint: https://api.github.com
  projectIds: [your-project-id]
  resourceIds: [your-team/your-repository]
  credentials:
    tokenEnv: RIVET_REPOSITORY_TOKEN
```

Set the named token environment variable outside tracked configuration. The token needs access to inspect branch protection, checks, reviews and collaborator permissions, plus permission to merge the selected PR. Rivet does not import credentials from the GitHub CLI or another application. Read-only providers can refresh or reconcile but cannot authorize a merge.

### Supported GitHub policy

This first executor deliberately supports a bounded classic branch-protection configuration:

- Protection is readable and enforced for administrators; there are no review bypass allowances.
- At least one required status/check context is declared; strict status checks require the branch to include the current target commit.
- All matching current required checks pass, including app identity where specified. A matching legacy status must also pass.
- Stale reviews are dismissed. The required number of current-commit approvals comes from reviewers with write-level permission. Outstanding changes-requested reviews block delivery.
- Code-owner approval, last-push approval, required conversation resolution and locked branches are unsupported. Active repository/organization rulesets are also unsupported by this executor.

Unknown, inaccessible or unsupported policy blocks merging. This is not full GitHub policy coverage. Provider restrictions can still reject a merge after Rivet's checks.

GitHub's merge API atomically checks the source SHA. Target refs, target SHA and protection configuration are reread, but GitHub does not provide equivalent atomic preconditions for those facts. Concurrent PR retargeting or administrator policy changes remain outside this guarantee. Live sandbox qualification is still pending. See the [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) and [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

### Resolve an uncertain result

```sh
rivet delivery reconcile
```

A timeout, rejected response or failed verification after dispatch leaves an indeterminate operation and a nonzero merge exit code. The native executor verifies the resulting PR state and merged commit before reporting success. Reconciliation performs reads only; it never repeats the merge request. An open PR or failed read remains unknown because an outstanding request could still complete. There is currently no CLI override that converts an unknown result into permission to retry.

The executor checks the execution/approval deadline immediately before sending the merge. A request already sent can still finish after a timeout, so its result must be reconciled.

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

The application service supports separate review-request, merge, deployment and tracker-update operations through a trusted executor interface. A qualified executor must enforce the candidate commit, provide required-policy evidence, verify external results and reconcile uncertain outcomes. The common [repository inspection adapters](./repositories.md) remain read-only. The separate native GitHub delivery executor supports merge only.

Each action has its own proposal and authority check. Approval binds the repository, source and target refs, commit, current facts, action and payload. Deployment and tracker proposals also bind the confirmed merge receipt and resulting commit, including squash/rebase merges. Changed facts or expired proposals require a new proposal. Unknown policy, missing required review or failed CI blocks merge.

Dispatch intent and consumed approval identity are saved before a write. A timeout or uncertain response is recorded as indeterminate. It must be reconciled before another attempt; blindly repeating a write can duplicate an external action.

Reopening persisted state after a released lock is covered by automated tests. A process crash while holding the delivery operation lock still requires explicit stale-lock recovery through the existing state API; a delivery CLI recovery command and crash qualification remain pending.

The CLI does not accept supplied success receipts or raw verification JSON. Native review creation, Bitbucket/GitLab executors, deployment configuration, tracker delivery and live sandbox qualification remain open delivery work.
