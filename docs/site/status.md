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
- Integration registry with explicit transport/scope/readiness, bounded host inventory, and sourced Jira/Linear requests with linked Figma/Confluence context. Host observations remain labeled and digest-bound; live provider qualification remains open.
- Common read-only repository inspection for GitHub.com, Bitbucket Cloud and GitLab.com, with explicit remote selection and commit-bound evidence. See the [repository capability matrix](./repositories.md); live qualification and delivery writes remain open.
- Local delivery preparation/status from accepted host verification, plus a durable service for separately approved delivery operations. Native GitHub PR and GitLab MR merging is implemented for documented bounded policy subsets, with interactive approval and read-only reconciliation. Other native operations and live qualification remain pending. See [delivery lifecycle](./delivery.md).
- Project-configured GitHub Actions deployment of a confirmed merge SHA, with separate approval, mandatory workflow verification and correlated status/run reconciliation. Live deployment qualification remains open.
- Jira/Linear delivery-summary comments on the recorded source ticket, with separate approval, exact-content read-back and reconciliation without automatic reposting. Status transitions and live tracker qualification remain open.
- Explicit delivery lock recovery for stale same-machine dead owners, preserving operation evidence before read-only reconciliation. Broader crash/live recovery qualification remains open.
- Imported workflow, worktree, evidence, provider, and quality modules.
- GitHub CI and documentation workflows for FraneAgilno/rivet.
- Searchable documentation source and a local build.

## Still required

- License selection and final package namespace.
- Versioned package distribution and discovery beyond bounded immediate child packages.
- Conversational active-harness first-task demonstrations in real Claude and Codex sessions. Direct JSON inputs remove the temporary-file obstruction from earlier noninteractive trials; private Git state/worktree permissions and live lifecycle trials still need validation. Direct adapters check required capabilities without a version allowlist; Claude `2.1.274` and Codex `0.155.0-alpha.16` have local terminal trials on macOS. Desktop host lifecycle qualification remains open.
- A fresh-user M1 trial that completes a small task without manual shell repair.
- Shared Obsidian memory.
- Live provider qualification for the integration registry and context intake.
- Bitbucket/GitLab repository delivery and expanded model executors.
- External pilot, evaluations, and release qualification.

The delivery lifecycle also preserves independent deployment/tracker completion order, binds reconciliation to the approved provider, and requires new post-merge completion receipts to match the merge result. Native GitHub Actions deployment is implemented for a configured workflow; Jira/Linear delivery-summary comments are implemented; tracker status transitions and live delivery qualification remain pending.

See the [roadmap](./roadmap.md) for the next milestones. Detailed implementation planning is maintained outside this repository.

## Host onboarding observations (2026-09-23)

Installed-package proposal trials on macOS found the managed skill in both Claude Code `2.1.274` and Codex CLI `0.155.0-alpha.16`. They exposed missing proposal examples and private Git-state permission failures. The skill now includes the exact request/decomposition format, and direct filesystem permission errors explain how to request normal harness approval.

Noninteractive Codex stopped at the permission boundary. An initial interactive Codex attempt was canceled at approval. A follow-up interactive trial approved the exact proposal command through the normal permission prompt, created the proposal, and stopped at the activation gate with the source checkout clean. This establishes operator-assisted proposal creation only; execution and final review remain unqualified. Claude's noninteractive command checks rejected multiline arguments. The skill now explicitly requires stopping for ordinary approval instead of trying alternative encodings or files after a safety denial.

A noninteractive Claude retest still attempted alternative inputs after denial and was stopped. In a subsequent interactive default-permission session, the original proposal command succeeded after normal approval. Declining a separate preflight permission prompt interrupted the turn without another attempt. This establishes a supported interactive permission path for proposal creation; it does not qualify noninteractive behavior or the complete lifecycle.

These are operator-run diagnostics, not completed first-task or fresh-user acceptance trials. Full host execution, desktop sessions, and fresh-user M1 validation remain open.

## Public foundation

The source is published at [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet) and this documentation is deployed to GitHub Pages. [CI results](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) record the macOS/Linux and Node 22/24 matrix. CI tests fixtures and package behavior; it does not qualify live model or MCP accounts.
