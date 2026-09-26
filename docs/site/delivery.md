# Delivery lifecycle

Rivet can prepare a delivery record from a verified active-harness run. Native GitHub.com and GitLab.com executors can create a review request for an already published verified branch, then merge it under the supported policies below. Project-configured GitHub Actions deployment is also implemented. Jira/Linear delivery-summary comments and separately approved status transitions are supported after a confirmed merge. Create-only branch publication is implemented for configured GitHub.com, GitLab.com and Bitbucket Cloud HTTPS destinations. Bitbucket review/merge writes and live qualification remain pending.

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

## Publish the verified branch

```sh
rivet delivery prepare
rivet delivery publish
rivet delivery review
```

`publish` uploads the verified integration commit and its reachable Git history to the prepared repository. The preview shows the actual HTTPS destination, exact commit and destination branch before asking for approval. It creates one new branch with an explicit empty expected value in Git's lease check. It never overwrites, deletes or force-replaces an existing branch. If the destination already contains the exact verified commit, Rivet reports that no publication was dispatched.

Configure the scoped repository provider with `repository-read` and `branch-publish` capabilities and `mode: read-write-with-approval`. Add `review-request` for subsequent GitHub/GitLab review creation; add `checks-read` and `merge` only when using the separate merge flow. Publication requires an interactive terminal and has no unattended confirmation or JSON-write option. Use `--run` or `--provider` only when selection is ambiguous.

Publication uses the selected provider's token through a controlled HTTPS Git process. The token must permit Git pushes to the selected repository; provider-specific restrictions can also apply to protected branches or workflow files. It does not inherit SSH configuration or credential helpers. GitHub and GitLab can use the existing token environment references shown below. Bitbucket requires `credentials.accessTokenEnv` referencing a supported repository/project/workspace access token or OAuth access token; Atlassian user API tokens are not accepted by this publication path. Keep credential values outside tracked files and command arguments. As with other process credentials, privileged local inspection can read process memory/environment. See [GitHub app permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [GitLab token authentication](https://docs.gitlab.com/user/profile/personal_access_tokens/), [Bitbucket access tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/) and the distinct [Bitbucket API-token convention](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).

The transport runs from a temporary bare repository with hooks, redirects, inherited Git configuration and submodule pushes disabled. It reads the validated local object store without changing the project or integration checkout. Conflicting configured push URLs stop the command; Rivet never silently pushes to a different destination. The current transport supports macOS/Linux with a canonical native Git installation, a native HTTPS helper and a validated local object store. Unsafe object links or external object alternates require investigation; they are not followed automatically.

Dispatch intent is recorded before the single push. A timeout or disconnect can leave an indeterminate result even if the server later creates the branch. Forced stops terminate the process group and bound finalization, but cannot prove that an escaped descendant stopped; cleanup remains uncertain. Use `rivet delivery reconcile`; it only reads the remote. An exact matching ref confirms that the approved publication requirement is satisfied, without claiming Rivet was the only possible creator. A missing or different ref after uncertainty does not trigger another push. Preserve the recorded result and investigate conflicts instead of deleting or replacing the remote branch.

Review creation and merging remain separately approved operations. Publishing a branch does not establish passing remote CI, approved reviews or permission to deliver. Live authenticated publication on each provider remains unqualified.

## Create a GitHub pull request or GitLab merge request

Publish the accepted integration branch with `rivet delivery publish` or your repository tools first. The remote source branch must point to the exact locally verified commit. Review creation itself does not upload Git objects or push branches.

```sh
rivet delivery prepare
rivet delivery review
rivet delivery status
```

The configured repository API provider needs `repository-read` and `review-request` capabilities, scoped to this project and repository, with `mode: read-write-with-approval`. Use the GitHub or GitLab endpoint and token configuration shown below. Creation does not require `checks-read`; merging later still requires it and the supported repository policy.

`review` selects the prepared run and shows its repository, source/target branches, verified SHA, generated title and exact body before asking for approval. The body includes verification identity and a correlation marker. Review creation requires an interactive terminal; `--json` and unattended approval flags are unavailable. Use `--run=<id>` or `--provider=<id>` only when selection is ambiguous.

The operation creates a same-repository, non-draft review without merging or deleting the source branch. Rivet records dispatch before the write, performs one creation request, then reads the created object to verify repository identity, branches, source SHA, title, body and URL. Existing or ambiguous reviews prevent another creation request. Repeating a confirmed operation returns its saved result.

