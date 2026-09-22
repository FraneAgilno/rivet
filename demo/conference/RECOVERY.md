# Conference Demo Recovery

## Thirty-second rule

If a failure cannot be explained and switched to a prepared truthful fallback within 30 seconds, stop that segment. Never turn an unavailable integration into an unverified live claim.

| Failure | Immediate response | Fallback provenance |
| --- | --- | --- |
| Bitbucket Pipelines or repository unavailable | State that current remote status cannot be verified. | Last checksum-verified local evidence and exact recorded commit. |
| Jira or Confluence provider unavailable | Select fixture mode. | Sanitized read-only provider packets. |
| Model client unavailable | Use the deterministic fake-client corrective run. | `corrective-run.json`, visibly marked simulated. |
| Hosting unavailable | Continue locally and state that hosting is deferred. | Loopback application or verified build output; no hosted URL. |
| Local design contract missing | Stop the product-state segment or use the verified checkpoint. | Original checked-in design manifest at the named commit. |
| Local checkout dirty | Do not create a checkpoint or run reset. | Fresh clean checkout. |
| Browser journey fails | Show the failing gate, then switch to a verified checkpoint or recording. | Named checkpoint or matching recording checksum. |

## Fixture recovery

Run the fixture selector with the exact platform commit and show `.state/mode.json`. Fixtures are read-only and cannot prove current remote state.

## Checkpoint recovery

Verify the checkpoint ref and use a fresh checkout. The reset tool only archives local demo state and never changes application source.

## Recording recovery

Use recording mode only after the primary and separate copy have matching SHA-256 values from `verify-recording.mjs`. If either copy is missing or differs, recording mode is unavailable.

## After the session

Record the failure, selected mode, commits, and evidence checksum without secrets. Do not repair external systems or mutate provider data from the presentation workflow.

