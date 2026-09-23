# Get started

Use Node.js 22 or 24, npm and Git on macOS or Linux. This is a development alpha; the npm package has not been published. These commands install from the public GitHub source branch.

## Connect a project

From your project directory, preview the setup:

```sh
npx --yes --package=github:FraneAgilno/rivet#main rivet setup --project=.
```

Review the detected checks and planned files, then apply:

```sh
npx --yes --package=github:FraneAgilno/rivet#main rivet setup --project=. --write
```

Setup creates `.rivet` project policy and one minimal Rivet skill for Claude Code and Codex. Use `--target=claude` or `--target=codex` to select one. Existing valid configuration is preserved; edited or unowned skill files are never silently replaced. Setup does not execute your build or test scripts.

Setup inspects the root package and bounded immediate child package directories. A root script takes precedence for its logical check. Otherwise, Rivet proposes the matching child scripts in stable path order. For example, a root with no scripts, a `backend` with `build` and `test`, and a `frontend` with `build` and `type-check` produces two ordered build steps, one backend test step, and an optional frontend typecheck step. Preview shows every exact `cwd` and `argv`, its provenance, unresolved required checks, and package-level coverage warnings. The checks have not run at preview time; `--write` is the explicit confirmation to store generated child steps.

When no `build` or `test` script exists in the supported root/immediate-child scope, setup still connects the project and reports an unresolved warning. The conservative placeholder remains non-executable until that exact package script exists: `doctor` and `preflight` fail readiness rather than treating it as available. Setup never runs scripts or installs dependencies.

This milestone does not interpret workspace globs or dependency graphs, search nested package trees, run checks in parallel, or accept arbitrary executables and environment overrides. Add root scripts when the repository needs ordering beyond the bounded immediate-child model.

Other project types can install only the harness instructions using `install --minimal`; automatic setup for them is still planned.

## Check the connection

Reload your coding harness if necessary, then ask:

> Read the Rivet skill and report this project's configured checks.

This verifies instruction discovery. The installed skill can then use Rivet's host workflow from Claude Code, Codex, Gemini CLI, OpenCode, an editor agent, or another harness that can run the CLI and edit the returned isolated worktree. Rivet compiles the harness-supplied decomposition, seals scope and evidence, and stops again at final human approval; it does not need to launch another model.

## Complete a first task

Review and commit the setup files and any package scripts needed by the configured checks. Start from a clean checkout of the configured default branch with a fresh or ahead remote-tracking ref. Run `rivet preflight --project="$PWD" --mode=host --json` for host readiness. `rivet doctor --project="$PWD" --json` gives broader diagnostics, including configured providers; the default preflight includes separate orchestration goal checks. Resolve any missing tool or required package script before proposing work.

Give your coding harness a small, bounded request. For example:

> Read the Rivet skill and use its host workflow for this request: add a greeting module that exports a greeting string. Acceptance criterion: the module can be imported and returns the expected greeting. Inspect the repository, propose the exact files and checks, and show me the proposal before activation. After I approve it, perform the returned work in its isolated checkout, run verification, and show me the changed files and evidence for final review.

The harness writes its decomposition, action, and result JSON under `.git/rivet-inputs/`; you supply the task and review the proposal. The host sequence below shows how each command uses values returned by the preceding command. `--json` wraps each successful result in `result`; use the actual values from that object, never guessed version numbers or digests.

```sh
rivet work propose --project="$PWD" --request-text="$REQUEST_TEXT" \
  --decomposition="$PWD/.git/rivet-inputs/decomposition.json" --json
# Review result.workRequest and result.featurePlan. Record result.runId,
# result.version, and result.proposalDigest from this exact proposal.
rivet feature start "$RUN_ID" --project="$PWD" \
  --expected-version="$PROPOSAL_VERSION" --proposal-digest="$PROPOSAL_DIGEST" --json
rivet work prepare "$RUN_ID" --project="$PWD" \
  --expected-version="$APPROVED_VERSION" --json
rivet work next "$RUN_ID" --project="$PWD" \
  --expected-runtime-version="$PREPARED_RUNTIME_VERSION" --json
```

Activation is a human decision after reviewing the proposal. `APPROVED_VERSION` comes from `feature start`'s `result.version`; `PREPARED_RUNTIME_VERSION` comes from `work prepare`'s `result.runtimeVersion`. A `work next` result with `status: "action"` contains the sealed action and launch contract. The harness edits only the returned worktree and owned paths, then saves that exact action and its matching result contract in `.git/rivet-inputs/` before submitting:

```sh
rivet work submit "$RUN_ID" --project="$PWD" \
  --expected-runtime-version="$ACTION_RUNTIME_VERSION" \
  --action="$PWD/.git/rivet-inputs/action.json" \
  --result="$PWD/.git/rivet-inputs/result.json" --json
```

`ACTION_RUNTIME_VERSION` is the `runtimeVersion` returned with the action. If more work remains, call `work next` with the latest `runtimeVersion` returned by `work submit` and repeat. After all implementation actions are accepted, verify with the run version returned by `work prepare` and the latest runtime version:

```sh
rivet work verify "$RUN_ID" --project="$PWD" \
  --expected-version="$RUNNING_VERSION" \
  --expected-runtime-version="$LATEST_RUNTIME_VERSION" --json
rivet work status "$RUN_ID" --project="$PWD" --json
```

Successful verification reports `awaiting-final-approval`. `work status` shows the integration checkout and branch, the actual changed paths, worker claims, executed checks, and the next action. Worker claims are separate from checks Rivet actually ran. Review the diff and check results before deciding on delivery. Rivet does not push or merge it for you.

The Worker checkout and integration checkout are isolated Git worktrees. Ignored dependencies from your original checkout, such as `node_modules`, are not copied into either one. Prepare Worker dependencies at the path in the `work next` action; prepare verification dependencies at `work status` → `verification.integration.path`, with your own authority. Setup and Rivet's sealed quality commands do not install packages. If verification fails, it exits nonzero and `work status` retains the failed check report. An environment-only repair can be followed by `work verify` with the same versions and unchanged integration commit. A source change needs a new reviewed proposal.

If the harness is interrupted while an action is pending, use `work status` to read the current runtime version, then call `work next` with that version; it returns `waiting-for-result` and the same action. Do not repeat the edit or submit a newly invented action. `feature resume` does not apply to host runs. If a submission blocks, retain its response and inspect `work status`; create a new reviewed corrective proposal rather than manually editing private state.

Project procedures are managed independently and discovered live:

```sh
rivet protocols add database-changes --project="$PWD"
rivet protocols find database --project="$PWD" --include-drafts
```

See [runtime reference](./runtime-reference.md) for the host command sequence and [memory and project protocols](./memory-and-protocols.md) for protocol publishing.

For global installation, updates, removal and contributor setup, see [installation details](./installation.md).
