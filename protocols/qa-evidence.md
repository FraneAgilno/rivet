# QA Evidence Protocol

Protocol version: 1

Completion is a traceable evidence decision, not a narrative claim.

## Authority

The Quality Manager configures and reviews the required test and evidence map within the approved completion profile. Workers may produce evidence but cannot approve their own results. A human retains final approval for visual baselines, manual-review exceptions, release delivery, and durable publication.

## State transitions

Quality work follows `declared -> executed -> collected -> validated -> reviewed -> approved -> published`. A failed deterministic gate creates a failed record and corrective work. An evidence bundle is draft until all referenced files are bounded, checksummed, and validated. Publication is durable only when an approved remote location and checksum are recorded.

## Stop conditions

Stop when an acceptance criterion has no test or approved manual review, a command differs from its configured executable and argument array, provenance is missing, an artifact changed after hashing, a test is skipped without authorization, a visual environment is not controlled, or required independent and human reviews are absent.

## Evidence

For each gate capture command provenance, start and end time, working directory, commit SHA, exit status, sanitized output summary, artifact paths, and SHA-256 checksums. Journey evidence also records route, persona, browser, viewport, data mode, and design version. The final manifest maps each in-scope acceptance criterion to a passed deterministic test or an approved manual item.

## Recovery

Preserve the failed run and its checksums. Correct the cause in a new bounded node, rerun affected gates, and produce a new evidence revision. Never edit a failed result into a pass or reuse artifacts from a different commit.

## Client adapter boundaries

CI, browser, storage, and provider adapters return bounded versioned metadata. They cannot declare a gate passed, approve a manual exception, or claim publication without independently verifiable identity and checksums. Logs and screenshots are redacted before entering prompts, events, or bundles.
