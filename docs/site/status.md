# Implementation status

This is a foundation alpha, not the finished MVP or a published npm release.

## Implemented in the foundation

- Independent repository, package identity, CLI, configuration, and private-state namespace.
- Minimal project/global harness installation with ownership tracking, plus the legacy capability packs.
- Setup preview/apply with bounded root and immediate-child package discovery, ordered multi-step quality commands, honest unresolved warnings, and byte-preserving existing configuration.
- Active-harness `work` commands for harness-supplied planning, isolated Worker execution, bounded integration, and verification without launching a second model process.
- Interactive `rivet run "task"` from a configured project root or nested folder, with automatic project discovery, a reviewed approval gate, and compatible installed Claude/Codex execution.
- `rivet task status`, `rivet task resume`, and `rivet task deps` select a unique active run without asking for its ID. Dependency recovery prepares the clean accepted integration checkout from a matching lockfile after separate interactive approval.
- Project protocol commands with draft, publish, revision, digest, import, validation, and live discovery controls.
- Extensible model registry and local profile validation.
- Imported workflow, worktree, evidence, provider, and quality modules.
- GitHub CI and documentation workflows for FraneAgilno/rivet.
- Searchable documentation source and a local build.

## Still required

- License selection and final package namespace.
- Versioned package distribution, discovery beyond bounded immediate child packages, and dependency bootstrap before Worker execution in isolated worktrees.
- Live Claude/Codex first-task demonstrations and qualification of current installed CLI versions; the direct adapters currently validate Claude Code `2.1.207` and Codex CLI `0.148.0-alpha.9`.
- A fresh-user M1 trial that completes a small task without manual shell repair.
- Shared Obsidian memory.
- MCP capability registry and live provider qualification.
- Bitbucket/GitLab repository delivery and expanded model executors.
- External pilot, evaluations, and release qualification.

See the [roadmap](./roadmap.md) for the next milestones. Detailed implementation planning is maintained outside this repository.

## Public foundation

The source is published at [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet) and this documentation is deployed to GitHub Pages. [CI results](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) record the macOS/Linux and Node 22/24 matrix. CI tests fixtures and package behavior; it does not qualify live model or MCP accounts.
