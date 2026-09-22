> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Rivet v2 Operator Quickstart

## Release boundary

This quickstart applies to the local release candidate on `codex/agentic-workflow-v2`. It does not authorize merging, publishing, deploying, remote mutation, or final approval.

Tracked project configuration is inert until a private orchestration instance is explicitly selected and receives activation approval. Never put live instance state, credentials, approval receipts, or worktree identities in tracked project files.

## Verify the platform

From a clean checkout:

```bash
npm ci
npm run check
node --test test/demo/*.test.js
npm pack --dry-run
```

For this v2 release candidate, invoke the CLI from the checked-out branch so
an older globally installed npm package cannot be selected accidentally:

```bash
RIVET_REPO="$(pwd)"
RIVET_CLI="$RIVET_REPO/bin/cli.js"
rivet() { node "$RIVET_CLI" "$@"; }
rivet --help
```

All commands must finish successfully. Inspect the package dry-run rather than assuming repository-only documentation or demo fixtures are published.

## Initialize a project

```bash
node bin/cli.js init
node bin/cli.js doctor --json
node bin/cli.js preflight --json
```

Review the generated `.rivet` configuration. Orchestration is disabled by default and must stay disabled until role identities, budgets, provider modes, quality gates, and completion profiles are correct.

## Private orchestration

The runtime operates on an explicitly selected private instance ID, not a tracked graph path. Activation requires the expected state version, an exact authority envelope, and a single-use human activation approval receipt supplied through the private runtime integration.

Use read-only status and fixture/fake-client verification first. External writes, merges, deploys, publication, and final delivery remain separate approval gates.

## Generic feature workflow

Pin the selected live client before running the workflow. Use the canonical real path, and set the interpreter only for a script-based client:

```bash
export RIVET_CLAUDE_EXECUTABLE="$(realpath "$(command -v claude)")"
unset RIVET_CLAUDE_INTERPRETER # native Claude installation
# For a script entrypoint only:
# export RIVET_CLAUDE_INTERPRETER="$(realpath "$(command -v node)")"
# Or use RIVET_CODEX_EXECUTABLE / RIVET_CODEX_INTERPRETER.
export RIVET_NPM_EXECUTABLE=/absolute/path/to/owner-controlled-npm-wrapper
```

Authenticate with the chosen Claude or Codex CLI before starting. Rivet forwards only non-secret process context (`HOME`, `USER`, `LOGNAME`, `SHELL`, locale, path, terminal, and temporary-directory values) so macOS clients can discover their Keychain-backed login, while credential, token, key, password, and secret variables remain stripped from the agent environment. Planning is read-only: Claude uses `dontAsk` with the exact `Read,Glob,Grep` tool allowlist and a feature-decomposition JSON schema; Codex uses `read-only`. Claude Code Plan Mode is intentionally not used because it writes a separate plan file instead of returning the required decomposition. Every Worker then uses the same selected client: Claude `acceptEdits` or Codex `workspace-write`, constrained to its isolated worktree.

Claude feature runs use the immutable `claude-bounded-sonnet-v1` profile: model `sonnet`, low planning effort, a 120-second planning timeout, a USD 1 planning ceiling, a USD 2 ceiling per launched agent (or the approved node budget when lower), and no fallback model. Claude Code receives the dollar ceiling directly through `--max-budget-usd`; the normal token, runtime, reported-cost, authority, worktree, and evidence controls still apply. Every Claude Worker uses `--output-format json` with an application-owned JSON Schema; the host unwraps and validates Claude's `structured_output` field as the exact result envelope. The host still rejects narration, Markdown, extra fields, unsafe evidence references, secret material, and usage beyond the approved budget. Codex planning also receives the 120-second timeout, but the Claude-specific model, schema argument, and spend profile do not apply to Codex.

The planning client does not author roles, authority, budgets, commands, evidence, dependencies, or approval gates. It returns a schema-bound decomposition containing objectives, repository-relative owned paths, and one-based acceptance-criterion indexes. Rivet deterministically compiles those bounded choices with the tracked `.rivet` policy and validates the resulting governed plan before any private run is created.

If final validation rejects a reserved, protected, or case-colliding owned path, the planner requests one corrected decomposition using a safe reason code. It validates the complete replacement with the same policy and request before creating any run. Other validation failures and provider failures are not retried. Each provider invocation retains its existing ceiling; the optional second invocation means a proposal can take up to two planning timeouts (approximately 240 seconds) and, for Claude, up to USD 2 in total. The normal single-call path remains unchanged. A failed repair returns a concrete, sanitized category without exposing protected filenames.

When saving proposal output, check success before reading activation fields. Keep the output file outside the project:

