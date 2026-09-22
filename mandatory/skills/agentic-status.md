# Agentic Status

Use the shared `rivet` CLI to inspect one orchestration instance and prepare a bounded decision handoff. This skill reports runtime output; it does not recreate graph, authority, redaction, or recovery rules.

## Run

1. Confirm that the project can safely resolve its private state:

   ```text
   rivet preflight --project <project-path>
   ```

2. Read the bounded graph summary:

   ```text
   rivet goals status <instance-id>
   ```

3. When event provenance is needed, request only a bounded tail:

   ```text
   rivet goals events <instance-id> --limit=<count>
   ```

4. For a local visual inspection, start the read-only view and use the localhost URL it returns:

   ```text
   rivet status <instance-id>
   ```

5. Summarize current stage, ready/running/blocked nodes, budgets, latest evidence, failed gates, and required approvals. A human decision handoff must state the exact instance and version, the decision requested, bounded options, consequences, and supporting evidence.

## Boundaries

Do not expose raw prompts, full logs, environment variables, credentials, private absolute paths, or unredacted provider payloads. Do not mutate state while preparing status. Direct recovery or changes through an approved CLI/runtime action rather than inventing a transition.
