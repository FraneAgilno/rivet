# Roadmap

The next milestone is a first-task trial: a new developer installs Rivet, connects a project, and completes a small task through their coding harness or the terminal using the quickstart, without developer shell repair.

## Delivered MVP foundations

1. **Simple installation:** global and project scopes, environment diagnostics, setup preview/apply, and a clear uninstall path.
2. **Active-harness workflow:** the agent already in use can plan and execute sealed Rivet work without requiring a second model process.
3. **Project protocols:** teams can add, import, validate, publish, revise, and discover reviewed project procedures through the CLI.
4. **First-task controls:** terminal `run`, `task status`, `task resume`, and `task deps` manage project discovery, internal run values, and approved Worker or integration dependency setup while preserving plan approval, verification evidence, and final human review.

## Next MVP priorities

1. **Validate active harness operation:** direct JSON inputs now avoid temporary files. Run a small task in both harnesses with normal approvals for private Git state and isolated worktrees, then complete fresh-user trials. The direct terminal path has passed separate local trials with both current CLIs.
2. **Measure the first-task gate:** have a fresh developer follow the quickstart and record setup time, prompts, checks, interruptions, and any shell repair. Keep versioned package publication separate from this alpha.
3. **Finish distribution decisions:** choose the license and final package namespace, then qualify a versioned release artifact.

The repository is being kept focused on the reusable framework. Retired conference demos and internal implementation plans do not belong in the distributed product.

## Subsequent capabilities

- Live qualification of the implemented MCP registry and sourced Jira/Linear, Figma and knowledge-context intake.
- Live qualification of the common GitHub, Bitbucket Cloud and GitLab.com read interface, followed by native executors for governed review/merge/deployment workflows. [Delivery preparation and the durable service](./delivery.md) are implemented; native GitHub merge is implemented for a bounded classic protection policy; remaining provider operations and live qualification remain open.
- Bounded execution through more API and local model providers.
- Recovery improvements and broader evaluation coverage.
- Shared project memory with an Obsidian-compatible provider, deferred to the final implementation lane.

These remain planned until demonstrated. See [implementation status](./status.md) for current capability and [CI](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) for platform verification.