```bash
set -o pipefail
unset RUN_ID PROPOSAL_VERSION PROPOSAL_DIGEST
PROPOSAL_JSON="/private/tmp/session-discovery-proposal.json"
if rivet feature propose --project="$DEMO_REPO" \
  --request="$DEMO_REPO/requests/session-discovery.md" --client=claude --json \
  | tee "$PROPOSAL_JSON" | jq; then
  if jq -e '.ok == true' "$PROPOSAL_JSON" >/dev/null; then
    RUN_ID="$(jq -er '.result.runId' "$PROPOSAL_JSON")"
    PROPOSAL_VERSION="$(jq -er '.result.version' "$PROPOSAL_JSON")"
    PROPOSAL_DIGEST="$(jq -er '.result.proposalDigest' "$PROPOSAL_JSON")"
  fi
else
  unset RUN_ID PROPOSAL_VERSION PROPOSAL_DIGEST
  printf 'Proposal failed; do not start or resume this attempt.\n' >&2
fi
```

Prefer the explicit two-phase flow for agents and automation. In the commands
below, `rivet` means the pinned shell function above (or an equivalent
verified wrapper), not an unverified global npm binary:

```bash
rivet doctor --project=/absolute/project --json
rivet preflight --project=/absolute/project --json
rivet feature propose --project=/absolute/project --request=/absolute/project/requests/feature.md --client=claude --json
```

The CLI composes tracker reads through the configured provider factory and a DNS-pinned HTTPS transport. For the CON-1 recording setup, see [Linear demo](LINEAR-DEMO.md).

For Jira or Linear, replace `--request` with `--ticket=DEMO-123 --tracker=jira` or `--ticket=ENG-44 --tracker=linear`. Inline Markdown uses `--request-text=<text>`. Exactly one source is allowed.

Review the returned normalized request, baseline, client profile, graph, paths, commands, budgets, evidence, gates, run ID, version, and proposal digest. For Claude, verify `featurePlan.clientProfile.id` is `claude-bounded-sonnet-v1` and `fallbackModel` is `null`. The digest includes this profile, so changing the model or ceilings requires a new proposal and approval. Only an explicit human decision on those exact facts authorizes:

```bash
rivet feature start <run-id> --project=/absolute/project --expected-version=<version> --proposal-digest=<sha256> --json
rivet feature status <run-id> --project=/absolute/project --json
rivet feature resume <run-id> --project=/absolute/project --expected-version=<current-version> --json
```

Use version-bound `feature resume` only after resolving a reported block. Stop at the human final-delivery gate. This workflow does not push, merge, deploy, publish, update Jira/Linear, or grant final approval.

A successful run returns `awaiting-final-approval`. Its local integration checkout is under the sibling `.rivet-worktrees` root; the original default checkout and all remote refs remain unchanged. After a successful structured Worker result, the trusted host validates the complete changed-path set and creates one deterministic local commit for approved in-scope edits when the provider left them uncommitted. The initial bridge deliberately runs one Worker at a time (`maxActiveNodes: 1`) so each approved commit can be fast-forward reconciled from the current integration tip.

## Recovery

When a run is blocked, run `feature status` first, correct the reported condition, and only then run version-bound `feature resume`. An explicit resume may consume one configured retry for exactly one blocked Worker. It reuses that Worker's preserved checkout only when the active lease, branch, path, base commit, repository and filesystem identity, approved scope, and all changed paths still match. It never cleans, resets, or discards Worker files. Ambiguous, expired, mismatched, out-of-scope, failed, and budget-exhausted cases stay blocked. Host-owned commit finalization is attempted only for a valid `success` result; provider failures and any out-of-scope residue remain blocked for inspection.

| Status or error | Operator action |
| --- | --- |
| Dirty source or baseline/configuration drift | Restore the exact approved default-branch baseline and tracked four-file configuration, then propose again if facts changed. |
| Provider unavailable, timeout, or invalid provider output | Verify the pinned executable, interpreter, authentication, and version. If proposal failed, no run exists; correct the provider condition and propose again. If a Worker run is blocked with one exact active checkout, preserve it, check status, and use the current version to resume. |
| Invalid feature decomposition | Review whether the request has explicit acceptance criteria and whether the selected client can inspect the repository read-only. No run exists; correct the request or provider response and propose again. |
| Worktree scope or reconciliation block | Preserve the Worker checkout and evidence, correct only the reported scope/topology issue, then use version-bound `feature resume`. Exact in-scope work is continued; unsafe drift remains blocked. |
| Required quality gate failed | Run the tracked command in the local integration worktree, fix through a new approved run when code must change, and never edit private state. |
| `awaiting-final-approval` | Stop. Share the proposal, local commit, gate evidence, and limitations; do not push or grant final approval through this workflow. |

`feature status` is always the first recovery command. Never delete `.git/agilno`, `.git/rivet`, or `.rivet-worktrees` to force progress.

## Conference proof

```bash
node --test test/demo/conference-graph.test.js
node --test test/demo/checkpoints.test.js test/demo/reset.test.js
```

Follow `demo/conference/RUNBOOK.md`. The default is fixture mode; fake-client output is simulated evidence.

## Stop conditions

Stop if a repository is dirty, a private instance is unavailable, an expected version changes, a receipt is missing, a budget is exhausted, evidence is incomplete, or a fallback cannot be identified truthfully.
