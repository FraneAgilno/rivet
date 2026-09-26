# Source provenance

Rivet is developed by Agilno. Its initial reviewed source snapshot is recorded by commit `af5753b4f9fe10e2a08cbe6e17c19e1ea6681704`.

The public root is `1fe4c62365168541732cdd93b423519a08924b12`. It contains synthetic examples and excludes earlier local history. Private registry settings, client material and local authentication configuration are not part of Rivet's distribution.

Conference applications, presenter scripts, rehearsal assets, historical deployment and incident notes, and internal implementation plans have been retired from the current repository. Small synthetic fixtures remain under `test/fixtures` where they verify the framework itself. Product documentation lives under `docs/site`.

Agilno source attribution is retained. The package remains `UNLICENSED` and npm publication is disabled until the owners choose a license and package namespace. Public source hosting is not a completed product release.

## Historical baseline evidence

The public root retains the original import inventory and baseline report in Git history. Inspect them without restoring retired files into the current checkout:

```sh
git show 1fe4c62365168541732cdd93b423519a08924b12:docs/maintainers/source-import.json
git show 1fe4c62365168541732cdd93b423519a08924b12:docs/maintainers/baseline.md
```

The inventory records source paths and SHA-256 hashes before adaptation, plus exclusions. Those hashes do not describe current Rivet files. The historical report records 1,707 passing tests, 19 failures and one skip before adaptation; it attributes the failures to date-sensitive lease fixtures. It records 1,267 passing tests, zero failures and one skip for the foundation, plus successful local documentation and package smoke checks. These are retained reports, not new executions or proof of today's compatibility. The report does not retain raw logs for every baseline command, so it cannot establish an independently reproducible historical `npm ci` or package inventory result.

## Import recovery and independent maintenance

Use a new clone of the Rivet repository to inspect a historical revision. Confirm its root with `git rev-list --max-parents=0 HEAD`; the public root above has tree `3de810a70fbff3dbdc42d8f10fa483be964eb7b8`. A missing object in a shallow clone requires fetching the relevant history before comparison. Do not treat another repository's history or a local branch name as proof of provenance.

For a faulty import or later migration, preserve the current checkout, configuration, private task state and worktrees. Compare the affected paths with the reviewed historical revision in the separate clone, then submit a bounded corrective commit through ordinary review and CI. Avoid resetting the user's checkout, rewriting published history or restoring the complete initial snapshot: it contains assets deliberately retired from current distribution. Reverting a source change does not prove that an older runtime can read newer task state.

Rivet maintainers own subsequent fixes, dependency updates and release decisions in this repository. No changes to an originating repository are required. Installed-release recovery follows the [release rollback procedure](./site/release.md#rollback), including state compatibility checks and preservation of user work.
