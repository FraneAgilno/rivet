# Delivery Protocol

Protocol version: 1

## Verified candidate

Prepare delivery only from the recorded accepted integration commit and its passing verification report. Use `rivet delivery prepare` from the configured project. Inspect `rivet delivery status` before continuing. A candidate is local evidence, not external delivery success.

## Authority

Review creation, merge, deployment and tracker updates are separate actions. Each proposal binds the repository, source and target refs, commit, action, payload and current observed facts. Deployment and tracker approvals also bind the confirmed merge receipt and resulting commit. Use the governed application's trusted executor and approval registry. Do not manufacture approval receipts or promote host-supplied JSON to trusted evidence. Changed facts or expired proposals require a new proposal.

## Stop conditions

Stop for changed source or integration state, an unsupported executor capability, or absent action-specific authority. Merging also stops for unknown required-check/review policy, failed CI or a missing review. The CLI supports prepare/status and GitHub/GitLab interactive review creation, refresh/interactive merge/reconcile. Native merge requires an existing same-repository exact-head PR/MR and the documented provider policy subset. GitLab supports merge commits only; Bitbucket writes are unavailable. GitHub Actions deployment is available through interactive delivery deploy with project.deployment configuration and a trusted project workflow. Jira/Linear delivery-summary comments are available through interactive delivery tracker-update. Tracker status transitions and live delivery qualification remain pending.

## External outcomes

Persist intent before dispatch. Record success only from verified external evidence bound to the operation and candidate. Each native executor must receive and check the bounded dispatch deadline immediately before a remote mutation. Timeout, malformed response and uncertain dispatch are indeterminate. Reconcile before retry; never assume an error means that no external write occurred. Preserve a confirmed merge if deployment or tracker work later fails. Report stages and per-operation outcomes separately.

## Process crash recovery

Use `rivet delivery recover` only for abandoned delivery locks. It checks that the lock is at least five minutes old, belongs to this machine and has a provably dead process owner. Preserve live, foreign, unsafe or already-claimed locks for investigation. Recovery retains a per-owner marker and never changes recorded approval or operation outcomes. Follow with `rivet delivery reconcile` for pending provider effects; do not repeat dispatch because a local process crashed. Interrupted recovery claims deliberately stop further removal.


## GitHub Actions deployment

Use `rivet delivery deploy` only after a confirmed merge. Show the actual merge SHA, configured workflow, environment and production classification for separate human approval. The project workflow must deploy that exact commit and verify its result. Creation is pending, not success: completion requires the correlated deployment status and successful exact-commit workflow run. Reconcile unknown outcomes without repeating deployment. Never change environment/provider configuration to bypass a pending operation. Preserve the successful merge when deployment fails.


## Tracker delivery summary

Use `rivet delivery tracker-update` to append the previewed delivery summary to the run's recorded Jira/Linear source ticket after a confirmed merge. Require separate human approval. Include deployment only when confirmed. Never substitute another ticket, arbitrary text or a workflow status transition. Success requires exact comment read-back on the bound issue; reconcile uncertain outcomes without reposting. Preserve earlier merge/deployment evidence when tracker work fails.

## Review creation

Use `rivet delivery review` only when the accepted integration branch is already published at the verified SHA. Preview and obtain approval for the exact generated title/body, correlation marker, repository and branches. Creation does not push branches or authorize merging. The APIs select branches without an atomic SHA precondition; disclose that limitation and require strict readback before success. A concurrent change can leave an external review with an unconfirmed local result. Reconcile indeterminate outcomes through read-only marker lookup; never repost on absence. Repository or branch drift, content mismatch, multiple matches and deleted branches leave the outcome unknown. Keep merge policy checks separate.
