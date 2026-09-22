---
name: rivet
description: Use Rivet's CLI-managed engineering workflow in this project.
---

# Rivet

Rivet provides a governed CLI workflow for planning, implementing, checking, and reviewing engineering work.

Use `rivet --help` to see the commands available in the installed version. Before starting governed work, run `rivet doctor --project=<path>` and `rivet preflight --project=<path>`. Feature work starts with `rivet feature propose`; activation and final delivery remain explicit human approval gates.

If `rivet` is not on `PATH`, prefix commands with `npx --yes --package=github:FraneAgilno/rivet#main rivet`. For a reproducible run, replace `main` with a reviewed commit SHA.

Harness-native workflow activation is still pending. Until it is available, run the Rivet CLI commands directly from a terminal.
