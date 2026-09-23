# Roadmap

The next milestone is a first-task trial: a new developer installs Rivet, connects a project, and completes a small task through their coding harness or the terminal using the quickstart, without developer shell repair.

## Delivered MVP foundations

1. **Simple installation:** global and project scopes, environment diagnostics, setup preview/apply, and a clear uninstall path.
2. **Active-harness workflow:** the agent already in use can plan and execute sealed Rivet work without requiring a second model process.
3. **Project protocols:** teams can add, import, validate, publish, revise, and discover reviewed project procedures through the CLI.
4. **First-task controls:** terminal `run`, `task status`, `task resume`, and `task deps` manage project discovery, internal run values, and approved Worker or integration dependency setup while preserving plan approval, verification evidence, and final human review.

## Next MVP priorities

1. **Unblock active harness inputs:** replace the skill's `.git/rivet-inputs/` file location with one writable under the default Claude and Codex project sandboxes while keeping the Git baseline clean. Then run a small task in both harnesses. The direct terminal path has passed separate local trials with both current CLIs.
2. **Measure the first-task gate:** have a fresh developer follow the quickstart and record setup time, prompts, checks, interruptions, and any shell repair. Keep versioned package publication separate from this alpha.
3. **Finish distribution decisions:** choose the license and final package namespace, then qualify a versioned release artifact.

The repository is being kept focused on the reusable framework. Retired conference demos and internal implementation plans do not belong in the distributed product.

## Subsequent capabilities

- Configurable MCP integrations and verified Jira/Linear, Figma and knowledge-context workflows.
- Shared project memory with an Obsidian-compatible provider.
- GitHub, Bitbucket and GitLab delivery adapters.
- Bounded execution through more API and local model providers.
- Recovery improvements and broader evaluation coverage.

These remain planned until demonstrated. See [implementation status](./status.md) for current capability and [CI](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) for platform verification.
