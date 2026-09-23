---
name: rivet
description: Use Rivet's CLI-managed engineering workflow in this project.
---

# Rivet

Rivet provides a governed CLI workflow for planning, implementing, checking, and reviewing engineering work. The current coding harness performs the work; Rivet does not launch a second model in host mode.

When a user asks to use Rivet on a task, accept the task in ordinary language. Do not ask the user for `$PWD`, a run ID, a run version, a digest, or JSON file paths. Determine the configured Git project root yourself and carry the exact values returned by Rivet between commands. Present the full plan before activation and the verified evidence before final delivery. A person working directly in a terminal can instead run `rivet run "task"`, then `rivet task status` or `rivet task resume` from anywhere inside the configured project.

Use `rivet --help` to see the installed commands. Review and commit setup files and required scripts before proposing work; the configured default branch must be clean. Before host-mode work, run `rivet preflight --project=<path> --mode=host`. Use `rivet doctor --project=<path>` for broader diagnostics, including configured providers; the default preflight remains for orchestration work. Use `rivet protocols find <query> --project=<path>` to discover active project procedures and load only relevant protocols with `rivet protocols show`.

For host execution, inspect the request and repository, then write one strict `agilno.feature-decomposition` JSON file beneath `.git/rivet-inputs/`. Run `rivet work propose` with that file and the request source. Present the returned plan for human activation; bind `rivet feature start` to its exact run version and proposal digest. Then call `rivet work prepare`, followed by `rivet work next`. Execute the returned `agilno.agent-launch` contract yourself in its exact worktree and scope. Save the returned action and matching result-contract JSON beneath `.git/rivet-inputs/`, submit them with `rivet work submit`, and repeat `work next` until ready to run `rivet work verify`. Read `rivet work status` for the integration checkout, changed paths, worker claims, executed checks, and next action. Never treat verification as final approval.

An interrupted pending action is recovered by reading `work status` for the current runtime version and calling `work next` with that version; it returns the same action as `waiting-for-result`. `feature resume` is not a host-mode command. A blocked submission needs a new reviewed corrective proposal. A failed check leaves a report and nonzero result. When a clean active Worker checkout needs locked dependencies, ask the user to run `rivet task deps` and approve the exact frozen install before editing. For a failed verification check caused by missing dependencies, the same command prepares the clean accepted integration checkout; then retry verification at the unchanged commit. Source corrections require a new reviewed proposal. Rivet's sealed quality commands do not authorize package installation, and setup does not install dependencies.

If the accepted integration identity or final approval evidence is missing, do not verify or deliver that checkout; create a new reviewed proposal when the private record cannot be restored. If a host operation lock remains after an interruption, inspect the run before manual recovery. Do not remove it only to make a command proceed.

Active protocol IDs, revisions, and digests are captured in the run and action context. If the current protocol digest differs, stop and ask for the run to be replanned rather than silently using the changed procedure.

If `rivet` is not on `PATH`, prefix commands with `npx --yes --package=github:FraneAgilno/rivet#main rivet`. For a reproducible run, replace `main` with a reviewed commit SHA.

Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and other capable harnesses can use the same host-mode CLI contract. Direct spawned adapters remain available for supported clients.
