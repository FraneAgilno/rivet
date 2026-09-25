# Integrations

Rivet distinguishes configured providers from observed access. Inspect the project's existing `.rivet/providers.yaml` configuration with:

```sh
rivet integrations list
rivet integrations check
```

Both commands report readiness and remedies. They do not call providers or prove authentication. Direct API entries report credential presence; MCP entries require an explicit host inventory; local CLI entries are descriptors only and cannot execute yet. An unavailable optional MCP integration does not block an unrelated local task.

## Harness-connected tools

The active harness discovers tools through its own supported connector interface. It supplies only the configured project, provider IDs, authentication observations and tool names, never credentials or private application databases. For example:

```sh
rivet integrations check --host-inventory-json='{"projectId":"demo","providers":[{"id":"team-jira","authenticated":true,"tools":["get_issue"]}]}' --json
```

`host-observed` means the harness reported access. It is not independent provider verification or live qualification. Refresh the inventory in each session.

Add portable metadata to a reviewed provider entry in `.rivet/providers.yaml`:

```yaml
- id: team-jira
  kind: jira
  mode: read-only
  transport: harness-mcp
  capabilities: [issues-read]
  projectIds: [demo]
  tools: [get_issue]
  endpoint: https://example.atlassian.net
  resourceIds: [DEMO-1]
```

Use the actual project ID, connected tool name and source origin. `projectIds` and `resourceIds` restrict scope when supplied. Legacy entries default to `direct-api`; existing direct Jira/Linear reads remain available. Keep credentials as environment references for direct transports. Multiple matching providers require an explicit selection.

## Sourced work requests

The harness may call `rivet work propose --host-context-json=<bundle> --decomposition-json=<plan> --project=<root>`. This replaces the request/ticket selector. Each argument is limited to 64 KiB of UTF-8. Use an argument array or proper shell quoting and normal permission approvals.

The bundle has this shape:

```json
{
  "schemaVersion": 1,
  "projectId": "demo",
  "host": {
    "projectId": "demo",
    "providers": [{"id": "team-jira", "authenticated": true, "tools": ["get_issue"]}]
  },
  "request": {"providerId": "team-jira", "resourceId": "DEMO-1"},
  "observations": [{
    "schemaVersion": 1,
    "providerId": "team-jira",
    "projectId": "demo",
    "tool": "get_issue",
    "resourceId": "DEMO-1",
    "sourceUrl": "https://example.atlassian.net/browse/DEMO-1",
    "revision": "1",
    "capturedAt": "2026-09-23T12:00:00.000Z",
    "content": {
      "title": "Add a greeting",
      "description": "Export a greeting function.",
      "acceptanceCriteria": ["greet(name) returns Hello, <name>!."]
    }
  }],
  "userAcceptanceCriteria": []
}
```

Do not copy sample content as a retrieved ticket. Capture the actual source first. Jira/Linear form the primary request and require `issues-read`. The request selector also accepts a matching Jira `/browse/ID` or Linear `/workspace/issue/ID/title` HTTPS URL. Specify a provider for the correct workspace and source origin.

Up to 16 observations can accompany a request. Additional Figma (`files-read`), Confluence (`pages-read`) or generic (`context-read`) observations use `content: {"title": "...", "text": "..."}`. Keep only relevant text. Figma resource IDs identify the file in a `/file/`, `/design/`, `/board/` or `/proto/` URL; `node-id` can identify the selected node in the URL. Confluence page IDs must match a `/pages/<id>` path or `pageId` query. Source origins must match the provider endpoint when configured. Arbitrary query parameters and fragments are rejected.

Rivet computes content digests and retains source identity, revision, capture time, transport and `harness-observed` assurance in the request. Its digest binds the snapshots and any user-added criteria. Missing criteria must be supplied by the user in `userAcceptanceCriteria`; they remain distinguishable from the source. Re-capture changed sources and create a new reviewed proposal. Rivet cannot independently refresh a desktop harness's MCP snapshot; recorded revisions do not prove that the remote content remains current.

External text is inert context. It cannot change commands, owned paths, budgets or approval rules. It is not delivery evidence. Inspect persisted context with `rivet work status`; actual repository checks still determine verification.

## Repository providers

Use [repository inspection](./repositories.md) to read GitHub, Bitbucket Cloud and GitLab.com repository and review state through a shared interface. Its capability matrix distinguishes implemented reads from the planned delivery lifecycle and pending live qualification.

## Qualification status

| Provider | Implemented intake | Live qualification |
| --- | --- | --- |
| Jira / Linear | Existing direct read adapters and normalized host snapshots | Pending authorized test resources |
| Figma / Confluence | Existing adapter modules and bounded linked host context | Pending authorized test resources |
| Custom MCP | Configurable descriptors, tool inventory and generic context snapshots | Per-server qualification required |
| Notion / Playwright / Sentry | Optional capability descriptions only | Not qualified |
| Local CLI transports | Registry descriptors only | Execution not implemented |
| Shared Obsidian memory | Planned, deferred to the final implementation lane | Not qualified |

A standalone CLI cannot inherit another application's MCP connection. The active harness performs authorized reads and supplies the bounded snapshots. No live account compatibility is implied by fixture tests.
