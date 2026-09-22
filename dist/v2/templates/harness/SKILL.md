---
name: rivet
description: Use Rivet's CLI-managed engineering workflow in this project.
---

# Rivet

Rivet provides a governed CLI workflow for planning, implementing, checking, and reviewing engineering work. The current coding harness performs the work; Rivet does not launch a second model in host mode.

Use `rivet --help` to see the installed commands. Before governed work, run `rivet doctor --project=<path>` and `rivet preflight --project=<path>`. Use `rivet protocols find <query> --project=<path>` to discover active project procedures and load only relevant protocols with `rivet protocols show`.

For host execution, inspect the request and repository, then write one strict `agilno.feature-decomposition` JSON file beneath `.git/rivet-inputs/`. Run `rivet work propose` with that file and the request source. Present the returned plan for human activation; bind `rivet feature start` to its exact run version and proposal digest. Then call `rivet work prepare`, followed by `rivet work next`. Execute the returned `agilno.agent-launch` contract yourself in its exact worktree and scope. Save the returned action and matching result-contract JSON beneath `.git/rivet-inputs/`, submit them with `rivet work submit`, and repeat `work next` until ready to run `rivet work verify`. Never treat verification as final approval.

Active protocol IDs, revisions, and digests are captured in the run and action context. If the current protocol digest differs, stop and ask for the run to be replanned rather than silently using the changed procedure.

If `rivet` is not on `PATH`, prefix commands with `npx --yes --package=github:FraneAgilno/rivet#main rivet`. For a reproducible run, replace `main` with a reviewed commit SHA.

Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and other capable harnesses can use the same host-mode CLI contract. Direct spawned adapters remain available for supported clients.
