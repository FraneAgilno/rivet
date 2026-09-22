# Roadmap

The next release should let a new developer install Rivet, connect a project, and complete a small task through their existing coding harness using only the quickstart.

## MVP priorities

1. **Simple installation:** global and project scopes, useful environment diagnostics, and a clear uninstall path.
2. **Guided project setup:** discover project tools and checks while preserving existing configuration.
3. **Active-harness workflow:** let the agent already in use invoke Rivet without requiring a second model process.
4. **Project protocols:** add and discover reviewed project procedures through the CLI.
5. **First-task experience:** verify changes, present evidence for human review, and make recovery understandable.
6. **Fresh-user validation:** test the published installation and quickstart before wider rollout.

The repository is being kept focused on the reusable framework. Retired conference demos and internal implementation plans do not belong in the distributed product.

## Subsequent capabilities

- Configurable MCP integrations and verified Jira/Linear, Figma and knowledge-context workflows.
- Shared project memory with an Obsidian-compatible provider.
- GitHub, Bitbucket and GitLab delivery adapters.
- Bounded execution through more API and local model providers.
- Recovery improvements and broader evaluation coverage.

These remain planned until demonstrated. See [implementation status](./status.md) for current capability and [CI](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) for platform verification.
