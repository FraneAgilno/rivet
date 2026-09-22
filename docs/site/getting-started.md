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

Guided discovery currently requires a `package.json` with real `build` and `test` scripts. Missing scripts are reported for review rather than treated as passing checks. Other project types can install only the harness instructions using `install --minimal`; automatic setup for them is still planned.

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
