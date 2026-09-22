# Conference Planner Speaker Notes

## Opening

“This is a private, local demonstration. The application verification ran in Bitbucket Pipelines, while the orchestration run shown here uses sanitized fixtures and a deterministic fake client. It is simulated evidence, not proof of a live autonomous delivery or deployment.”

## Graph explanation

- The Boss owns the bounded release goal and cannot self-approve final delivery.
- Product, delivery, and quality Managers own separate lanes.
- UI, API, and browser work can be ready in parallel.
- Integration waits for all three lanes.
- The controlled focus-restoration failure consumes one retry and remains bounded.
- Evidence assembly precedes the human final-delivery gate.

## Product explanation

The Conference Planner uses an original local design contract. The acceptance story is agenda persistence, conflict discovery, explicit replacement, keyboard operation, and fail-closed API behavior.

## Evidence explanation

Pipeline #1 was observed to pass before the owner-reported merge. The local manifest checksum binds exact evidence bytes. Neither fact is a hosted-deployment claim or a substitute for durable retention.

## Required phrases during fallback

- “I am switching to fixture mode; these are sanitized read-only packets.”
- “I am switching to checkpoint mode; this state was prepared at the commit shown.”
- “I am switching to recording mode; the recording and backup were checksum-verified.”
- “That external system is unavailable, so I cannot verify its current state.”

## Closing

The remaining owner decisions are hosting, durable evidence retention, the verified recording, human final approval, v2 integration, and publication.

