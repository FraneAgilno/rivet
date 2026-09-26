# Roadmap

The next milestone is a first-task trial: a new developer installs Rivet, connects a project, and completes a small task through their coding harness or the terminal using the quickstart, without developer shell repair.

## Delivered MVP foundations

1. **Simple installation:** global and project scopes, environment diagnostics, setup preview/apply, and a clear uninstall path.
2. **Active-harness workflow:** the agent already in use can plan and execute sealed Rivet work without requiring a second model process.
3. **Project protocols:** teams can add, import, validate, publish, revise, retire, and discover reviewed project procedures through the CLI. Publication checks required content, and execution checks the selected revision and digest.
4. **First-task controls:** terminal `run`, `task status`, `task resume`, and `task deps` manage project discovery, internal run values, and approved Worker or integration dependency setup while preserving plan approval, verification evidence, and final human review.

## Next MVP priorities

1. **Validate active harness operation:** direct JSON inputs now avoid temporary files. Run a small task in both harnesses with normal approvals for private Git state and isolated worktrees, then complete fresh-user trials. The direct terminal path has passed separate local trials with both current CLIs.
2. **Measure the first-task gate:** have a fresh developer follow the quickstart and record setup time, prompts, checks, interruptions, and any shell repair. Keep versioned package publication separate from this alpha.
3. **Finish distribution decisions:** choose the license and final package namespace, then qualify a versioned release artifact.

The repository is being kept focused on the reusable framework. Retired conference demos and internal implementation plans do not belong in the distributed product.

## Subsequent capabilities

- Live qualification of the implemented MCP registry and sourced Jira/Linear, Figma and knowledge-context intake.
- Live qualification of the common GitHub, Bitbucket Cloud and GitLab.com read interface, followed by native executors for governed review/merge/deployment workflows. [Delivery preparation and the durable service](./delivery.md) are implemented; native GitHub and GitLab merge are implemented for bounded policy subsets, along with project-configured GitHub Actions deployment and Jira/Linear delivery-summary comments; Bitbucket uses manual merging for the MVP, with native automatic merging deferred to post-MVP. Live qualification remains open.
- Live qualification of bounded API/local text execution and configured Claude/Codex worker routing; broader role/model routing remains planned.
- Broader recovery and evaluation coverage. Explicit delivery lock recovery is implemented; interrupted-recovery markers and live-provider crash qualification remain open.

These remain planned until demonstrated. See [implementation status](./status.md) for current capability and [CI](https://github.com/FraneAgilno/rivet/actions/workflows/ci.yml) for platform verification.

## Post-MVP

- Shared project memory with an Obsidian-compatible provider, including synchronization and two-user continuity. It remains unimplemented and is not an MVP release requirement.

- Native automatic Bitbucket merging, after a verified conditional merge approach is available. Manual Bitbucket merging is the MVP path.
