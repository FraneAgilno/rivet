# Conference Planner Local Demonstration Runbook

## Purpose and boundary

This 60-minute runbook demonstrates the local orchestration platform and the private Conference Planner application without claiming cloud hosting, live provider mutation, an autonomous production release, or final human approval. The presenter is responsible for naming the active mode and its provenance before showing any result.

## Modes

- **Fixture mode:** sanitized read-only Jira and Confluence packets plus the fake agent client. Provenance is `sanitized-read-only-fixtures`.
- **Checkpoint mode:** an exact clean Git commit under `refs/tags/conference-demo/*`. It does not imply that the application was rebuilt live.
- **Recording mode:** a user-supplied recording and separate copy that pass `verify-recording.mjs`. The tooling does not create the recording.
- **Live mode:** unavailable in this local release. It requires a separate approved plan and must not be selected or announced.

The selected mode must be visible in `.state/mode.json` or on the presenter slide before any evidence is discussed.

## Preflight — 15 minutes before

Responsible: presenter/operator.

1. Use clean explicit checkouts of `rivet` and the private Conference Planner repository.
2. Run:

   ```bash
   node demo/conference/scripts/prepare.mjs <rivet-root> <conference-planner-root>
   npm run check
   node --test test/demo/*.test.js
   ```

3. Confirm Bitbucket visibility is private and do not display repository credentials or settings.
4. Select fixture mode for the default demonstration:

   ```bash
   node demo/conference/scripts/fixture-mode.mjs demo/conference fixture <rivet-commit>
   ```

5. Confirm the fallback checkpoint and any recording copy before the audience window.

## Timed 60-minute sequence

| Window | Responsible | Action | Expected result |
| --- | --- | --- | --- |
| 00:00–05:00 | Presenter | State the private/local boundary and current mode provenance. | No hosted or live-provider claim. |
| 05:00–12:00 | Presenter | Show the Boss, three Manager lanes, bounded Workers, budgets, and human gate. | Graph structure is understandable. |
| 12:00–20:00 | Operator | Run the graph and scheduler tests. | Three parallel Worker lanes and integration fan-in pass. |
| 20:00–30:00 | Operator | Run the controlled fake-client correction. | One corrective retry, then exact evidence. |
| 30:00–38:00 | Presenter | Show Conference Planner agenda and conflict recovery from its verified private build. | Product behavior matches acceptance criteria. |
| 38:00–45:00 | QA owner | Explain acceptance mapping, Bitbucket Pipeline #1, and local SHA-256 evidence. | CI verification is not described as deployment. |
| 45:00–50:00 | Presenter | Show fixture/checkpoint/recording recovery choices. | Fallback provenance remains visible. |
| 50:00–55:00 | Human owner | Explain the unfulfilled final approval and hosting gate. | No receipt or deployment is fabricated. |
| 55:00–60:00 | Presenter | Questions and explicit remaining gates. | Audience leaves with truthful capability boundaries. |

## Decision points

- If any local verification command fails, stop the live path and use checkpoint mode.
- If repository or Pipeline access fails, retain the last checksum-verified local evidence and state that the remote cannot currently be reverified.
- If checkpoint mode is not ready within 30 seconds, switch to verified recording mode when one exists; otherwise stop the demonstration rather than improvise a claim.
- Never open cloud consoles, provider mutation controls, environment values, or raw traces during the presentation.

## Close

Stop local servers, retain only approved local evidence, and record which mode and commits were shown. Do not merge, publish, deploy, or finalize the human gate as part of this runbook.

