# Delivery lifecycle

Rivet can prepare a delivery record from a verified active-harness run. Native GitHub.com and GitLab.com executors can merge an existing review request under the supported policies below. Bitbucket writes, review creation, deployment and tracker execution, and live qualification remain pending.

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

## Merge an existing GitLab merge request

The same `prepare`, `refresh`, interactive `merge` and read-only `reconcile` commands support GitLab.com. Publish the verified integration branch and create its merge request through your repository tools first. The MR must belong to the same project as the target and match the prepared branches and exact commit.

Configure the provider before starting the feature run:

```yaml
- id: team-gitlab
  kind: git-ci
  mode: read-write-with-approval
  transport: direct-api
  capabilities: [repository-read, checks-read, merge]
  endpoint: https://gitlab.com/api/v4
  projectIds: [your-project-id]
  resourceIds: [your-group/your-project]
  credentials:
    tokenEnv: RIVET_GITLAB_TOKEN
```

Supply the token through the named environment variable. It must be able to read project, protected-branch, pipeline and approval configuration and merge the selected MR. Subgroups are supported in the repository path. Provider selection never sends a GitHub-configured credential to GitLab.

GitLab defaults to `--method=merge` and currently supports merge commits only. `--method=squash` and `--method=rebase` stop before provider requests. The executor explicitly disables squashing, automatic merge and source-branch deletion in the merge request.

### Supported GitLab policy

The first GitLab executor requires readable, explicitly supported settings:

- The project uses merge commits, with squashing disabled or off by default. Merge trains and merged-result pipelines are disabled.
- A successful pipeline is required, skipped pipelines are not accepted, and the MR pipeline belongs to the same project and exact verified head.
- The target has one exact protection rule, with no wildcard protection rules, force pushes, direct push access or code-owner gates. Supported merge access is Developer/Maintainer without custom roles, and the source includes the current target commit.
- Effective project and inherited approval settings must prohibit MR rule overrides, retaining approvals on push and selective code-owner-only removal. Applicable regular approval rules are visible and approved. Hidden or unsupported rules stop delivery.
- The MR is not a draft; GitLab reports it mergeable and the current user permitted to merge. Unimplemented discussion, external-status, Jira or other advanced gates stop delivery.

The approval APIs needed by this subset depend on GitLab Premium/Ultimate and Maintainer-level access to effective settings. Some required advanced-setting fields are Ultimate-only, so a Premium response omitting those fields also blocks eligibility. Missing fields, access errors and unsupported configurations block merge. GitLab Free, self-managed GitLab and other policy combinations are not qualified by this executor. No GitLab version allowlist is used; the observed capabilities and policy fields determine eligibility.

The API conditions the source SHA atomically. Target and policy observations are rechecked but do not have an atomic precondition, so concurrent retargeting or administrator policy changes remain a limitation. Live GitLab delivery qualification is still pending. See [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request), [approval state](https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-details-for-a-merge-request) and [project settings](https://docs.gitlab.com/api/projects/).

## Resolve an uncertain result

```sh
rivet delivery reconcile
```

A timeout, rejected response or failed verification after dispatch leaves an indeterminate operation and a nonzero merge exit code. The native executor verifies the resulting PR/MR state and merged commit before reporting success. Reconciliation performs reads only; it never repeats the merge request. An open PR/MR or failed read remains unknown because an outstanding request could still complete. There is currently no CLI override that converts an unknown result into permission to retry.

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

The application service supports separate review-request, merge, deployment and tracker-update operations through a trusted executor interface. A qualified executor must enforce the candidate commit, provide required-policy evidence, verify external results and reconcile uncertain outcomes. The common [repository inspection adapters](./repositories.md) remain read-only. The separate native GitHub and GitLab delivery executors support merge only.

Each action has its own proposal and authority check. Approval binds the repository, source and target refs, commit, current facts, action and payload. Deployment and tracker proposals also bind the confirmed merge receipt and resulting commit, including squash/rebase merges. Changed facts or expired proposals require a new proposal. Unknown policy, missing required review or failed CI blocks merge.

Dispatch intent and consumed approval identity are saved before a write. A timeout or uncertain response is recorded as indeterminate. It must be reconciled before another attempt; blindly repeating a write can duplicate an external action.

Reopening persisted state after a released lock is covered by automated tests. A process crash while holding the delivery operation lock still requires explicit stale-lock recovery through the existing state API; a delivery CLI recovery command and crash qualification remain pending.

The CLI does not accept supplied success receipts or raw verification JSON. Native review creation, Bitbucket delivery, deployment configuration, tracker delivery and live sandbox qualification remain open delivery work.

## Bitbucket delivery boundary

Bitbucket Cloud remains available for [read-only repository inspection](./repositories.md). A native executor that enforces the delivery contract has not yet been qualified. Rivet does not send an unconditional merge request as a substitute. A verified conditional execution approach is still required before adding native writes. See the [Bitbucket pull request API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).
