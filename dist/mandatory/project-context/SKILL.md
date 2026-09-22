---
name: rivet-project-context
description: "Bootstrap or update the project's `CLAUDE.md` and matching Confluence page by extracting context"
---

# Project Context

Bootstrap or update the project's `CLAUDE.md` and matching Confluence page by extracting context
from existing docs, asking targeted questions for gaps, and syncing everything in one run.
Works on any project regardless of stack.

## Usage

```
/project-context
```

No arguments. Claude drives the process interactively.

---

## Run Types

- **First run:** no `CLAUDE.md` exists in the repo root. Full extraction → questionnaire → generate → Confluence create.
- **Update run:** `CLAUDE.md` already exists. Full extraction → questionnaire for changed/missing info → section-level diff → patch only changed sections in both `CLAUDE.md` and Confluence.

---

## Phase 1 — Extract (`extract.md`)

Claude asks the developer to provide any existing documentation: Confluence URLs, README content, architecture notes, ADRs, runbooks, or anything else they have. Claude reads what's provided and extracts structured information across all 8 required sections. It produces an internal summary of what's known and what's still missing before proceeding to Phase 2.

If the developer has no existing documentation, Phase 1 is skipped and Claude proceeds directly to the full questionnaire.

---

## Phase 2 — Questionnaire (`questionnaire.md`)

Claude asks targeted follow-up questions for every section that remains incomplete after Phase 1. Questions are asked one at a time, in order of importance. Sections already fully covered by extracted docs are skipped.

This gives developers with good existing documentation a fast path while still filling gaps for projects with sparse docs.

**Always ask these two questions regardless of existing docs** (needed for `/release-docs`):

1. "Is this a BE or FE project?" → writes `teamType: be` or `teamType: fe`
2. "What is the relative path to the sibling repo from this repo's root? (e.g. `../project-be` or `../project-fe`)" → writes `siblingRepoPath: <path>`

These fields are required even if a CLAUDE.md already exists and only ask them if not already present.

---

## Phase 3 — Generate CLAUDE.md (`generate.md`)

Claude generates `CLAUDE.md` in the repo root using a fixed 8-section template. All sections are required.

**CLAUDE.md template:**

```markdown
# {Project Name}

## Overview
{1-2 sentences: what this project does and why it exists}

## Team & Stakeholders
{team name, key contacts, stakeholder groups}

## Tech Stack
{language versions, frameworks, key libraries — bullet list}

## Architecture
{services, data flow, key components — brief prose + bullet list}

## Key Conventions
{naming rules, patterns to follow, patterns to avoid}

## Dev Workflow
{how to run locally, branch strategy, CI/CD pipeline summary}

## External Dependencies
{third-party APIs, services, infrastructure — names + purpose}

## Sensitive Areas
{billing, auth, compliance — what needs extra care and why}

## Onboarding Notes
{gotchas, known quirks, things that trip up new devs}

<!-- AI skill config — do not remove -->
confluenceFeaturePageId: {page_id_written_by_project-context_after_confluence_sync}
defaultBranch: {main_or_develop}
teamType: {be_or_fe}
siblingRepoPath: {relative_path_to_sibling_repo}
```

`confluenceFeaturePageId` is written automatically during Phase 4 after the Confluence page is created or identified. `defaultBranch` is used by `/create-pr-and-commit` to target the correct PR destination. `teamType` and `siblingRepoPath` are used by `/release-docs` to fetch merged PRs from both repos.

**Update run diffing:** Section headers act as anchors. Claude reads the existing `CLAUDE.md`, compares each section against the newly gathered information, and replaces only sections where the content has changed. Sections with no new conflicting information — including sections that were manually edited by the team — are left untouched.

If the existing `CLAUDE.md` is malformed or missing section headers, it is treated as a first run and fully regenerated.

---

## Phase 4 — Confluence Sync (`confluence.md`)

Claude asks the developer for:

- Target Confluence space key
- Parent page title under which the new page should be created

On first run: creates a new child page titled `{Project Name} — AI Context`. After creation,
writes the returned page ID into `CLAUDE.md` as `confluenceFeaturePageId: <id>` so that
`/release-docs` can sync to it without further setup.

On update run: searches for an existing child page with the title `{Project Name} — AI Context` under the same parent. If found, patches only sections that changed. If not found (e.g. page was renamed or moved), treats it as a first run and creates a new page.

**Confluence page structure:** Mirrors the 8 CLAUDE.md sections but formatted for human readers — more prose, links to related pages, code snippets where useful. Includes a footer:

> _Last updated by AI context skill on {date} — review and adjust as needed._

If the target parent page is not found, Claude lists available spaces and lets the developer pick interactively.

If a Confluence page with the expected title already exists but was not created by this skill, Claude shows a diff and asks for explicit confirmation before overwriting.

---

## MCP Check

`index.md` runs this check before any phase begins by calling `mcp__claude_ai_Atlassian__atlassianUserInfo`.

**If MCP is available:** Confluence sync proceeds normally in Phase 4.

**If MCP is unavailable or returns an auth error:** Claude prints setup instructions and skips Phase 4. `CLAUDE.md` is still generated.

```text
Atlassian MCP is not configured. To enable Confluence sync:

1. Go to claude.ai → Settings → Connectors → connect your Atlassian account
2. Re-run /project-context once connected

Your CLAUDE.md will still be generated locally — Confluence sync will be skipped for now.
```

---

## Error Handling

| Situation | Behavior |
| --- | --- |
| No docs provided by developer | Skip Phase 1, go straight to full questionnaire |
| Confluence parent page not found | List available spaces, let developer pick interactively |
| Existing `CLAUDE.md` malformed / missing headers | Treat as first run, full regeneration |
| Confluence page exists but not created by this skill | Show diff, require explicit confirmation before overwriting |
| MCP unavailable | Generate `CLAUDE.md` locally, skip Confluence with setup instructions |

---

## Required Sections (all mandatory)

1. Project overview — purpose, team, stakeholders
2. Tech stack — languages, frameworks, key libraries
3. Architecture — services, data flow, key components
4. Key conventions — naming, code style, patterns to follow/avoid
5. Dev workflow — local setup, branch strategy, CI/CD
6. External dependencies — third-party services, APIs, infrastructure
7. Sensitive areas — billing, auth, compliance, areas needing extra care
8. Onboarding notes — gotchas, quirks, things that trip up new devs

---

## Distribution

This skill follows the same distribution path as all other skills in this repo: it is packaged via the `@agilno/rivet` npm package and installed into Claude Code via `rivet install`. Once installed, it is available as `/project-context` in any Claude Code session.

---

## Non-Goals

- This skill does not enforce CLAUDE.md format for existing manually-written files — it only patches them on update runs.
- This skill does not sync changes made directly in Confluence back into CLAUDE.md — Confluence is write-only from the skill's perspective.
- This skill does not validate whether the information provided by the developer is accurate.
