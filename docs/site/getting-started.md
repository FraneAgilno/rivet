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

This verifies instruction discovery, not model authentication or autonomous task execution. The simplified active-harness workflow is the next milestone. See [status](./status.md) for current limits.

For global installation, updates, removal and contributor setup, see [installation details](./installation.md).
