# Implementation status

This is a foundation alpha, not the finished MVP or a published npm release.

## Implemented in the foundation

- Independent repository, package identity, CLI, configuration, and private-state namespace.
- Minimal project/global harness installation with ownership tracking, plus the legacy capability packs.
- Setup preview/apply with bounded root and immediate-child package discovery, ordered multi-step quality commands, honest unresolved warnings, and byte-preserving existing configuration.
- Active-harness `work` commands for harness-supplied planning, isolated Worker execution, bounded integration, and verification without launching a second model process.
- Interactive `rivet run "task"` from a configured project root or nested folder, with automatic project discovery, a reviewed approval gate, and compatible installed Claude/Codex execution.
- `rivet task status`, `rivet task resume`, and `rivet task deps` select a unique active run without asking for its ID. Dependency setup prepares a clean active host Worker or accepted integration checkout after separate interactive approval. Spawned Workers ask before installing locked dependencies in their isolated checkout.
- Direct terminal task trials on macOS completed with Claude Code `2.1.274` and Codex CLI `0.155.0-alpha.16`; both reached final review with passing build, test, lint, and typecheck evidence.
- Project protocol commands with draft, publish, revision, digest, import, validation, and live discovery controls.
- Extensible model registry and local profile validation.
- Imported workflow, worktree, evidence, provider, and quality modules.
- GitHub CI and documentation workflows for FraneAgilno/rivet.
- Searchable documentation source and a local build.

## Still required

- License selection and final package namespace.
- Versioned package distribution and discovery beyond bounded immediate child packages.
- Conversational active-harness first-task demonstrations in real Claude and Codex sessions. Default noninteractive sessions blocked writes to the skill's `.git/rivet-inputs/` path before `work propose`; that input workflow needs a sandbox-compatible location. Direct adapters check required capabilities without a version allowlist; Claude `2.1.274` and Codex `0.155.0-alpha.16` have local terminal trials on macOS. Desktop host lifecycle qualification remains open.
- A fresh-user M1 trial that completes a small task without manual shell repair.
- Shared Obsidian memory.
- MCP capability registry and live provider qualification.
- Bitbucket/GitLab repository delivery and expanded model executors.
- External pilot, evaluations, and release qualification.

See the [roadmap](./roadmap.md) for the next milestones. Detailed implementation planning is maintained outside this repository.

## Public foundation

The source is published at [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet) and this documentation is deployed to GitHub Pages. [CI results](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) record the macOS/Linux and Node 22/24 matrix. CI tests fixtures and package behavior; it does not qualify live model or MCP accounts.
