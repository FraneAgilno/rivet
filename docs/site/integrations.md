# Integrations

Teams should use their existing tool providers. The planned integration registry will distinguish harness-connected MCPs from direct API or CLI transports and report which capabilities are actually available.

| Area | Planned providers |
| --- | --- |
| Tickets | Linear, Jira |
| Design | Figma |
| Knowledge | Confluence, Notion, Obsidian |
| Repository hosting | GitHub, Bitbucket Cloud, GitLab |
| Browser verification | Playwright |
| Production diagnostics | Sentry |
| Internal systems | Custom MCP servers |

The source import contains Jira, Linear, Figma, Confluence, and GitHub adapter modules. Their presence does not prove a current live account connection. MCP normalization, Bitbucket/GitLab delivery adapters, and custom integration configuration remain planned.

A CLI cannot automatically inherit a desktop harness's private MCP connections or credentials. Harness observations need a validated source envelope; standalone execution needs an explicitly available transport. Providers report unsupported operations rather than simulating success.
