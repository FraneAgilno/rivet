---
name: rivet-release-docs
description: "Updates the project's Confluence features page with everything shipped since the last run. Reads merged PRs from both th"
---

## Release Docs

Updates the project's Confluence features page with everything shipped since the last run. Reads merged PRs from both the current repo and its sibling repo, pulls full context from Jira, and generates a user-friendly feature list for Marketing and the Project Client.

Run this from the **FE repo** whenever you need to publish docs — on a prod release or after a meaningful dev push during MVP.

### Usage

```
/release-docs
/release-docs since=2026-04-01
/release-docs since=v1.2.0
```

---

### Instructions

#### 1. Read config from CLAUDE.md

Read the following fields from `CLAUDE.md` in the current repo:

- `siblingRepoPath` — relative path to the sibling (BE) repo, e.g. `../project-be`
- `lastReleaseDocsDate` — ISO timestamp of the last successful run (may not exist yet)
- `confluenceFeaturePageId` — Confluence page ID to update

If `confluenceFeaturePageId` is missing, abort and tell the user to run `/project-context` first.

#### 2. Resolve the "since" date

Use the first that applies:

1. `since=` argument passed by the user
2. `lastReleaseDocsDate` from CLAUDE.md
3. Ask the user: "No previous run found. Enter a date (YYYY-MM-DD), tag, or leave blank to fetch all merged PRs."

#### 3. Derive Bitbucket repo slugs

Run in the current repo:
```bash
BB_REMOTE=$(git remote get-url origin 2>/dev/null)
if [[ "$BB_REMOTE" != *bitbucket.org* ]]; then
  echo "This skill requires a Bitbucket remote. Detected: $BB_REMOTE"
  exit 1
fi
```

Run in the sibling repo:
```bash
git -C <siblingRepoPath> remote get-url origin
```

Parse each URL to extract `workspace/repo-slug`:
- SSH: `git@bitbucket.org:workspace/repo.git` → `workspace/repo`
- HTTPS: `https://bitbucket.org/workspace/repo.git` → `workspace/repo`

#### 4. Get Bitbucket credentials

**macOS:**
```bash
security find-internet-password -s "bitbucket.org" -g
```
Extract `acct` (→ `$BB_USER`) and `password` (→ `$BB_PASS`).

**Fallback:** use `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD` env vars. If neither works, ask the user.

Write a temporary .netrc file so credentials never appear as shell arguments:
```bash
printf 'machine api.bitbucket.org login %s password %s\n' "$BB_USER" "$BB_PASS" \
  > /tmp/.bb_netrc && chmod 600 /tmp/.bb_netrc
```

#### 5. Fetch merged PRs from both repos

For each repo (current + sibling), call the Bitbucket API:

```
GET https://api.bitbucket.org/2.0/repositories/{workspace}/{slug}/pullrequests
  ?state=MERGED
  &q=updated_on>="<since-date>"
  &fields=values.id,values.title,values.description,values.source.branch.name,values.merge_commit
  &pagelen=50
```

Use `--netrc-file /tmp/.bb_netrc` for auth. Paginate if `next` is present in the response.

From each PR, extract:
- Ticket ID from **title** using pattern `[A-Z]+-\d+` (e.g. `PROJ-123: Add chat feature` → `PROJ-123`)
- Ticket ID from **branch name** as fallback (`feature/PROJ-123/chat` → `PROJ-123`)
- **PR description** — keep as supplementary context

#### 6. Deduplicate ticket IDs

Combine ticket IDs from both repos. Remove duplicates. Skip any ID that cannot be parsed from either title or branch name.

#### 7. Fetch Jira details for each ticket

For each unique ticket ID:

```
mcp__claude_ai_Atlassian__getJiraIssue  →  summary, description, acceptance criteria
mcp__claude_ai_Atlassian__getJiraIssueRemoteIssueLinks  →  linked issues
```

Also check the `parent` field for Epic name — use Epic name as the feature heading when available.

#### 8. Group tickets into features

- Tickets linked to each other in Jira (BE + FE pair) → one combined feature entry
- Tickets under the same Epic → grouped under the Epic name
- Unlinked single ticket → standalone entry

Use the Epic name (or ticket summary for standalone tickets) as the feature heading.

#### 9. Fetch the current Confluence page

```
mcp__claude_ai_Atlassian__getConfluencePage  (pageId = confluenceFeaturePageId)
```

Parse the existing feature headings so you can update existing sections and append new ones — don't wipe the whole page.

#### 10. Generate updated page content

Write for a **Marketing and Project Client audience** — non-technical, focused on what the feature does and why it matters.

For each feature:
- **Heading**: Epic name or ticket summary (consistent across releases)
- **Body**: 2–4 sentences on what it is, what users can do with it, key capabilities
- Use the Jira description and AC as primary source; PR descriptions for supplementary detail
- Avoid technical terms, implementation details, or code references

Page structure:
```
# {Project Name} — Features
Last updated: {today's date}

## {Feature Name}
{User-friendly description}

## {Feature Name}
...
```

For features already on the page: update the section if new PRs improve or extend it. For new features: append.

#### 11. Confirm before publishing

This page is externally visible to Marketing and the Project Client — show the full
generated content (or a diff against the current page from step 9) and ask:

> "Publish this to Confluence? (yes / edit / cancel)"

- **yes** — continue to step 12.
- **edit** — take the requested changes, regenerate, and ask again.
- **cancel** — stop here. Do not update Confluence or `lastReleaseDocsDate`.

Do not publish without an explicit "yes" — this is the only mandatory skill that pushes
AI-drafted content straight to an externally-visible page, so it does not get the
implicit trust other skills' local file edits do.

#### 12. Update Confluence

```
mcp__claude_ai_Atlassian__updateConfluencePage
```

Use the generated content as the full page body.

#### 13. Update CLAUDE.md

Write the current UTC timestamp to `lastReleaseDocsDate` in `CLAUDE.md`:

```
lastReleaseDocsDate: 2026-05-27T14:00:00Z
```

If the field already exists, replace it. If not, add it after the existing skill config block.

Confirm to the user: how many tickets were processed, how many features were added/updated, and the Confluence page URL.

#### 14. Clean up credentials

```bash
rm -f /tmp/.bb_netrc
```
