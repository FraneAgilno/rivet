# Runtime reference

This describes the current alpha runtime, including the active-harness workflow available through the `rivet work` commands.

## Project policy and diagnostics

Run `rivet --help` for command syntax. `rivet init --project=<path>` previews project policy; `--write` creates reviewed `.rivet` configuration. `rivet preflight --project=<path>` reports orchestration readiness; `--mode=host` checks host repository, tool, and script readiness without requiring a private goal or unused provider credentials. `rivet doctor --project=<path>` reports general project readiness.

Root-only project configuration remains schema version 1, where each logical command is one three-token package-manager invocation. Setup uses project schema version 2 only when a logical command needs structured steps:

```yaml
schemaVersion: 2
commands:
  build:
    steps:
      - {cwd: backend, argv: [npm, run, build]}
      - {cwd: frontend, argv: [npm, run, build]}
  test:
    steps:
      - {cwd: backend, argv: [npm, run, test]}
```

Supported schema-v2 logical checks are `build`, `test`, `lint`, and `typecheck`; `typecheck` may invoke a package script named `typecheck` or `type-check`. Every required step must pass. Doctor and preflight verify the exact bounded directory, `package.json`, script, package manager, and executable resolved by the same runtime resolver, without executing project scripts. Runtime verification revalidates each exact package manifest before executing steps sequentially relative to the isolated integration worktree through the existing shell-free package-manager policy. New setup proposals never add `dev` as a quality gate; an existing valid schema-v1 configuration may retain its previously configured `dev` command or gate.

Rivet supports two execution styles. Host mode lets the active coding harness plan and perform each sealed action without launching another model process. This is the portable path for Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and future harnesses. Spawned mode can still launch the selected Claude or Codex client. For spawned mode, configure `RIVET_CLAUDE_EXECUTABLE` or `RIVET_CODEX_EXECUTABLE` to the canonical installed executable. During terminal harness discovery (`rivet run` and task resume), exact `#!/usr/bin/env node` entrypoints use the canonical native Node executable running Rivet when no interpreter override is set. Other script entrypoints and direct low-level client construction require explicit interpreter configuration. Discovery rejects project-local interpreters and still checks required CLI capabilities. Project checks use the configured npm, pnpm, yarn, or bun runner. The selected runtime integration must resolve that package-manager executable; setup does not install it or project dependencies.

For interactive terminal use, `rivet run "task"` finds the configured Git root from the current directory, discovers a compatible installed Claude or Codex adapter, shows the complete bounded plan and required checks, and asks for approval before execution. `--harness=claude|codex` selects between two eligible adapters. `--project=<path>` is only needed outside the project or to choose a root explicitly. `rivet task status` selects the sole active run in that project and shows the next action and verification evidence. `rivet task resume` continues an approved or blocked spawned run; it does not duplicate one marked running. Before a spawned Worker starts, Rivet shows the frozen install command for locked root dependencies and asks for a separate approval. `rivet task deps` applies the same approval to a clean active host Worker or accepted integration checkout. Multiple active runs require `--run=<id>`. These human commands keep the exact run ID, version, and proposal digest internal in the usual case. A ticket ID by itself is not accepted as an inline request.

