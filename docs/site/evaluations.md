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

## Opt-in live evaluations

Live mode is separate from CI's deterministic fixtures. It can call an installed, authenticated Claude/Codex CLI or a configured API/local text model, after interactive approval. It does not create external repositories, push branches or deliver changes.

Use the same fixed `feature` and `bugfix` scenarios with either harness:

```sh
npm run evals -- --mode=live --scenario=feature --profile=codex --account-policy=approved-team-trial --json > codex-feature.json
npm run evals -- --mode=live --scenario=bugfix --profile=claude --account-policy=approved-team-trial --json > claude-bugfix.json
```

The account-policy label records the spending/account policy you have actually approved. It does not configure or enforce an account spending limit. Review the concrete task, model choices, destination, time/call limits, cost assurance and retained workspace before approving. There is no unattended approval flag. Standard input and error must remain connected to an interactive terminal; JSON goes to standard output, so it can be redirected to a report file.

Harness attempts create disposable local Git repositories and use the ordinary proposal, approval, isolated Worker, integration and verification path. They run real project build/test gates, then additional fixed acceptance checks against the accepted implementation. Those extra checks are kept outside Worker-owned paths, but are not a security boundary against a deliberately searching harness. The report records the actual outcomes and whether source/local-remote state was preserved. Retained workspaces are identified in the report for inspection.

Claude's initial built-in profile uses `sonnet` for planning and execution. Codex planning uses its configured harness default; Worker execution can use `--worker-model=<id>` when explicitly selected. Unsupported model overrides stop rather than silently changing the request. Requested and observed model identity are separate; an unavailable observed identity remains null. Installed harness capabilities and versions are checked, without a fixed version allowlist.

### API and local text review

The separate `text-review` scenario asks a text model to identify seeded defects. Its automatic rubric checks finding IDs, locations and response structure; it does not grade semantic correctness or demonstrate implementation execution. Bounded findings and a redacted response excerpt are retained as untrusted model output for human review. Supported profiles are `anthropic`, `openai`, `gemini`, `ollama` and `openai-compatible`.

```sh
npm run evals -- --mode=live --scenario=text-review --profile=ollama --model=<installed-model> --cost-policy=local-compute --account-policy=approved-local-trial --json > local-review.json
npm run evals -- --mode=live --scenario=text-review --profile=openai --model=<available-model> --credential-env=RIVET_EVAL_API_KEY --account-policy=approved-team-trial --json > api-review.json
```

Credentials come from the named local environment variable, never a command-line value. `--endpoint` is available for supported explicit endpoints. Scenario/profile combinations and settings are validated; arbitrary commands, modules, fixture paths and profile files are not accepted.

### Limits, costs and evidence

`--timeout-ms` sets one shared deadline covering the initial approval wait, activation approval and attempt. Unanswered prompts close on timeout or cancellation, and a late approval cannot start another dispatch. Text profiles also accept `--max-output-tokens`. Attempts use fixed call/Worker limits and no automatic retries; cancellation prevents further dispatch. The concrete limits are displayed before approval and recorded in the report.

Cost fields distinguish:

- **Enforced execution limits:** local time, call and output bounds, plus supported provider token bounds.
- **Provider-advertised budgets:** Claude's existing per-call planning/Worker budget options, without claiming independently verified final billing.
- **Account admission:** the explicitly approved policy under which the call is allowed. An optional `--estimated-cost-usd` is an estimate, never an enforced limit.
- **Observed usage:** provider response usage is distinguished from Worker self-reports. Actual billed cost remains null when not independently observed.

These profiles do not provide a universal hard dollar cap. Requests requiring one are rejected when the profile cannot enforce it. Local-compute admission does not invent a dollar estimate or claim electricity/compute is free. The report must not turn model-reported zero cost into proof of zero billing.

Reports identify source/fixture/profile, observed harness version, timing, dispatch/retry counts, acceptance and gate evidence, and supported usage provenance. Source identity is observed at the start and explicitly scoped to the current working tree; a dirty checkout is not an exact-commit execution claim. The source commit, profile and fixture are rechecked across initial approval. An injected-client rehearsal tests the runner mechanics; it is labeled separately from a live attempt. Neither is an independent fresh-user pilot, and successful execution does not prove zero human intervention.

## A manual trial is separate evidence

Before a colleague's Monday trial, verify the documented installation command against the current candidate and record which operating system, runtime, installed harness and authentication prerequisites were used. Have the participant follow the published setup instructions and complete a small reviewable task. Record every intervention, failed command and repair; do not silently fix the environment and count the run as unassisted.

The implementation plan's pilot requires five people who did not build Rivet. At least four must reach a first valid plan within ten minutes after prerequisites and authentication. Also record total elapsed time, including authentication and setup delays. Each participant must finish a reviewable task.

Live repository-provider delivery requires separate qualification. Two-user memory continuity is a post-MVP requirement, to be evaluated after shared memory is implemented. This fixture runner, a maintainer rehearsal, and a single colleague's trial cannot close those pilot requirements.
