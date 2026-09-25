# Rivet

A shared development workflow for teams and their coding agents.

Rivet is a **standalone development alpha** with its own CLI, configuration, state, and releases.

## Connect a project

With Node.js 22 or 24, npm and Git installed, install the alpha CLI, then run setup from your project:

```sh
npm install --global --install-links github:FraneAgilno/rivet#main
rivet setup
```

Review the preview, then repeat with `--write`. This configures project policy and minimal harness instructions; it does not run project scripts or configure model authentication. [Quickstart](https://franeagilno.github.io/rivet/getting-started.html).

After committing the setup files and configuring the required project checks, ask your coding harness to read the Rivet skill and complete a task. With a compatible, authenticated Claude Code or Codex CLI, you can also run from the project root or any folder inside it:

```sh
rivet run "Add a greeting module"
rivet task status
rivet task resume
rivet task deps
```

Rivet discovers the project, shows the plan for approval, and manages internal run IDs and revisions. Locked dependencies get a separate approval before a spawned Worker starts; `task deps` prepares the active host Worker or accepted integration checkout when needed. `--project` is only needed when invoking it from outside the project. Direct terminal adapters support Claude Code `2.1.207` and `2.1.274`, and Codex CLI `0.148.0-alpha.9` and `0.155.0-alpha.16`. The current versions completed small local tasks with passing checks on macOS; broader first-user qualification remains open.

## Contributor checkout

Use Node.js 22 or 24 and Git. From this source checkout:

```sh
npm ci
npm run build
node bin/cli.js --help
node bin/cli.js models list
npm run docs:build
npm run docs:preview
```

No public package has been published. The package namespace is provisional, publication is disabled, and the license is awaiting owner selection.

## What works today

- Independent `rivet` command, `.rivet` configuration, and private state.
- Namespaced Claude/Codex skill installation that preserves other frameworks' skills.
- Harness-neutral host execution for Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and other CLI-capable harnesses.
- One-command terminal task planning and execution with project discovery, human approval, status, resume, and durable verification evidence for validated Claude/Codex CLI versions.
- Live project protocols with explicit draft, publish, revision, and digest controls.
- Extensible model registry with local profile validation for hosted, local, compatible, and harness providers.
- Imported workflow, Git worktree, provider, and verification modules.
- CI and searchable documentation source.

Additional API/local model executors, shared Obsidian memory, and expanded repository delivery are **planned**, not completed. A provider appearing in the registry is not a claim of live model execution.

## Documentation

[Read the documentation](https://franeagilno.github.io/rivet/) · [CI results](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml)

- [Get started](docs/site/getting-started.md)
- [Architecture](docs/site/architecture.md)
- [Model providers](docs/site/models.md)
- [Implementation status](docs/site/status.md)
- [Contributing](CONTRIBUTING.md)
- [Source provenance](docs/PROVENANCE.md)

The documentation site is built from `docs/site/` using VitePress. The public repository is [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet). GitHub Pages publishing uses the repository’s documentation workflow.
