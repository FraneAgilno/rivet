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

Project procedures are managed independently and discovered live:

```sh
rivet protocols add database-changes --project="$PWD"
rivet protocols find database --project="$PWD" --include-drafts
```

See [runtime reference](./runtime-reference.md) for the host command sequence and [memory and project protocols](./memory-and-protocols.md) for protocol publishing.

For global installation, updates, removal and contributor setup, see [installation details](./installation.md).
