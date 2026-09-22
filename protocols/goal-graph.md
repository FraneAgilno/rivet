# Goal Graph Protocol

Protocol version: 1

The goal graph is the dependency and accountability record for one approved outcome. It must remain deterministic, bounded, and inspectable.

## Authority

The human owner approves the goal, activation envelope, budgets, and completion profile. The Boss may propose the graph and its workstreams. Managers may propose bounded children beneath their assigned node. Workers cannot alter topology, parentage, approval gates, or completion criteria. Only the runtime applies graph mutations that match actor authority and the expected state version.

## State transitions

The graph and every node follow the reducer's complete transition table:

- `proposed` -> `approved`, `blocked`, `cancelled`
- `approved` -> `ready`, `blocked`, `cancelled`
- `ready` -> `reserved`, `blocked`, `cancelled`
- `reserved` -> `ready`, `running`, `blocked`, `cancelled`
- `running` -> `verifying`, `corrective`, `blocked`, `failed`, `cancelled`
- `verifying` -> `completed`, `corrective`, `blocked`, `failed`, `cancelled`
- `corrective` -> `ready`, `reserved`, `running`, `verifying`, `blocked`, `failed`, `cancelled`
- `blocked` -> `ready`, `corrective`, `failed`, `cancelled`
- `failed` -> `corrective`, `archived`
- `completed` -> `archived`
- `archived` -> none
- `cancelled` -> `archived`

Approval evidence authorizes only the corresponding allowed transition. A node may be persisted as `ready` or `corrective` in canonical fixtures and durable runtime state before its dependencies finish; the state name alone is not permission to launch. A `ready` or `corrective` node becomes schedulable only when every declared dependency is `completed`. Completion requires its declared evidence. Fan-in waits for every required predecessor. Corrective nodes reference the failed source node and carry new bounded ownership rather than erasing the failure.

## Stop conditions

Reject or stop a graph with cycles, unknown dependencies, duplicate or ambiguous IDs, invalid parentage, excessive delegation depth, overlapping ownership, missing approval gates, unbounded commands, impossible budgets, or completion criteria without evidence. Activation is bound to the exact instance resource, structural authority decision, single-use human approval receipt, and expected state version. Stop when any binding is absent, stale, or does not match.

## Evidence

Each node declares evidence types before execution. Evidence references must resolve to immutable or checksummed records and must remain traceable to the graph, node, actor, command, and commit. Acceptance criteria map to deterministic passed tests or an explicit human-approved manual review item.

## Recovery

Replay the append-only event history to reconstruct state. Reject gaps, reordered events, malformed transitions, or snapshots that do not match the ledger. Retry only within the configured attempt budget. Create corrective work for reproducible failures. Escalate irreconcilable topology or ownership conflicts to the human owner.

## Client adapter boundaries

Clients receive a graph-derived sealed launch contract, never the unrestricted graph store. They may report events and evidence through the runtime contract but cannot write snapshot files, edit leases, select a different parent, or mark nodes complete directly.
