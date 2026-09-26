---
name: rivet-agentic-status
description: "Use the shared `rivet` CLI to inspect a task and prepare a bounded decision handoff. This thin operator entry point repo"
---

# Agentic Status

Use the shared `rivet` CLI to inspect a task and prepare a bounded decision handoff. This thin operator entry point reports service output; it does not recreate graph, authority, redaction or recovery rules.

## Start with the project task

Determine the configured Git project yourself. From inside it, run:

```text
rivet task status
```

Use `--project=<absolute-project>` when operating elsewhere. Do not ask the user for `$PWD`, private paths or a run ID before discovery. The command selects the sole active task, not the latest task. Carry the selected ID from its `Run:` line into later agent commands; the user does not need to supply it. If multiple tasks exist, show the listed choices and obtain a selection with `--run=<id>`; never guess. Completed runs may require an explicit known run selector. `task status` is human-readable and does not accept `--json`.

Read status even when readiness checks fail; inspecting a blocked or dirty checkout must not depend on passing preflight. Use `rivet doctor` or `rivet preflight --mode=host` separately when investigating a reported readiness blocker. Neither grants tool permission or certifies all sandbox access.

Report the task state, owning harness, checkout identity, changed paths, executed checks, evidence and returned next action. Distinguish Worker claims from verified results. Expose only bounded relevant output, not raw prompts, credentials, environment variables, unredacted provider payloads or unnecessary private absolute paths.

## Resume only when requested

A status request is read-only. With a separate request or existing authorization to continue, use:

```text
rivet task resume
```

The same project and optional `--run=<id>` selection apply. For a host task this reports how to continue in the owning coding harness; it does not launch a second worker. For a spawned task it restores the saved harness selection and resumes only an eligible approved/blocked run. It refuses to restart an already-running spawned worker whose termination is unproven. Do not change models to work around missing credentials or tool compatibility.

For the owning host agent, use the `Run:` line from task status or host resume, then read the exact run/runtime versions and outstanding action:

```text
rivet work status <run-id> --project=<absolute-project> --json
```

Follow the returned `nextAction`. An approved run with `runtime: null` must be prepared before asking for an action:

```text
rivet work prepare <run-id> --project=<absolute-project> --expected-version=<current-run-version> --json
```

Once a runtime exists and the returned next action permits continuation, use its current runtime version:

```text
rivet work next <run-id> --project=<absolute-project> --expected-runtime-version=<current-runtime-version> --json
```

`work next` may reserve a new action and is a continuation step, not a read-only status call. After an interruption it returns the existing action as `waiting-for-result`. Preserve the action and its scope, inspect the reserved checkout, then continue and submit through `work submit` as specified by the feature workflow. Do not use `feature resume` for host tasks. Blocked submissions or source corrections need a new reviewed corrective proposal; dependency-only verification failures may use separately approved `rivet task deps` before retrying at the unchanged accepted commit.

## Locks and uncertain outcomes

Inspect first. Explicitly requested recovery of an abandoned host lock uses `rivet task recover` (or `rivet work recover <run-id> --project=<absolute-project> --json` for agents). It recovers only eligible stale locks owned by a provably dead local process. It does not reset statuses, remove edits, launch workers or approve work. Respect partial-recovery reports and blocked locks; no force option or manual state/lock deletion is permitted.

Use `rivet delivery status` for delivery receipts and pending external operations. A separate request to resolve an uncertain provider outcome uses `rivet delivery reconcile`, which reads provider state without resending the write. Implementation completion and tracker/review creation receipts are not merge or deployment approvals.

## Advanced orchestration instances

Only when the user is already working with an explicitly configured orchestration instance, preserve its existing controller interface:

```text
rivet goals status <instance-id> --json
rivet goals events <instance-id> --limit=100 --json
rivet status <instance-id>
```

These commands require the corresponding configured private runtime/controller; the local `rivet status` view is for that instance, not automatic task discovery. Do not substitute an instance ID for a feature run ID or start orchestration to inspect a normal task. Follow the configured controller for version-bound recovery or mutations.

## Decision handoff

State the exact task or instance, current version, failed gate, requested decision, bounded options, consequences and evidence references. Keep tool permissions, activation, dependency installation and final delivery as separate approvals. When a tool denies access, report the exact operation and use its normal approval flow. Do not evade the denial or infer approval from conversation tone.