These creation APIs accept branch names rather than an atomic source-SHA condition. Rivet checks before dispatch and verifies the result afterward. A concurrent branch change can still create an external review for changed content; Rivet records no successful creation receipt if readback differs. Approval for creation never grants permission to merge. See [GitHub creation](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) and [GitLab creation](https://docs.gitlab.com/api/merge_requests/#create-a-merge-request).

After a timeout or uncertain response, use `rivet delivery reconcile`. Reconciliation only reads provider state and requires one review with the exact operation marker and approved content. It does not repost, edit, reopen or close reviews. An absent or ambiguous result remains indeterminate because absence cannot prove that an earlier request will never complete. A matching closed review can establish that creation happened only while the approved repository and branch facts still match; changed or deleted source/target branches leave the outcome unknown. Closure still blocks subsequent merging.

## Merge an existing GitHub pull request

After host verification, publish the accepted integration branch with `rivet delivery publish` and open its PR using `rivet delivery review` or your repository tools. Merging requires that PR to match the prepared source branch, target branch and exact commit. Merging itself does not push or create the source branch.

```sh
rivet delivery prepare
rivet delivery refresh
rivet delivery merge
rivet delivery status
```

`merge` defaults to squash. Use `--method=merge` or `--method=rebase` when appropriate for the repository. The terminal shows the PR, exact source and target commits, and method before asking for approval. Declining makes no merge request. Head, checks, reviews, local verification and policy are rechecked before dispatch. Already-confirmed merges return the stored result without prompting or writing again.

Merge requires an interactive terminal; `--json` and unattended confirmation flags are unavailable. `refresh`, `status`, `recover` and `reconcile` support `--json`. Add `--provider=<id>` when more than one configured provider matches. Project/run selection follows the same rules as preparation.

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

The same `prepare`, `refresh`, interactive `merge` and read-only `reconcile` commands support GitLab.com. Publish the verified integration branch with `rivet delivery publish` or your repository tools, then create its merge request with `rivet delivery review` or your repository tools first. The MR must belong to the same project as the target and match the prepared branches and exact commit.

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

## GitHub Actions deployment

After a confirmed Rivet merge, run:

```sh
rivet delivery deploy
rivet delivery reconcile
```

Project and run detection work as for merge. Deployment requires its own interactive approval; JSON and unattended approval are unavailable. Review the merged commit, environment and production classification before approving. Reconciliation supports `--json` and never dispatches another deployment.

Add a target to `.rivet/project.yaml`:

```yaml
deployment:
  providerId: github-deployment
  workflow: rivet-deploy.yml
  environment: staging
  productionEnvironment: false
```

Add a provider under `providers` in `.rivet/providers.yaml`:

```yaml
- id: github-deployment
  kind: git-ci
  transport: direct-api
  mode: read-write-with-approval
  endpoint: https://api.github.com
  projectIds: [your-project-id]
  resourceIds: [your-owner/your-repository]
  capabilities: [repository-read, deployments-read, actions-read, deploy]
  credentials:
    tokenEnv: RIVET_GITHUB_DEPLOY_TOKEN
```

Set the token outside tracked files. It needs repository contents/pull-request/Actions read access and deployment write access. Use a PAT or GitHub App token that can trigger Actions; deployment events created with a workflow's `GITHUB_TOKEN` do not trigger another workflow. Keep project/resource scopes explicit. Read-only providers can reconcile existing requests.

### Project workflow contract

Review and copy the opt-in [workflow template](https://github.com/FraneAgilno/rivet/blob/main/templates/github-actions/rivet-deploy.yml) into your project's `.github/workflows/rivet-deploy.yml`. It is packaged with Rivet but never installed or executed automatically. Adapt the staging environment and trusted `deploy` and `verify:deployment` package scripts. Both commands must fail when their job fails; verification must check the deployed application. Configure required environment reviewers as appropriate. SHA-based deployment events have no branch/tag ref, so qualify environment branch restrictions for this path separately.

Rivet creates a deployment for the exact confirmed merge SHA with automatic merging disabled and GitHub's default commit-status checks preserved. The workflow consumes the deployment event, checks the `rivet-deploy` task and operation identity, checks out that exact SHA, deploys, verifies and reports a correlated status. The workflow file must exist at that merge commit and be active. This uses GitHub's [deployment API](https://docs.github.com/en/rest/deployments/deployments) and [deployment event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#deployment).

The project workflow and its verification logic are trusted project code. Rivet checks the configured workflow identity and commit, but does not prove arbitrary deployment scripts correct or qualify every environment policy. Other workflows or integrations listening to deployment events must filter their intended task/environment. A production target requires an explicitly reviewed project workflow and configuration.

### Completion and recovery

Creating a deployment is not completion. Rivet requires one deployment matching the approved operation, SHA, environment and workflow; its latest status must be successful and reference a completed successful Actions run with the matching workflow, commit and operation title. The resulting receipt records the deployed merge SHA and run URL.

A running, failed, canceled, missing or ambiguous result stays indeterminate and preserves the successful merge. Use `delivery reconcile` to read the outcome. Rivet never automatically retries creation, interprets absence as proof of no effect, or retries a failed workflow. Manual investigation is required for unresolved failures. The current delivery record supports one successful deployment; multiple environments and redeployment are not implemented.

Configuration is reloaded after approval; changed target or provider authority stops dispatch. Reconciliation requires the original target/provider configuration. Restore that configuration if it was changed while a deployment was pending. Contract tests cover the flow; an actual project deployment with health verification remains a live acceptance gate.

## Jira and Linear delivery summaries

For a run sourced from Jira or Linear, post a separately approved delivery summary after a confirmed merge:

```sh
rivet delivery tracker-update
rivet delivery reconcile
```

Rivet derives the ticket from the run's validated work request, including its primary host-observed tracker source. It does not accept a replacement ticket ID or free-form comment. Inline/Markdown requests have no tracker target and cannot use this command. Project/run selection is automatic when unique; use `--provider=<id>` only when provider selection is ambiguous.

The preview shows the ticket URL and exact summary: merged commit, review URL, and a deployment URL only when deployment was confirmed. A unique operation marker correlates the comment with the recorded approval. This is a delivery comment, not a ticket status transition or a declaration that the entire ticket is complete.

### Configure a write-capable tracker provider

Use an existing direct provider or add one under `providers` in `.rivet/providers.yaml`:

```yaml
- id: jira-delivery
  kind: jira
  transport: direct-api
  mode: read-write-with-approval
  endpoint: https://your-site.atlassian.net
  projectIds: [your-project-id]
  resourceIds: [ENG-123]
  capabilities: [issues-read, comments-read, tracker-update]
  credentials:
    usernameEnv: RIVET_JIRA_EMAIL
    apiTokenEnv: RIVET_JIRA_TOKEN
```

For Linear, use `kind: linear`, `endpoint: https://api.linear.app` and a single `apiTokenEnv` reference for a personal API key, or `accessTokenEnv` for an OAuth token. The token needs issue/comment reads and comment creation rights. Jira Cloud uses the configured account email and API token with issue access and comment permission. Credential values stay outside tracked files. `projectIds` scope Rivet projects; optional `resourceIds` restrict ticket keys. The provider must match the recorded tracker/site and ticket.

The operation posts through [Jira Cloud comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/) or [Linear's GraphQL API](https://linear.app/developers/graphql). State transitions, edits to descriptions, attachments and arbitrary messages are not implemented by this command.

### Verified results and uncertain outcomes

Approval binds the source request, immutable remote issue identity, provider endpoint, confirmed merge result and summary. Rivet reloads provider configuration and the source target after approval. Changes stop the write. It then posts once and reads comments back, requiring one exact body and operation marker on the same issue before recording `tracker-updated`.

A timeout, failed read, duplicate matching comment or ambiguous response preserves the merge and leaves the tracker operation indeterminate. Reconciliation only reads; missing evidence never authorizes an automatic retry. The original provider and target remain bound during reconciliation, even when another provider is configured. Manual investigation is required if the outcome cannot be established. Comment receipts link to the ticket and record comment evidence; they do not assert a ticket status change.

Jira/Linear adapters have contract and failure-path tests. Authorized live tracker posting and visibility/permission qualification remain acceptance work.

## Jira and Linear status transitions

For the same recorded tracker ticket after a confirmed merge:

```sh
rivet delivery tracker-status
rivet delivery tracker-transition
rivet delivery reconcile
```

`tracker-status` reads the ticket's current status and available destinations. `tracker-transition` presents those choices, then previews the exact ticket, current status and selected destination for a separate approval. Select by the displayed number; no internal status or transition ID is required. Rivet does not infer that a merged change means the ticket should be marked Done.

The provider needs `issues-read` and `transitions-read`; add `tracker-transition` and `mode: read-write-with-approval` for changes. Scope it to the recorded tracker/site and ticket as for delivery comments. The authenticated account needs permission to inspect the issue/workflow and perform the chosen transition. Comment capabilities and approvals remain separate. A comment and a status change can occur in either order, and both receipts are retained.

Jira uses the available transition identity, which can differ from the destination status identity. Transitions requiring a screen or additional required fields stop for manual handling. Linear choices come from the ticket's team workflow states. Duplicate destination names are distinguished by their transition name and state type; indistinguishable choices stop for manual handling. If the provider lists the current state as a destination and you select it, Rivet reports a no-op without creating a write receipt. It does not invent a self-transition when Jira does not offer one. The command does not accept a replacement ticket or arbitrary field updates.

Approval binds the source request, immutable issue identity, current issue revision and status, destination metadata, provider configuration and confirmed merge receipt. Rivet rechecks those facts before sending one change request and reads the issue afterward. These APIs do not provide a portable atomic condition on the original status; a concurrent change remains possible between the check and the write. See [Jira transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-post) and [Linear's GraphQL API](https://linear.app/developers/graphql).

A receipt confirms that the same ticket was observed in the approved destination state. It does not prove that Rivet was the only actor responsible for reaching that state. Timeout recovery only reads the ticket: the approved destination can satisfy the recorded requirement, while the original or another status remains indeterminate. An uncertain result never authorizes an automatic second transition. Earlier merge, deployment and comment results remain recorded.

Live transition permissions, workflow behavior and outcome visibility still require qualification against the team's Jira/Linear sandbox resources.

## Separate delivery stages

| Recorded stage | Meaning |
| --- | --- |
| Locally verified | Accepted commit and verification evidence are recorded. |
| Branch published | The approved publication operation confirmed the exact commit at the destination branch. |
| Review requested | A review request was confirmed externally. |
| Checks passed | A trusted executor observed known required-check and review policies satisfied for the candidate commit. |
| Merge approved | Exact delivery authority was accepted and dispatch intent was persisted. The merge outcome may still be unknown. |
| Merged | A confirmed merge outcome and resulting commit are recorded. |
| Deployed | A confirmed deployment outcome is recorded. |
| Tracker updated | A confirmed tracker comment is recorded. Inspect operation history for other outcomes. |
| Tracker status confirmed | The recorded ticket was observed in the approved destination status. |

The service also records each operation separately. A failed deployment or tracker update preserves an earlier successful merge. An unknown outcome remains visible until reconciled. Completing a tracker update does not prevent a later deployment; already successful actions cannot be repeated in the same delivery record. Inspect operation history to see both outcomes regardless of their order.

## Executor and approval boundary

The application service supports separate branch-publication, review-request, merge, deployment, tracker-update and tracker-transition operations through a trusted executor interface. A qualified executor must enforce the candidate commit, provide required-policy evidence, verify external results and reconcile uncertain outcomes. The common [repository inspection adapters](./repositories.md) remain read-only. Native GitHub and GitLab executors support merge; a separate GitHub Actions executor supports project-configured deployment.

Each action has its own proposal and authority check. Approval binds the repository, source and target refs, commit, current facts, action and payload. Deployment and tracker proposals also bind the confirmed merge receipt and resulting commit, including squash/rebase merges. New completion receipts must attest to that exact resulting commit. Historical records remain readable. Changed facts or expired proposals require a new proposal. Unknown policy, missing required review or failed CI blocks merge.

Dispatch intent and consumed approval identity are saved before a write. A timeout or uncertain response is recorded as indeterminate. It must be reconciled before another attempt; blindly repeating a write can duplicate an external action. Reconciliation uses the provider identity from the approved proposal and requires an executor supporting that action. A different provider cannot claim completion, even when it uses the same repository platform.

### Recover a crashed delivery process

If a crashed process leaves delivery locked, wait until its lock is at least five minutes old, then run:

```sh
rivet delivery recover
rivet delivery reconcile
```

Recovery uses the same project and unique-run selection as status. Use `--run=<id>` when selection is ambiguous or the process died before creating a delivery record. `recover --json` reports the recovered lock names. It does not require provider credentials.

Recovery checks private file identity, age, machine identity and process liveness. Only a provably dead owner on the current machine is eligible. Live, recent, foreign-host, malformed, linked or unsafe locks are preserved. PID reuse and permission errors also stop recovery. There is no force flag or caller-supplied PID.

An exclusive private recovery marker is retained for each recovered owner. This prevents competing recovery attempts from removing a replacement lock. If recovery itself is interrupted after claiming a lock, another attempt stops for investigation. Markers are not automatically cleaned up in this release.

Recovery leaves delivery stages, approval records and operation receipts unchanged. Reconciliation is a separate read-only provider step; a crashed request may already have succeeded remotely. A real subprocess-crash fixture covers lock recovery followed by reconciliation without repeating dispatch. Broader crash scenarios and live-provider recovery qualification remain open.

The CLI does not accept supplied success receipts or raw verification JSON. Bitbucket review creation/merge and live sandbox qualification remain open delivery work.

## Bitbucket delivery boundary

Bitbucket Cloud supports [read-only repository inspection](./repositories.md) and the separately approved create-only branch publication described above. Native review creation and merging remain unavailable. Rivet does not send an unconditional merge request as a substitute. A verified conditional execution approach is still required before adding native merge writes. See the [Bitbucket pull request API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).