The terminal flow needs a real interactive terminal for review; piped input cannot approve a plan. Direct adapters check required CLI options without a release allowlist; see [harness compatibility](#harness-compatibility). It uses the selected installed CLI and its existing authentication. It does not grant credentials or install a harness. Spawned verification records the accepted integration commit and a durable check report for both pass and failure. A failed check returns nonzero; an environment-only repair can be retried at the same unchanged commit. Final approval requires a matching report, runtime, and clean checkout. A spawned run marked running after an interruption needs process and state inspection before recovery because Rivet cannot prove the prior worker has stopped.

## Feature lifecycle

The feature commands accept a Markdown request or configured Jira/Linear intake. `feature propose` produces a reviewable plan; `feature start` requires the exact reviewed proposal and current version. `feature status` reports progress. `feature resume` applies to spawned runs; host runs use the `work` commands. The CLI does not silently replace stale approvals or widen scope.

Direct ticket intake accepts `--acceptance-criteria '<user criteria>'` alongside `--ticket` on `work propose`, `feature propose` and `feature run`. Separate multiple criteria with newlines. Rivet retains their user origin separately from tracker criteria and includes them in the request digest. When both sources are empty, ask the user for criteria and retry; do not invent them. This option is invalid for Markdown, inline or MCP requests. See [tracker criteria](./integrations.md#direct-tracker-acceptance-criteria).

Host mode uses this lifecycle:

```text
rivet work propose --project=<path> --request-text=<text> --decomposition-json='<json>'
rivet feature start <run-id> --project=<path> --expected-version=<n> --proposal-digest=<digest>
rivet work prepare <run-id> --project=<path> --expected-version=<n>
rivet work next <run-id> --project=<path> --expected-runtime-version=<n>
rivet work submit <run-id> --project=<path> --expected-runtime-version=<n> --action-json='<json>' --result-json='<json>'
rivet work verify <run-id> --project=<path> --expected-version=<n> --expected-runtime-version=<n>
rivet work status <run-id> --project=<path>
```

Direct JSON inputs avoid temporary files and keep the Git baseline clean. Each inline JSON value is limited to 64 KiB of UTF-8. Pass it as one argument, preferably using a shell-free argument array; JSON serialization alone is not shell escaping. Existing `--decomposition`, `--action`, and `--result` file inputs remain available for project-contained files up to 128 KiB. Choose exactly one form per object; mixed file/inline submissions are supported. File path and runtime contract checks are unchanged. Credentials do not belong in payloads; command arguments can appear in history or process listings. Review and commit setup configuration and required scripts before proposing from a clean default branch. `work next` creates one isolated Worker checkout and returns a canonical launch/result contract. `work submit` rejects stale actions, changed contracts, evidence mismatches, and edits outside the sealed paths before integration. `work verify` inspects the real integration commit and runs configured gates, then stops at final human approval. It stores a bounded private report for both passing and failed checks; failed checks return nonzero and do not advance the run to final approval.

The same selected client performs planning and implementation. Planning is read-only; implementation is limited to its approved worktree. The current bridge runs one Worker at a time and uses fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

`work status` reads existing private state without preparing worktrees. Its `workerCheckouts` report identifies reserved and active Worker paths, expected/observed branches, edits and lease expiry, including interrupted preparation. See [task and checkout status](./statuses.md) for recovery guidance. It reports the integration path and branch, changed paths, worker claims, executed check results, blocked nodes when present, and a next action. Call `work next` with the current runtime version after an interruption to recover the same pending action. A failed check can be retried against the same unchanged commit after an environment or dependency repair; source corrections and blocked submissions need a new reviewed proposal. Dependencies must be prepared in the isolated checkout where they are needed: the active Worker path for editing, or the accepted integration path for verification. `rivet task deps` selects either eligible checkout from the private run and reservation state, validates its Git identity and matching lockfile, and asks for explicit approval. They are not copied from the original checkout or installed by Rivet's quality commands. Host preflight requires a clean checkout of the configured default branch and a fresh or ahead corresponding remote-tracking ref. It checks the same configured branch used for proposal admission.

Successful final approval status requires a coherent private verification report, accepted integration identity, runtime state, and clean checkout at the tested commit. Missing evidence is reported as undeliverable. After an interrupted host command, `rivet task recover` explicitly attempts safe recovery of abandoned host-operation, run, runtime and state locks. It selects the sole active host task; use `--run=<id>` when there are several. For a harness, use `rivet work recover <run-id> --project=<absolute-path> --json`. Recovery validates saved state and the current project configuration, requires an unchanged lock owner on this machine whose process is provably dead and whose lock is at least five minutes old, and preserves task snapshots and worktrees. It never resumes Workers. A blocked result can list locks already recovered before reaching another owner; inspect that result before retrying. There is no force option. See [interruption recovery](./troubleshooting.md#a-host-action-was-interrupted-or-blocked).

Local success stops at `awaiting-final-approval`. The feature workflow does not automatically push, merge, deploy or publish. Worker claims and a model's success message are different from executed checks; delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## What is retained

Generic project/evidence templates, protocols, schemas and runtime safety checks remain part of the framework. The conference application generator and recording/rehearsal tooling have been removed. Synthetic test fixtures are development-only and are excluded from the npm package.


## Harness compatibility

Rivet checks CLI capabilities instead of requiring a specific release. Before a spawned task, bounded version and help probes verify the installed executable and required options. Claude uses `--help`; Codex uses `exec --help`. Selection records the observed version and checks it again before launch. Advanced explicitly configured clients detect their installed version unless their caller supplies an optional `expectedVersion` consistency check.

Claude requires print mode, text input, JSON output, no session persistence, model/effort selection, permission modes, tool restrictions, JSON schema, and a cost limit. Codex requires exec, ephemeral execution, ignored user configuration, color control, and sandbox selection. Each launch also checks its selected optional flags. Rivet never drops required safety flags. Executable identity checks, cancellation, output limits, and strict result validation still apply.

Help checks establish advertised options; they cannot prove unchanged semantics, authentication, model availability, or future output formats. Incompatible results fail validation. Tested releases are evidence, not an allowlist: prior fixtures cover Claude `2.1.207` and Codex `0.148.0-alpha.9`; small authenticated macOS terminal trials completed with Claude `2.1.274` and Codex `0.155.0-alpha.16`. Regression tests also exercise unfamiliar version labels.

Spawned process adapters currently support macOS and Linux. Native Windows execution is not supported; an app running on Windows does not remove that runtime limit. WSL needs its own compatible environment and qualification.

### CLI and desktop host sessions

Host mode uses the current session's model and tools without checking its app or CLI version.

| Surface | Host workflow requirements |
| --- | --- |
| Claude Code CLI | Rivet skill, terminal/file tools, project access, operation permissions |
| Claude desktop Code tab, local session | Same requirements; open the repository in a coding session |
| Codex CLI | Rivet skill, terminal/file tools, project access, operation permissions |
| Codex app, local task | Same requirements; attach the repository and make the skill available |
| Ordinary chat or restricted remote session | An execution environment exposing those capabilities; chat alone is insufficient |

The [Claude desktop reference](https://code.claude.com/docs/en/desktop) describes local Code sessions, skills, and permission modes. The [Codex app features](https://developers.openai.com/codex/app/features) describe its coding environment. Product capabilities do not establish completed Rivet desktop qualification.

The host needs permission to invoke Rivet, edit the exact reserved checkout, write private Git state, create isolated worktrees, run checks, and present human approvals. `rivet preflight --mode=host --project=<path>` checks project readiness; it cannot prove the surrounding app grants every later operation.

**Current alpha limitation:** direct JSON removes the temporary input writes that blocked earlier noninteractive host trials. Private Git state and sibling worktrees still require permission. Use normal operation approvals for those exact operations, or the terminal `rivet run` flow if permissions cannot be granted. Automated host lifecycle coverage is not live desktop qualification; full real-harness and fresh-user trials remain open.


### Host proposal input format

`--request-text` requires Markdown with a `# Title` and a nonempty `## Acceptance Criteria` bullet list. The active harness converts the user's request into this format. It must preserve the requested scope rather than inventing criteria.

`--decomposition-json` contains exactly `schemaVersion: 1`, `kind: "agilno.feature-decomposition"`, and `workItems`. Each of 1–16 work items has `objective`, `ownedPaths`, and `acceptanceCriterionIndexes`. Indexes start at one and must cover every request criterion. Owned paths list files to change, not files merely read. Roles, commands, budgets, and approval gates come from project policy and are not decomposition fields. The installed Rivet skill includes a complete example.
