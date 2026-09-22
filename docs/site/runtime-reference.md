# Runtime reference

This describes the current lower-level alpha runtime. The simpler active-harness workflow is still on the [roadmap](./roadmap.md).

## Project policy and diagnostics

Run `rivet --help` for command syntax. `rivet init --project=<path>` previews project policy; `--write` creates reviewed `.rivet` configuration. `rivet preflight --project=<path>` and `rivet doctor --project=<path>` report project readiness.

The runtime currently launches its selected Claude or Codex client for planning and Worker execution. Configure `RIVET_CLAUDE_EXECUTABLE` or `RIVET_CODEX_EXECUTABLE` to the canonical installed executable. Script entrypoints also need the appropriate `RIVET_CLAUDE_INTERPRETER` or `RIVET_CODEX_INTERPRETER`. Project checks using npm require `RIVET_NPM_EXECUTABLE`. Executable identity, supported version and local authentication must satisfy the adapter checks; a model registry entry alone does not configure execution.

## Feature lifecycle

The feature commands accept a Markdown request or configured Jira/Linear intake. `feature propose` produces a reviewable plan; `feature start` requires the exact reviewed proposal and current version. `feature status` reports progress. Inspect a blocked run before using `feature resume`; the CLI does not silently replace stale approvals or widen scope.

The same selected client performs planning and implementation. Planning is read-only; implementation is limited to its approved worktree. The current bridge runs one Worker at a time and uses fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

Local success stops at `awaiting-final-approval`. The feature workflow does not automatically push, merge, deploy or publish. Evidence and a model's success message are different: configured checks must pass, and delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## What is retained

Generic project/evidence templates, protocols, schemas and runtime safety checks remain part of the framework. The conference application generator and recording/rehearsal tooling have been removed. Synthetic test fixtures are development-only and are excluded from the npm package.
