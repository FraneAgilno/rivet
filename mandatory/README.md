# Claude Code Setup

Before using any skills, every developer must connect the required external services to Claude
Code. These connections are **mandatory** — the skills that drive the development workflow depend
on them.

---

## Atlassian connector (required for everyone)

Most skills read from and write to Jira and Confluence — fetching tickets, checking acceptance
criteria, syncing design docs, and enriching PRs. Without this, `/design`, `/check-ac`,
`/create-pr-and-commit`, `/project-context`, and `/release-docs` will not work.

**How to connect:**

1. Go to [claude.ai](https://claude.ai) → **Settings → Connectors**
2. Connect your **Atlassian** account

Once connected, it's available automatically — no extra configuration needed.

You can also use it standalone in chat:

- _"What's the status of PROJ-123?"_
- _"Transition PROJ-123 to In Review"_
- _"Add a comment to PROJ-456 saying the fix is in PR #634"_

---

## Figma connector (required for frontend developers)

If you work on the frontend, Figma access is mandatory. The `/design` skill reads linked Figma
files to produce accurate design docs, and you can share any Figma URL in chat to get Claude
to inspect components, layouts, and copy.

**Step 1** — Connect your Figma account at [claude.ai](https://claude.ai) → **Settings →
Connectors → Figma**

**Step 2** — Get a personal access token: **Figma → Settings → Security → Personal access
tokens**

**Step 3** — Add it to `.claude/settings.json` (gitignored — create it locally, do not commit):

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--figma-api-key=<your-token>", "--stdio"]
    }
  }
}
```

Once set up, you can share Figma URLs directly in chat and Claude will read the design.

---

## Local repo setup (required for FE developers, recommended for everyone)

Pull all project repos locally so Claude can answer cross-repo questions on the spot — API
contracts, data shapes, shared models — without waiting for a teammate.

Clone all repos as siblings under one parent directory:

```
~/project-name/
  mobile/
  api/
  admin/
  ...
```

**Required for FE developers:** `/release-docs` reads merged PRs from the BE sibling repo to
generate the full feature list. The BE repo must be cloned as a sibling at the path stored in
`siblingRepoPath` in your `CLAUDE.md` — without it, `/release-docs` cannot run.

**Two ways to use it:**

- Run `claude` from the **parent directory** for full cross-repo visibility in one session
- Run `claude` from within your repo and point it at siblings with relative paths:
  _"Check `../api/src/routes/users.ts` and tell me what this endpoint returns"_

**Example prompts:**

- _"What fields does the `/sessions` endpoint return? Check `../api`."_
- _"Does the API have pagination on this route? Look in `../api/src`."_

---

## Dependency audit tooling (required for `/pre-push` and `/review-pr`)

`/pre-push` and `/review-pr` run a dependency/supply-chain audit on any changed lockfile.
Make sure the relevant tool is installed and on `PATH`:

- **JS/TS projects:** `npm audit` (or `pnpm audit` / `yarn audit`) — ships with the package
  manager, no separate install needed.
- **Python projects:** [`pip-audit`](https://pypi.org/project/pip-audit/) — `pip install
  pip-audit`.

If neither is available, the audit step is skipped with a note in the output rather than
blocking the check.

---

## Skills

See [`skills/`](./skills/README.md) for the full list of available skills, installation
instructions, and the recommended developer flow.
