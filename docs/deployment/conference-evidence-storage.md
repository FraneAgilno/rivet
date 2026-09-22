# Conference Planner Evidence Storage

## Local evidence contract

The Conference Planner produces local evidence from authenticated unit and browser reports. The evidence directory contains a canonical manifest and `manifest.sha256`; SHA-256 binds the exact manifest bytes to the tested application commit.

An operator verifies a local bundle by:

1. checking out the exact private Bitbucket commit;
2. installing from the committed lockfile;
3. running the complete application verification and evidence commands;
4. recomputing SHA-256 for the manifest;
5. comparing it with `manifest.sha256` before copying or inspecting the bundle.

Local evidence is not durable cloud storage. A successful Pipeline run may prove that CI executed, but its logs or temporary artifacts do not establish an approved long-term retention policy.

The 2026-08-27 local verification of merged commit `f700ddc08790c2d01ceb17bfb82f77658bcdd234` produced manifest SHA-256 `0aa0c83c6d129d531c0b77dfe7eafadb09a899eb3d88c9975ca80c2970f8892`. This records the tested local bundle identity only; the bundle remains outside Git and has no durable-retention claim.

## Handling rules

- Evidence stores repository-relative paths only.
- Raw cookies, authorization headers, session secrets, credentials, and environment values are excluded.
- Browser traces and screenshots are retained only when their secret scan and bounded-media checks pass.
- Copies retain the manifest and checksum together.
- A copy is not called verified after either file changes.

## Retention

Until durable storage is approved, the owner chooses and records a local retention location, duration, access list, and deletion date outside Git. A second local copy may be used for rehearsal resilience, but it must be checksum-verified and must not be described as independent cloud backup.

Future durable retention requires an approved private target, least-privilege write identity, encryption and access policy, retention/deletion policy, exact archive checksum metadata, and a successful download-and-reverify exercise.
