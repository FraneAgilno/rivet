# Compatibility and qualification

Rivet is an alpha. An implemented adapter, a passing fixture, and a successful task with a real account are separate kinds of evidence. This matrix records those distinctions; it is not a claim that every listed integration is ready for unattended use.

## Runtime and installation

| Environment | Evidence | Remaining qualification |
| --- | --- | --- |
| macOS, Node 22 and 24 | CI tests and global tarball/Git installation lifecycle | Independent first-user trial on the release artifact |
| Linux, Node 22 and 24 | CI tests and global tarball/Git installation lifecycle | Authenticated task and independent first-user trial |
| Windows native | Spawned process adapters unsupported | Native platform implementation and qualification |
| WSL | Unqualified | Separately qualified Linux installation, processes, filesystem and complete task checks |
| GitHub source install | Operator-tested on macOS with npm 10.9.4; requires `--install-links` | Independent onboarding; see [first-use evidence](./first-task-trial.md) |
| Versioned release artifact | Release qualification pending | Downloaded artifact checksum, installation lifecycle and candidate evidence |

Node 22 is the minimum declared runtime. A newer runtime is not automatically qualified by satisfying that minimum. CI records the actual runtime versions used in each run. Dependencies are resolved during installation; a Rivet tarball checksum does not make the dependency installation fully reproducible.

## Coding harnesses

| Entry point | Evidence | Remaining qualification |
| --- | --- | --- |
| Claude Code CLI | Capability probes and direct terminal task trials on macOS with 2.1.274 | Full active-host lifecycle and independent onboarding |
| Codex CLI | Capability probes and direct terminal task trials on macOS with 0.155.0-alpha.16 | Full active-host lifecycle and independent onboarding |
| Claude desktop / Codex desktop | Host protocol available; no completed desktop qualification | Skill discovery and complete normal-permission desktop workflow |
| Other coding harnesses | Host command contract available; no separate model account required by host mode | Harness-specific discovery, permissions and end-to-end task qualification |

The observed versions are evidence, not a fixed version allowlist. Spawned adapters probe required CLI capabilities and refuse incompatible installations. Host mode uses the current coding agent through explicit `work` commands; it does not assert that every host implements the same connector or permission interface. See [runtime reference](./runtime-reference.md).

## Integrations and delivery

| Area | Implemented evidence | Remaining live qualification |
| --- | --- | --- |
| Jira / Linear intake | Sourced request contracts, fixtures and scoped transports | Dummy project/ticket reads, source drift and permission handling |
| Figma / Confluence context | Linked context, provenance and bounded intake fixtures | Real non-sensitive resource-to-task flow |
| Harness MCP intake | Project-scoped inventory and readiness checks | Actual host-connected resources and authentication |
| GitHub / GitLab / Bitbucket inspection | Common read contracts and public repository/branch smoke | Authenticated private sandbox flows; see [repository matrix](./repositories.md) |
| GitHub / GitLab merge | Exact-head merge executors and governed lifecycle fixtures for documented policy subsets | Authorized sandbox delivery |
| GitHub Actions deployment | Approved workflow dispatch and correlated outcome verification fixtures | One configured nonproduction deployment |
| Jira / Linear delivery comments | Separate approval, exact-content readback and reconciliation fixtures | Authorized live comments; status transitions remain separate work |

Native review creation, source branch publication and Bitbucket writes must be checked against the current [delivery documentation](./delivery.md). A fixture for one provider does not qualify the others. Custom repository hosts and enterprise/self-managed editions require separate qualification.

## Models and memory

The model registry and text delegation support Anthropic, OpenAI, Gemini, Ollama and configurable OpenAI-compatible protocols. Fixture coverage establishes request, output and policy handling; it does not establish live account compatibility. Live text delegation through API/local profiles remains unqualified. Required evidence includes a provider outside Anthropic/OpenAI, a local model and cross-harness delegation. Monetary caps are not currently enforced by text delegation; see [model limits](./models.md#limits-and-current-scope).

Shared Obsidian memory is deferred from the current implementation pass and remains unimplemented and unqualified. Two-user continuity, sync conflicts, offline recovery and access changes require their own evidence.

## Candidate evidence

For each release candidate, retain the exact source revision, artifact hash, OS/architecture, Node/npm versions, harness/model versions, test results, trial interventions and unresolved limitations. CI success does not close the independent pilot: five people who did not build Rivet must complete the plan's onboarding and reviewable-task requirements. See [evaluations and trials](./evaluations.md).
