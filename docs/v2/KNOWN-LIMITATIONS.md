> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Rivet v2 Known Limitations

## External completion gates

- **Live feature clients:** the installed CLI now composes pinned Claude and Codex planning/Worker adapters. Each machine still needs the canonical executable, optional native interpreter for script entrypoints, local client authentication, and a safe package-manager command executable. Missing, mismatched, or unapproved versions fail closed.
- **Planning quality:** live clients return only schema-bound objectives, repository-relative owned paths, and acceptance-criterion allocation. Rivet deterministically supplies policy-sensitive graph fields, but the usefulness of the bounded decomposition still depends on the selected model's read-only repository analysis. Invalid output fails before a run is created.
- **Live tracker reads:** Jira and Linear resolution is connected to the CLI through the provider factory and DNS-pinned HTTPS transport. A consumer still needs a configured endpoint, named credential environment variables, and permission to read the ticket. Live Linear CON-1 access must be verified with an authorized local key. Missing or ambiguous providers fail closed; ticket contents are never invented.
- **Cloud hosting:** no private preview or final deployment has been provisioned, and no hosted URL is claimed.
- **Durable cloud evidence:** evidence is checksum-bound locally, but no approved remote retention target or download verification exists.
- **Live provider writes:** Jira, Confluence, and delivery mutations require real sandbox resources, exact current state, a shared idempotency registry, and human approval.
- **Verified recording:** the verifier exists, but the presenter must create a complete recording and separate matching copy.
- **Human final approval:** no final-delivery receipt has been created or consumed.
- **Integration:** merge of the v2 branch into `main` has not been requested or performed.
- **npm publication:** package versioning and publication remain owner-controlled future actions.

## Demonstration limits

- The installed-CLI regression proves the real application composition and host-compiled plan for both selected-client paths with deterministic local executables: Claude `dontAsk` with `Read,Glob,Grep` and structured output followed by `acceptEdits`, and Codex `read-only`/`workspace-write`. This proves protocol composition, not the quality or availability of a live model account.
- The workflow never pushes, updates a remote ref, advances the target default branch, deploys, publishes, or writes to Jira/Linear. Human final delivery is represented by `awaiting-final-approval`; completion still requires a separate approval-bound operation.
- The conference orchestration rehearsal uses a fake client and sanitized fixtures; it does not prove current remote provider behavior or live model execution.
- The private Bitbucket Pipeline proves verification at a commit, not deployment or indefinite artifact retention.
- The vendored Conference Planner is a noncanonical starter snapshot for deterministic `demo create` output; the private Bitbucket repository is canonical, and neither copy synchronizes automatically.
- Checkpoint reset archives local demo state only and never restores application source automatically.
- Recording and presenter recovery timing require human rehearsal.

## Product and design limits

The Conference Planner uses an original provider-independent local design contract. There is no external design provider dependency or imported third-party design-system approval. Any future visual baseline still requires truthful human ownership and evidence.

## Platform limits

- Private local instances are repository-scoped; no distributed runner coordination is claimed.
- The first production feature bridge runs one Worker at a time (`maxActiveNodes: 1`). Parallel execution is deferred because the current reconciler intentionally accepts fast-forward integration only.
- Local integration and Worker checkouts remain under the sibling `.rivet-worktrees` root until an operator performs a separately governed cleanup; automatic destructive cleanup is not implemented.
- Supported provider/resource shapes are explicit rather than arbitrary.
- Approval-governed writes are available as contracts, not blanket production authorization.
- A successful generated demo does not prove every future project template.

No reviewer is required for this local completion because the owner explicitly waived that step. A reviewer may still be requested later; the waiver does not replace human final approval, merge authorization, or publication authorization.
