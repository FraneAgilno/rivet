# Runtime reference

This describes the current lower-level alpha runtime. The simpler active-harness workflow is still on the [roadmap](./roadmap.md).

## Project policy and diagnostics

Run `rivet --help` for command syntax. `rivet init --project=<path>` previews project policy; `--write` creates reviewed `.rivet` configuration. `rivet preflight --project=<path>` and `rivet doctor --project=<path>` report project readiness.

Rivet supports two execution styles. Host mode lets the active coding harness plan and perform each sealed action without launching another model process. This is the portable path for Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and future harnesses. Spawned mode can still launch the selected Claude or Codex client. For spawned mode, configure `RIVET_CLAUDE_EXECUTABLE` or `RIVET_CODEX_EXECUTABLE` to the canonical installed executable. Script entrypoints also need the appropriate interpreter variable. Project checks using npm require `RIVET_NPM_EXECUTABLE`.

## Feature lifecycle

The feature commands accept a Markdown request or configured Jira/Linear intake. `feature propose` produces a reviewable plan; `feature start` requires the exact reviewed proposal and current version. `feature status` reports progress. Inspect a blocked run before using `feature resume`; the CLI does not silently replace stale approvals or widen scope.

Host mode uses this lifecycle:

```text
rivet work propose --project=<path> --request=<file> --decomposition=<json-file>
rivet feature start <run-id> --project=<path> --expected-version=<n> --proposal-digest=<digest>
rivet work prepare <run-id> --project=<path> --expected-version=<n>
rivet work next <run-id> --project=<path> --expected-runtime-version=<n>
rivet work submit <run-id> --project=<path> --expected-runtime-version=<n> --action=<json-file> --result=<json-file>
rivet work verify <run-id> --project=<path> --expected-version=<n> --expected-runtime-version=<n>
rivet work status <run-id> --project=<path>
```

Keep transient decomposition, action, and result files under `.git/rivet-inputs/` so they remain private state and do not dirty the repository. `work next` creates one isolated Worker checkout and returns a canonical launch/result contract. `work submit` rejects stale actions, changed contracts, evidence mismatches, and edits outside the sealed paths before integration. `work verify` inspects the real integration commit and runs configured gates, then stops at final human approval.

The same selected client performs planning and implementation. Planning is read-only; implementation is limited to its approved worktree. The current bridge runs one Worker at a time and uses fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

Local success stops at `awaiting-final-approval`. The feature workflow does not automatically push, merge, deploy or publish. Evidence and a model's success message are different: configured checks must pass, and delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## What is retained

Generic project/evidence templates, protocols, schemas and runtime safety checks remain part of the framework. The conference application generator and recording/rehearsal tooling have been removed. Synthetic test fixtures are development-only and are excluded from the npm package.
