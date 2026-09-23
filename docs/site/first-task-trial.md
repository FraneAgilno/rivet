# First-task acceptance trial

This trial measures M1 with a developer who has not implemented Rivet. Operator-assisted model runs and automated fixtures are recorded separately and cannot close this gate.

## Before starting

Use a disposable repository with a remote, Node.js 22 or 24, npm, Git, and an authenticated interactive Claude Code or Codex session. Record the OS, harness version, Rivet commit/artifact and start time. The observer gives the participant only the [quickstart](./getting-started.md) and the task below. Do not provide private shell fixes, undocumented exports or prepared Rivet state.

## Task

> Install Rivet, connect this project, and use its workflow to add `src/greeting.js`, exporting `greet(name)` returning `Hello, <name>!`, plus a Node built-in test in `test/greeting.test.js`. Review the plan before activation and stop at verified final review.

The participant chooses the harness or terminal path. Normal authentication, committing reviewed setup files, and visible approval prompts are allowed. The participant must be able to understand them using the public docs. A permission denial is a stop condition, not permission to try another encoding or disable the sandbox.

## Record the result

- Participant identifier and prior Rivet experience (avoid personal information in public reports).
- Artifact/commit, environment and chosen entry path.
- Time to installation, setup, proposal and verified final review.
- Every question, permission prompt, failure and recovery action.
- Whether the participant needed observer intervention or manual shell repair.
- Exact changed files, reported commit, executed checks and final status.
- Whether the original checkout and remote stayed unchanged during isolated work.

Pass only when the new participant completes the task with the documented flow, reviewed approvals and genuine verification evidence, without manual shell repair. If intervention is needed, record a failed trial, fix the documented cause, and repeat with fresh state. Do not convert an assisted retry into a first-attempt pass.

The first-task gate remains open until this evidence exists. Passing one path does not automatically qualify other harnesses, desktop apps or operating systems.
