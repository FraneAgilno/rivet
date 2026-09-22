---
name: rivet-agentic-goal
description: "Use the shared `rivet` CLI to preflight, review, activate, and observe one private goal instance. This skill is a thin o"
---

# Agentic Goal

Use the shared `rivet` CLI to preflight, review, activate, and observe one private goal instance. This skill is a thin operator entry point; the versioned protocols and runtime remain authoritative.

## Inputs

- Project path.
- Private instance ID supplied by the project controller.
- Expected state version shown with the approved proposal.
- Human activation or decision receipt supplied through the private runtime boundary.

## Run

1. Check the project before proposing or activating work:

   ```text
   rivet preflight --project <project-path>
   ```

2. Ask the configured private controller to prepare the goal proposal. Present its grounded objective, graph, budgets, authority, stop conditions, and completion profile to the human owner. Do not create or edit private state files yourself.
3. After the controller records the human approval against the exact proposal and version, activate one bounded runtime step:

   ```text
   rivet orchestrate run <instance-id> --expected-version=<version>
   ```

4. Inspect the resulting state:

   ```text
   rivet goals status <instance-id>
   ```

5. When activation is refused or a material choice is required, make a human decision handoff with the current version, choices, consequences, and evidence references. Resume only through the controller after the decision is recorded.

## Boundaries

Follow the packaged agent-orchestration and goal-graph protocols. Never write directly to the ledger, leases, graph snapshot, approval registry, or provider state. Never infer approval from conversation tone or continue past a runtime stop.
