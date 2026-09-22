# Memory and project protocols

These are separate capabilities, both under implementation.

## Shared memory

Obsidian is the first planned memory integration. Team decisions, lessons, and handoffs live in a dedicated vault outside the application repository. Records retain project scope, provenance, and sync status. A local write must not be described as shared until the selected synchronization path confirms it.

The release plan requires a real two-collaborator test. Larger-team requirements must be assessed against the selected provider's access and sharing limits. Additional providers can implement the same memory contract.

## Project-specific protocols

The intended interface includes:

```text
rivet protocols add database-changes
rivet protocols add deployment --from ./deployment-guide.md
rivet protocols find "database migration"
rivet protocols update database-changes
```

**These commands are not implemented yet.** A user will also be able to ask the active harness to draft a protocol, validate it through the CLI, and follow the project's review process before activation.

Project procedures belong in `.rivet/protocols/` as reviewable configuration. They are distinct from accumulated development history. Active runs retain the revisions they used so a later protocol edit does not silently change the agreed work.
