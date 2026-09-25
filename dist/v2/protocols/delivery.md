# Delivery Protocol

Protocol version: 1

## Verified candidate

Prepare delivery only from the recorded accepted integration commit and its passing verification report. Use `rivet delivery prepare` from the configured project. Inspect `rivet delivery status` before continuing. A candidate is local evidence, not external delivery success.

## Authority

Review creation, merge, deployment and tracker updates are separate actions. Each proposal binds the repository, source and target refs, commit, action, payload and current observed facts. Deployment and tracker approvals also bind the confirmed merge receipt and resulting commit. Use the governed application's trusted executor and approval registry. Do not manufacture approval receipts or promote host-supplied JSON to trusted evidence. Changed facts or expired proposals require a new proposal.

## Stop conditions

Stop for changed source or integration state, unknown required-check/review policy, failed CI, missing review, an unsupported executor capability, or absent action-specific authority. The current CLI implements preparation and status only; native provider writes and deployment/tracker qualification remain pending.

## External outcomes

Persist intent before dispatch. Record success only from verified external evidence bound to the operation and candidate. Timeout, malformed response and uncertain dispatch are indeterminate. Reconcile before retry; never assume an error means that no external write occurred. Preserve a confirmed merge if deployment or tracker work later fails. Report stages and per-operation outcomes separately.
