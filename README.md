# Rivet

A shared development workflow for teams and their coding agents.

Rivet is a **standalone development alpha** with its own CLI, configuration, state, and releases. It uses a reviewed Agilno source import and has no runtime dependency on AI Engineering.

## Try the foundation

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
- Extensible model registry with local profile validation for hosted, local, compatible, and harness providers.
- Imported workflow, Git worktree, provider, and verification modules.
- CI and searchable documentation source.

The additional API/local model executors, active-harness workflow, shared Obsidian memory, project-protocol commands, and expanded repository delivery are **planned**, not completed. A provider appearing in the registry is not a claim of live model execution.

## Documentation

[Read the documentation](https://franeagilno.github.io/rivet/) · [CI results](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml)

- [Get started](docs/site/getting-started.md)
- [Architecture](docs/site/architecture.md)
- [Model providers](docs/site/models.md)
- [Implementation status](docs/site/status.md)
- [Contributing](CONTRIBUTING.md)
- [Import provenance](docs/maintainers/migration.md)

The documentation site is built from `docs/site/` using VitePress. The public repository is [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet). GitHub Pages publishing uses the repository’s documentation workflow.
