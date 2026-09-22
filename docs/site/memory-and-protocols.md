# Memory and project protocols

These are separate capabilities. Project protocols are implemented; shared memory remains planned.

## Shared memory

Obsidian is the first planned memory integration. Team decisions, lessons, and handoffs live in a dedicated vault outside the application repository. Records retain project scope, provenance, and sync status. A local write must not be described as shared until the selected synchronization path confirms it.

The release plan requires a real two-collaborator test. Larger-team requirements must be assessed against the selected provider's access and sharing limits. Additional providers can implement the same memory contract.

## Project-specific protocols

Project procedures live in `.rivet/protocols/<slug>.md`. The directory is optional; existing projects keep the four tracked configuration files and gain the directory when the first protocol is created. Protocol files use YAML frontmatter with a schema version, slug, title, `draft` or `active` status, monotonically increasing revision, UTC update time, and a SHA-256 digest over the metadata and Markdown body.

The CLI supports this lifecycle:

```text
rivet protocols add database-changes
rivet protocols import deployment --from=./deployment-guide.md
rivet protocols validate [<slug>]
rivet protocols find "database migration"
rivet protocols show database-changes
rivet protocols update database-changes --from=./deployment-guide.md --expected-revision=1
rivet protocols update database-changes --from=./deployment-guide.md --expected-revision=1 --publish
```

`add` and `import` create drafts. Drafts are excluded from `find` and `show` unless `--include-drafts` is supplied. `update` requires the current revision, increments it atomically, and changes a protocol to `active` only when `--publish` is explicit. Validation and discovery read the project directory at invocation time, so adding or revising a protocol does not require reinstalling a skill. Source imports are bounded, project-contained, regular files and are read as Markdown without running them.

Project procedures belong in `.rivet/protocols/` as reviewable configuration. They are distinct from accumulated development history. Active runs retain the revisions they used so a later protocol edit does not silently change the agreed work.
