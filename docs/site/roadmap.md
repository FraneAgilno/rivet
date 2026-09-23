# Roadmap

The next milestone is a first-task trial: a new developer installs Rivet, connects a project, and completes a small task through their coding harness or the terminal using the quickstart, without developer shell repair.

## Delivered MVP foundations

1. **Simple installation:** global and project scopes, environment diagnostics, setup preview/apply, and a clear uninstall path.
2. **Active-harness workflow:** the agent already in use can plan and execute sealed Rivet work without requiring a second model process.
3. **Project protocols:** teams can add, import, validate, publish, revise, and discover reviewed project procedures through the CLI.
4. **First-task controls:** terminal `run`, `task status`, and `task resume` manage project discovery and internal run values while preserving plan approval, isolated work, verification evidence, and final human review.

## Next MVP priorities

1. **Finish M1 readiness:** qualify current installed Claude/Codex CLI versions, prepare dependencies in isolated worktrees, and make setup failures actionable without hand-built shell fixes.
2. **Demonstrate both entry points:** run a small task in real Claude and Codex sessions and through the direct terminal path, then test the quickstart with a fresh user.
3. **Measure the first-task gate:** record whether the fresh user reaches a valid plan and reviewable result without manual repair. Keep versioned package publication separate from this alpha.

The repository is being kept focused on the reusable framework. Retired conference demos and internal implementation plans do not belong in the distributed product.

## Subsequent capabilities

- Configurable MCP integrations and verified Jira/Linear, Figma and knowledge-context workflows.
- Shared project memory with an Obsidian-compatible provider.
- GitHub, Bitbucket and GitLab delivery adapters.
- Bounded execution through more API and local model providers.
- Recovery improvements and broader evaluation coverage.

These remain planned until demonstrated. See [implementation status](./status.md) for current capability and [CI](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) for platform verification.
