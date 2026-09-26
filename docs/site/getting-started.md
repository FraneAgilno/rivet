# Get started

Use Node.js 22 or 24, npm and Git on macOS or Linux. This is a development alpha; the npm package has not been published. Install the CLI from the public GitHub source branch:

```sh
npm install --global --install-links github:FraneAgilno/rivet#main
```

Confirm `rivet --help` works before continuing. Keep `--install-links` in the GitHub installation command; see [installation details](./installation.md).

## Connect a project

From your project root, preview the setup:

```sh
rivet setup
```

Review the detected checks and planned files, then apply:

```sh
rivet setup --write
```

Setup creates `.rivet` project policy and one minimal Rivet skill for Claude Code and Codex. Use `--target=claude` or `--target=codex` to select one. Existing valid configuration is preserved; edited or unowned skill files are never silently replaced. Setup does not execute your build or test scripts.

For Jira, Linear, Figma or Confluence, optionally run `rivet integrations setup` next. The [integration guide](./integrations.md#guided-configuration) walks through project scope, transport and credential references with a preview before writing. Skip this for local tasks.

Setup inspects the root package and bounded immediate child package directories. A root script takes precedence for its logical check. Otherwise, Rivet proposes the matching child scripts in stable path order. For example, a root with no scripts, a `backend` with `build` and `test`, and a `frontend` with `build` and `type-check` produces two ordered build steps, one backend test step, and an optional frontend typecheck step. Preview shows every exact `cwd` and `argv`, its provenance, unresolved required checks, and package-level coverage warnings. The checks have not run at preview time; `--write` is the explicit confirmation to store generated child steps.

When no `build` or `test` script exists in the supported root/immediate-child scope, setup still connects the project and reports an unresolved warning. The conservative placeholder remains non-executable until that exact package script exists: `doctor` and `preflight` fail readiness rather than treating it as available. Setup never runs scripts or installs dependencies.

This milestone does not interpret workspace globs or dependency graphs, search nested package trees, run checks in parallel, or accept arbitrary executables and environment overrides. Add root scripts when the repository needs ordering beyond the bounded immediate-child model.

Other project types can install only the harness instructions using `install --minimal`; automatic setup for them is still planned.

## Check the connection

Reload your coding harness if necessary, then ask:

> Read the Rivet skill and report this project's configured checks.

This verifies instruction discovery. The installed skill lets Claude Code, Codex, Gemini CLI, OpenCode, and other capable coding harnesses use Rivet's host workflow. Rivet seals the plan and evidence, then stops again for final human approval.

## Complete a first task

Review and commit the setup files and any package scripts needed by the configured checks. Start from a clean checkout of the configured default branch with a fresh or ahead remote-tracking ref. Run `rivet preflight --mode=host` to check host readiness, or `rivet doctor` for broader diagnostics. Resolve missing required checks before proposing work.

### In your coding harness

Give Claude Code, Codex, or another capable harness a request such as:

> Read the Rivet skill. Add a greeting module that exports a greeting string. Show me the exact plan before activation, perform the approved work in Rivet's isolated checkout, and show the changed files and executed checks for final review.

The harness handles Rivet's internal run ID, versions, digest, and JSON action files. You review the plan before activation and the verified result before delivery. If the harness needs to recover an interrupted action, it follows the skill's `work status` and `work next` instructions. Rivet does not push or merge the result automatically.

The host skill passes proposal/action/result JSON directly to Rivet, so temporary input files are not required. Rivet still needs permission to write private Git state and create isolated worktrees. Approve those exact operations through your harness when prompted. If your environment cannot grant access, use the terminal flow below. Full live host and desktop qualification remains open.

### In a terminal

If a compatible Claude or Codex CLI is installed and authenticated, you can start the same governed workflow with one command:

```sh
rivet run "Add a greeting module that exports a greeting string"
```

Direct terminal adapters check required CLI options instead of enforcing a version allowlist. Compatible versions can run without a Rivet update. Rivet retains its permission and output-contract requirements and stops if required options are missing. See [harness compatibility](./runtime-reference#harness-compatibility). Claude Code `2.1.274` and Codex CLI `0.155.0-alpha.16` completed small local terminal tasks on macOS; that evidence does not guarantee every past or future release.

For Node CLI launchers with the exact `#!/usr/bin/env node` shebang, Rivet discovers the canonical native Node executable already running Rivet. No interpreter export is needed for that common installation. Other script entrypoints still require an explicit compatible `RIVET_CLAUDE_INTERPRETER` or `RIVET_CODEX_INTERPRETER`; an explicit override is never silently replaced. Ctrl-C and SIGTERM stop Rivet's local child process before the command exits; use `rivet task status` to inspect an interrupted run before resuming it.

Run this from the configured project root or any folder inside it. Rivet finds the Git project, discovers a supported installed harness, plans the task, prints the full plan and required checks, and asks for approval in your terminal before starting. If both supported harnesses are installed, select one with `--harness=claude` or `--harness=codex`. Use `--project=<path>` only when you are outside the project or need an explicit root. The command does not treat a ticket ID alone as a verified request; describe the work or use the advanced ticket intake.

Check progress and evidence without copying an internal run ID:

```sh
rivet task status
rivet task resume
rivet task deps
```

`task status` shows the next action, integration checkout, changed paths, and executed checks when available. `task resume` continues an approved or blocked spawned run after its cause is corrected. It will not duplicate a run still marked running. If several active tasks exist in the same project, Rivet lists them and asks you to select one with `--run=<id>`; it never guesses. A failed check exits nonzero and leaves its report available in `task status`. Spawned Workers ask separately before installing locked dependencies in their own checkout. For a host Worker that needs dependencies before editing, or for a clean accepted integration checkout missing dependencies during verification, run `rivet task deps` from anywhere inside the project. Rivet shows the exact frozen package-manager command and asks before running it there. After integration setup, use `rivet task resume` for a spawned run or retry `work verify` for a host run at the same commit. Source changes require a new reviewed proposal.

The Worker and integration checkouts are isolated Git worktrees. Dependencies from your original checkout, such as `node_modules`, are not copied into them. Add `node_modules/` to your project's `.gitignore` so the isolated checkout remains clean after installation. Rivet's configured checks do not install packages. The result stops at `awaiting-final-approval` for your separate review; it is not a delivery or merge decision.

For the exact `feature` and `work` commands used by coding harnesses and automation, see the [runtime reference](./runtime-reference.md).

Project procedures are managed independently and discovered live:

```sh
rivet protocols add database-changes
rivet protocols find database --include-drafts
```

See [runtime reference](./runtime-reference.md) for the host command sequence and [memory and project protocols](./memory-and-protocols.md) for protocol publishing.

For global installation, updates, removal and contributor setup, see [installation details](./installation.md).

For a measured first-use acceptance run, follow the [first-task trial](./first-task-trial.md).
