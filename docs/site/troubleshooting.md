# Troubleshooting

## The public install command does not resolve

No Rivet package has been published from this repository yet. Use the source installation instructions. The temporary package name does not establish ownership of a public namespace.

## A provider is listed but cannot execute

Run `rivet models list`. `planned` means the descriptor/profile contract exists but its executor is not implemented. `adapter-available` still needs runtime/authentication checks. Profile validation does not call a model.

## Old project configuration is not recognized

Rivet uses `.rivet` and `RIVET_*`. It does not automatically read AI Engineering configuration or state. Preview a fresh configuration with `rivet init --project=<path>` and review it before writing.

## Tests cannot open a local server

The status-server tests require loopback networking. A sandbox that prohibits listeners can fail these checks independently of application behavior. Run them in an environment that permits loopback, and record that environment with the result.

## A branch is already checked out

Use `git worktree list` to locate its existing checkout. Do not delete worktrees or force-reset branches to get past this error.

## Host preflight asks for a private goal

Run `rivet preflight --project=<path> --mode=host --json` for the host workflow. The default mode includes separate orchestration goal readiness. Commit reviewed setup files and required package scripts first; the first proposal requires a clean configured default branch.

## Verification fails after the Worker submitted

Run `rivet work status <run-id> --project=<path> --json`. Its `verification` report identifies the tested commit, isolated integration checkout, changed paths, and executed checks. A failed `work verify` exits nonzero and keeps the run before final approval. If the failure is a missing dependency or other environment issue, prepare it in the isolated checkout and retry verification of the unchanged commit with the same current run and runtime versions. A source correction requires a new reviewed proposal. Rivet does not install dependencies through its quality commands.

## A host action was interrupted or blocked

For a pending action, get `runtime.version` from `work status`, then call `work next` with that version. `waiting-for-result` returns the same action. For a blocked submission, retain the `work submit` response and inspect blocked nodes in `work status`; create a new reviewed corrective proposal. `feature resume` is only for spawned runs and cannot resume host work.

If `work verify` reports a missing accepted integration identity, the private record of the reconciled Worker commit is unavailable. The run cannot be verified by treating the checkout's current HEAD as accepted; create a new reviewed proposal. If `work status` reports missing or inconsistent final approval evidence, do not deliver that checkout.

An interrupted host operation can leave a private host lock. Rivet will report that the lock needs inspection and will not remove it automatically. Inspect the run and operation state before any manual recovery; do not delete a lock merely to make a command proceed.
