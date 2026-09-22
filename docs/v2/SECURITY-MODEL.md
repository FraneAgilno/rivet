> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Rivet v2 Security Model

## Threat model

The platform assumes tracked files, provider responses, model output, subprocesses, filesystem paths, Git state, clocks, signals, and caller objects may be malformed or hostile. Public boundaries snapshot bounded data, reject ambiguous shapes, sanitize errors, and avoid retaining caller-owned capabilities across asynchronous work.

## Authority and approval

Role authority is explicit and scoped to actions, paths, providers, and commands. Human gates use authenticated single-use approval receipt claims bound to subject, action, resource, policy, expected state, and expiration. An agent result cannot manufacture activation, an external write, merge, deploy, publication, or final-delivery approval.

## Private state and concurrency

Live instances are private Git-repository state, not tracked project files. Transactions use expected versions, leases, bounded retries, exact intent identity, idempotency keys, and heartbeat ownership. Late or stale results cannot settle a replacement attempt.

## Filesystem and Git

Path traversal, symlink/hardlink substitution, nonregular files, portable-name collisions, source/destination races, dirty repositories, ambient Git control variables, and broad deletion are rejected at governed boundaries. Conference reset archives one allowlisted state directory and never rewrites application source.

## Commands and model clients

Commands are validated argv arrays; shell strings and unsafe executable/path forms are rejected. Agent clients enforce bounded output, time, cost, tokens, worktree identity, cancellation, and secret redaction. The fake client is deterministic and always labeled simulated.

Live client configuration pins a canonical executable, approved version, and—only for script entrypoints—a canonical native interpreter. The clean subprocess environment retains only bounded non-secret process context: locale, terminal, path, temporary-directory, home, and shell identity values. Credential/token/key/password/secret variables are always excluded. Claude planning uses `dontAsk`, the exact `Read,Glob,Grep` tool allowlist, and a pinned JSON schema; Codex planning uses `read-only`. Claude Code Plan Mode is excluded because it may write a user-level plan file and return narration instead of the governed result contract. Worker execution changes to Claude `acceptEdits` or Codex `workspace-write` only after exact activation and only inside a verified reserved Worker worktree. The same selected client is retained across both phases.

The source checkout stays on the approved default-branch commit. Integration and Worker checkouts live beneath a repository-identity/run-identity path in the sibling `.rivet-worktrees` directory. Private state remains beneath Git common storage. Each run derives a run-unique isolated local integration branch, and one Worker at a time is reconciled by fast-forward into it; no runtime capability pushes, merges the default branch, deploys, publishes, or writes trackers.

## Providers

HTTP transport validates public DNS answers, pins destination identity, enforces HTTPS resource scope, bounds bodies and pagination, sanitizes URLs/headers, and isolates hostile response/signal/cancellation behavior. Writes require exact state, an idempotency reservation, conditional mutation proof, and human approval.

## Evidence and status

Evidence binds acceptance criteria, authenticated gate results, relative artifacts, commit identity, checksums, and approval state. Secret redaction covers content and metadata. The status server binds localhost only and validates Host/Origin, bounded reads, SSE cursors, and projected allowlisted fields.

## Residual boundary

Local verification cannot prove cloud deployment, durable retention, current provider state, presenter recording, or human approval. Those remain external gates.
