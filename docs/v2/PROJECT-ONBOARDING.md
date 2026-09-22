> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Rivet v2 Project Onboarding

All commands in this guide use the v2 CLI from the checked-out private branch.
This avoids accidentally selecting the older published npm package:

```bash
RIVET_REPO="$(pwd)"
npm ci
RIVET_CLI="$RIVET_REPO/bin/cli.js"
rivet() { node "$RIVET_CLI" "$@"; }
rivet --help
```

## 1. Establish repository ownership

Name the repository owner, default branch, allowed worktree root, sensitive paths, package manager, and exact build/test commands. Use a clean Git repository; do not onboard an arbitrary directory.

## 2. Generate and review tracked configuration

Run `node bin/cli.js init --project=/absolute/project --write` and review the exact four-file boundary: `.rivet/project.yaml`, `.rivet/providers.yaml`, `.rivet/orchestration.yaml`, and `.rivet/quality.yaml`. Configuration describes roles, provider references, quality gates, and policy only. It must not contain credentials, application acceptance data, private instance state, or approval receipts.

Orchestration is disabled by default. Keep `enabled: false` in tracked policy; activation occurs only in the private runtime after a human decision.

## 3. Start with bounded local providers

Use the fake client and sanitized provider fixtures before configuring live reads. Provider modes begin disabled or read-only. External writes remain disabled until a separate approval-governed write plan identifies the exact resource, expected state, idempotency registry, and human approver.

## 4. Define the graph

Use one Boss root, bounded Manager-owned lanes, small Worker objectives, explicit dependencies, finite budgets, exact evidence types, and one final-delivery Boss gate requiring human approval. Do not use a single node for an entire product build.

## 5. Verify before activation

Run doctor, preflight, graph validation, scheduler tests, fake-client rehearsal, quality gates, package checks, and a secret scan. Create the private orchestration instance only after those checks and retain its identity outside Git.

## 6. Expand deliberately

Adding a live provider, external mutation, new client runtime, deployment target, or publication path is a new authority boundary. Review and test it independently rather than inheriting permission from project onboarding.

## 7. Enable generic feature requests

Install the mandatory skills for both supported agents:

```bash
rivet install --all --target=both
```

The installed `feature-workflow` skill maps natural-language Claude/Codex requests to the same `rivet feature` application service used by the terminal. It accepts exactly one inline, Markdown, Jira, or Linear source. Configure tracker endpoints and environment-variable names in `.rivet`; keep credential values outside Git and agent prompts.

Before using a ticket, confirm that exactly one enabled read-capable provider matches or name `--tracker=jira|linear`. Missing credentials or inaccessible tickets are blocking. Agents must not infer ticket facts or silently switch to direct MCP/manual orchestration.

Use `feature propose` first, show the complete immutable proposal and its version/digest, then request exact human activation. Execution remains local and private through the final human gate; push, merge, deploy, publication, and tracker writes are separate authority boundaries.

## 8. Pin Claude or Codex locally

Install and authenticate the client you intend to select, then verify it independently with `claude --version` or `codex --version`. Rivet requires canonical absolute executables; it never discovers a different client after proposal.

```bash
export RIVET_CLAUDE_EXECUTABLE="$(realpath "$(command -v claude)")"
export RIVET_CODEX_EXECUTABLE="$(realpath "$(command -v codex)")"
```

If the canonical executable is a Node script (`#!/usr/bin/env node` or a pinned Node shebang), also pin its native interpreter. Native client binaries omit the matching interpreter variable.

```bash
export RIVET_CLAUDE_INTERPRETER="$(realpath "$(command -v node)")"
export RIVET_CODEX_INTERPRETER="$(realpath "$(command -v node)")"
```

Quality commands need a canonical regular executable too. Set `RIVET_NPM_EXECUTABLE` to an owner-controlled executable wrapper when the local `npm` command is a symlink or script; do not place the wrapper or credentials in the project. Equivalent `RIVET_PNPM_EXECUTABLE`, `RIVET_YARN_EXECUTABLE`, or `RIVET_BUN_EXECUTABLE` variables follow the tracked package-manager command.

The selected client is used for the whole run: Claude plans with `dontAsk`, the exact `Read,Glob,Grep` tool allowlist, and the feature-decomposition JSON schema, then executes Workers with `acceptEdits`; Codex plans with `read-only` and executes Workers with `workspace-write`. Both execution modes remain bounded to each reserved Worker worktree and sealed contract.

## 9. Understand local worktree placement

Private versioned state remains under the repository's Git common directory. Checkouts live outside the source repository at a deterministic sibling `.rivet-worktrees/<repository-id>/<run-id>/` root. The integration branch starts from the approved baseline, Workers run one at a time from the current integration tip, and the user's default checkout is never advanced.
