# Conference Demo Checkpoints

## Contract

Checkpoints are lightweight Git refs under `refs/tags/conference-demo/`. Allowed names are `baseline`, `corrected`, and `verified`. Creation requires an exact clean repository and expected 40-character commit.

The checkpoint tool uses an atomic `git update-ref` comparison and is idempotent when the named ref already resolves to the exact commit. It refuses a conflicting ref, dirty tracked content, a mismatched commit, an unsafe name, or a symlinked repository root.

It does not run `git reset --hard`, change branches, remove worktrees, alter remotes, or copy application content.

## Create

```bash
node demo/conference/scripts/checkpoint.mjs <repository-root> baseline <exact-head>
node demo/conference/scripts/checkpoint.mjs <repository-root> corrected <exact-head>
node demo/conference/scripts/checkpoint.mjs <repository-root> verified <exact-head>
```

## Reset boundary

Reset verifies that the checkout still equals the selected checkpoint and archives only `demo/conference/.state` to `demo/conference/.state-archive/<checkpoint>`. It accepts only `mode.json`, `instance.json`, and `events.jsonl`, requires the exact confirmation phrase, and preserves the archive for recovery.

```bash
node demo/conference/scripts/reset.mjs <repository-root> baseline <exact-head> 'RESET conference demo baseline'
```

Application source restoration is intentionally outside this tool. Use a new clean checkout of the named commit rather than destructively rewriting an existing checkout.

