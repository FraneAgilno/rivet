# Task and checkout status

Run `rivet task status` from your project to inspect its sole active task. If several tasks are active, select one with `--run=<id>`. Status inspection preserves files and does not resume execution.

## Task states

| State | Next step |
| --- | --- |
| `proposed` | Review the proposed scope, checks and approval request. |
| `approved` | Continue through the owning harness, or use `rivet task resume` for a spawned task. |
| `running` | Inspect the current action and checkout. A spawned task must not launch another worker until the previous process is known to have stopped. |
| `blocked` | Follow the reported cause and recovery guidance. Source corrections can require a new reviewed proposal. |
| `awaiting-final-approval` | Review the accepted integration diff and recorded checks before a separate delivery decision. |

## Worker checkouts

Status reports reserved and active Worker checkouts even before an accepted integration checkout is recorded. It shows the expected branch, observed branch, checkout path and any registered location holding the expected branch. Changed paths identify unfinished work to preserve.

| Checkout observation | Meaning and remedy |
| --- | --- |
| `clean` | The observed checkout matches the reservation and has no uncommitted edits. Follow the task's next action. |
| `dirty` | The checkout has local changes. Inspect and preserve them in the reported path before continuing. |
| `missing` | The reserved checkout is missing. Inspect the recorded branch locations and task history before planning recovery. |
| `mismatched` | The checkout or branch does not match the saved reservation. Inspect the reported locations; do not force-switch, reset or delete a checkout. |
| `unavailable` | Rivet could not safely inspect the checkout. Resolve the reported access or state problem before continuing. |

An expired lease is reported separately. Status does not renew it or prove that its previous worker has stopped. Unsafe or corrupt private state prevents a trustworthy report; do not edit private JSON to bypass validation.

Worker observations are recovery information. Final delivery still requires the accepted integration commit, matching verification evidence and a clean integration checkout. See [troubleshooting](./troubleshooting.md) for dependency, interruption and verification remedies.
