# Memory and project protocols

These are separate capabilities. Project protocols are implemented; shared memory is post-MVP.

## Shared memory (post-MVP)

Obsidian is the first planned memory integration. Team decisions, lessons, and handoffs live in a dedicated vault outside the application repository. Records retain project scope, provenance, and sync status. A local write must not be described as shared until the selected synchronization path confirms it.

Before shared memory can be qualified, it requires a real two-collaborator test. Larger-team requirements must be assessed against the selected provider's access and sharing limits. Additional providers can implement the same memory contract.

## Project-specific protocols

Project procedures live in `.rivet/protocols/<slug>.md`. The directory is optional; existing projects keep the four tracked configuration files and gain the directory when the first protocol is created. Protocol files use YAML frontmatter with a schema version, slug, title, `draft`, `active` or `retired` status, monotonically increasing revision, UTC update time, and a SHA-256 digest over the metadata and Markdown body.

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

`add` and `import` create drafts; `add <slug> --from=<path>` is also available for importing a procedure. Drafts are excluded from `find` and `show` unless `--include-drafts` is supplied. `update` requires the current revision, increments it atomically, and changes a protocol to `active` only when `--publish` is explicit. Validation and discovery read the project directory at invocation time, so adding or revising a protocol does not require reinstalling a skill. Source imports are bounded, project-contained, regular files and are read as Markdown without running them.

Project procedures belong in `.rivet/protocols/` as reviewable configuration. They are distinct from accumulated development history. Active runs retain the revisions they used so a later protocol edit does not silently change the agreed work.

## Required protocol content

New protocol drafts include these sections:

```markdown
# Database changes

## Owner
The team or person responsible for this procedure.

## Purpose
What this procedure is intended to achieve.

## Applies when
The changes or situations that require it.

## Procedure
The steps to follow.

## Required checks and evidence
The checks to run and the results to retain.
```

Replace the descriptions with your project's reviewed requirements. Rivet reports missing or placeholder sections and prevents publication of an incomplete revision. It checks document structure; it does not decide whether a procedure is appropriate for your team or invent missing policy. If no extra checks are needed, state that explicitly.

Existing protocol records remain readable without changing their digests. An existing active record is not silently deactivated; a newly published revision must satisfy the completeness checks.

## Retire a protocol

```sh
rivet protocols retire database-changes --expected-revision=2
rivet protocols show database-changes --include-retired
```

Retirement preserves the body and creates a new revision. Retired protocols are excluded from normal discovery and new run selection. `--include-drafts` does not include retired records. Updating a retired protocol creates a draft; publishing a complete revision explicitly reactivates it.

## Protocols used by an existing run

A run retains its selected protocol IDs, revisions and digests. Rivet checks those selections before activation and execution, including protocols whose changes Git might not report. A missing, retired or changed selection requires a new reviewed proposal. Adding an unrelated protocol does not silently add it to an existing run.

Load a selected protocol from the verified source project using its captured expectations:

```sh
rivet protocols show database-changes --project=/path/to/source-project --expected-revision=2 --expected-digest=sha256:...
```

Use the complete captured digest in place of `...`. Both expectations must be supplied together. A mismatch returns an error without emitting the replacement body. The harness receives the source location and lookup guidance; the user does not need to enter these values manually. Status remains available to inspect a run that needs replanning. The supplied lookup commands use the full document output. The optional `--json` interface has a 64 KiB response limit; omit it when inspecting a larger protocol.
