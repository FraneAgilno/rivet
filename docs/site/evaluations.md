# Evaluations and user trials

Rivet's deterministic evaluations check selected workflow mechanics. They do not demonstrate live model quality or prove that a new user can complete setup successfully.

## Run fixture evaluations

From a development checkout with dependencies installed:

```sh
npm run evals -- --mode=fixture
npm run evals -- --mode=fixture --scenario=host --json > fixture-evaluation.json
```

Available scenarios: `intake`, `host`, `repository-adapter`, `authority`, `recovery`, and `model`.

Each scenario runs exact named assertions from an existing fixture suite. The runner uses a fixed command selection, isolated temporary home, no inherited credentials, one test file at a time, and a two-minute deadline per scenario. Timeout, cancellation, missing assertions, skipped assertions, duplicate results and failed child processes fail the evaluation. Temporary fixture files are removed after collection. After a forced stop, the runner allows a 100-millisecond finalization grace, then releases its own output streams instead of waiting indefinitely for inherited pipes. A detached descendant can escape the process group; forced-stop reports therefore mark cleanup as `uncertain`. They do not confirm that every descendant has stopped. Run fixtures only from trusted source, and inspect remaining processes after an interrupted run before reusing its environment.

The host scenario exercises real disposable Git worktrees and local fixture gate execution. Its worker edits are deterministic test code. Repository and model scenarios use injected responses; they do not contact provider APIs or launch models.

## Interpret the report

JSON reports record scenario outcomes, named criterion evidence, observed test counts, duration and the checkout's Git commit. `sourceScope: current-working-tree` means local edits may be included; use a clean candidate checkout for reproducible release evidence.

A passing criterion means its named mechanics assertion passed. It is not an acceptance score for a generated feature. Acceptance coverage, actual project gate results, unsupported model claims, human interventions and retries remain `null` because this runner does not measure them. Model dispatches and model cost are zero for these fixed fixtures.

Memory continuity is reported as `not-implemented`, never as passed. Live model quality and pilot readiness are explicitly unevaluated. Scenario selection limits the report to the requested scenario; it does not qualify the remaining scenarios.

## Live evaluations remain pending

```sh
npm run evals -- --mode=live --json
```

This currently exits with a blocked result before launching anything. There is no executable profile or arbitrary command interface. A future live runner needs approved built-in harness/model profiles, an enforceable cost policy and time bounds, version capture, verification evidence, and the same small feature and bugfix exercised across supported harnesses. The current text delegation runtime cannot enforce a monetary cap; fixture success does not remove that limitation.

## A manual trial is separate evidence

Before a colleague's Monday trial, verify the documented installation command against the current candidate and record which operating system, runtime, installed harness and authentication prerequisites were used. Have the participant follow the published setup instructions and complete a small reviewable task. Record every intervention, failed command and repair; do not silently fix the environment and count the run as unassisted.

The implementation plan's pilot requires five people who did not build Rivet. At least four must reach a first valid plan within ten minutes after prerequisites and authentication. Also record total elapsed time, including authentication and setup delays. Each participant must finish a reviewable task.

Live repository-provider delivery requires separate qualification. Two-user memory continuity is a post-MVP requirement, to be evaluated after shared memory is implemented. This fixture runner, a maintainer rehearsal, and a single colleague's trial cannot close those pilot requirements.
