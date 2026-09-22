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
