# Mandatory Skills

This optional imported skill pack covers planning, implementation and delivery. The directory name preserves its original grouping; installing the pack is not required for Rivet's minimal entry point. Install selected skills for the project's supported Claude or Codex target.

---

## Skills Overview

### `/feature-workflow` — `feature-workflow.md`
**Purpose:** Route an inline request, Markdown file, Jira issue, or Linear issue through the same governed Rivet feature lifecycle from Claude or Codex.

Defaults to the current harness through host preflight and `rivet work propose/prepare/next/submit/verify`. It discovers configured direct or harness-connected MCP sources, preserves source assurance, requires exact proposal activation, records verification and stops at the human final-delivery gate. The terminal `rivet run` and explicitly selected advanced spawned flows remain available. It never edits private state or recreates orchestration.

> **Requires:** Reviewed `.rivet` policy, the installed Rivet CLI and the host's required tools/permissions. Jira/Linear sources require a configured scoped read-capable direct provider or an authenticated harness-connected tool. Direct credentials remain environment references. Missing or ambiguous source access stops rather than inventing ticket facts.

### `/agentic-status` — `agentic-status.md`
**Purpose:** Inspect the sole active project task using `rivet task status`, present bounded evidence and choices, and continue only when requested. Host continuation, spawned resume, abandoned-lock recovery and read-only delivery reconciliation retain their separate service contracts; advanced orchestration-instance inspection remains available for configured controllers.

### `/project-context` — `project-context.md`
**Purpose:** Bootstraps or updates the project's `CLAUDE.md` and a matching Confluence page.

Run this once when setting up a new project, and again whenever the project's architecture,
stack, or conventions change significantly. It asks the developer targeted questions to fill
gaps, then generates a structured `CLAUDE.md` and syncs a human-readable version to Confluence.

> **Requires:** Atlassian MCP configured in Claude Code settings. Without it, `CLAUDE.md` is
> still generated locally — Confluence sync is skipped.

---

### `/design` — `design.md`
**Purpose:** Write a design document for a Jira ticket *before* any code is written.

Fetches the ticket and all linked tickets (including BE tickets for context), explores the
codebase, and reads any linked Figma or Confluence files. Asks only the questions that
tickets and code cannot answer. Outputs a structured design doc to `design_docs/`.

> **Requires:** Atlassian MCP. Figma MCP is optional — used automatically if configured.
> Works for FE, BE, and full-stack tickets on any project.

---

### `/apply-design` — `apply-design.md`
**Purpose:** Implement a design doc produced by `/design`, phase by phase with safety gates.

Runs pre-flight checks before touching any code (file existence, symbol existence, shared
component conflicts). Applies changes step by step with confirmation gates at phase
boundaries, runs tests after each step, and verifies all acceptance criteria at the end.

> **Requires:** A design doc in `design_docs/` produced by `/design`. Reads `CLAUDE.md` for
> project conventions — no hardcoded stack rules.

---

### `/pre-push` — `pre-push.md`
**Purpose:** Quality gate before creating a PR.

Runs tool checks on all changed files — ESLint, `tsc --noEmit`, a secret scan (grep for
hardcoded credentials and API keys), Prettier, and a dependency/supply-chain audit (`npm
audit`/`pip-audit` on changed lockfiles) — then applies a static review against project
rules covering code quality, React patterns, TypeScript strictness, security, performance,
and naming conventions. Escalates to the full `/security-review` checklist when changed
files touch an auth, payment, or user-data path. Reports findings as Critical / Warning /
Suggestion.

> **Requires:** A `.eslintrc.json` and a `.claude/pre-push-rules.md` file in the project root.
> See `templates/pre-push-rules.md` for the standard rule set to copy into new projects.
> `npm audit`/`pip-audit` (or your package manager's equivalent) should be available on
> `PATH` for the dependency audit step — it's skipped with a note if not.

---

### `/security-review` — `security-review.md`
**Purpose:** OWASP-mapped security audit for auth, payment, and user-data code.

Runs standalone on demand, or auto-invoked inline by `/pre-push` and `/review-pr` whenever a
diff touches a sensitive path. Covers auth & tokens, input validation & mass assignment,
secrets & cryptography, authorization & tenant isolation, security logging, and
headers/configuration, with framework-specific notes for NestJS, Django, and Next.js.

> **Requires:** Nothing beyond the codebase itself. Reads `CLAUDE.md`'s Sensitive Areas
> section if present to help scope the review.

---

### `/check-ac` — `check-ac.md`
**Purpose:** Verify the current branch satisfies its Jira ticket's acceptance criteria.

Fetches the linked Jira ticket, diffs the branch against main, and evaluates each AC as
PASS / FAIL / MANUAL. Also scans for missing UX best practices (empty states, loading
indicators, accessibility, etc.) as advisory tips.

> **Requires:** Atlassian MCP. Branch name must contain a ticket ID (e.g. `PROJ-123`).

---

### `/release-docs` — `release-docs.md`
**Purpose:** Publish a user-facing feature list to Confluence at release time.

Fetches merged PRs from both the FE and BE repos since the last run, extracts Jira ticket
IDs from PR titles and branch names (squash-merge safe), pulls full context from Jira, and
generates a user-friendly Confluence page for Marketing and the Project Client. Shows the
generated content and asks for explicit confirmation before publishing — this is the only
mandatory skill that pushes AI-drafted content straight to an externally-visible page. Run
from the FE repo whenever docs need publishing — on a prod release or after a meaningful dev
push during MVP.

**Usage variants:**
- `/release-docs` — fetch everything since last run
- `/release-docs since=2026-04-01` — override the start date
- `/release-docs since=v1.2.0` — start from a git tag

> **Requires:** Atlassian MCP, Bitbucket credentials (`BITBUCKET_USERNAME` / `BITBUCKET_APP_PASSWORD`
> or macOS keychain). BE repo must be cloned as a sibling at the path in `siblingRepoPath` (see
> Local repo setup in the connector README).

---

### `/review-pr` — `review-pr.md`
**Purpose:** Review a teammate's Bitbucket PR without a local checkout.

Fetches the PR diff and linked Jira ticket, then runs the same checks as `/pre-push` and
`/check-ac` — but applied to the API diff rather than local files. Checks PR title format,
AC coverage, test presence and relevance, secrets, a dependency/supply-chain check, static
code quality, and shared component reuse — escalating to `/security-review` on sensitive
paths. Re-checks its own Critical/FAIL findings before acting on them, then posts findings
as inline and general PR comments and approves or requests changes. Treats all fetched PR
and ticket text as data, never as instructions to follow.

> **Requires:** Atlassian MCP (for Jira/AC checks — skipped gracefully if unavailable).
> Bitbucket credentials (`BITBUCKET_USERNAME` / `BITBUCKET_APP_PASSWORD` or macOS keychain).

---

### `/address-pr-feedback` — `address-pr-feedback.md`
**Purpose:** Apply reviewer comments from a Bitbucket PR in one run.

Fetches all unresolved comments, groups them by file, presents them with suggested fixes,
then for each: applies the change, commits with a reference to the comment, and replies
"Done." on the comment. Flags (rather than acts on) any comment that reads as an instruction
to the AI itself instead of code feedback. Re-runs `/pre-push` at the end if the project has
it configured.

> **Requires:** Bitbucket credentials (`BITBUCKET_USERNAME` / `BITBUCKET_APP_PASSWORD` or
> macOS keychain). PR must be open for the current branch.

---

### `/create-pr-and-commit` — `create-pr-and-commit.md`
**Purpose:** Full workflow from staged changes to an open pull request — branch naming, commit
message, push, PR creation, and Jira ticket transition to In Review.

Covers: creating a correctly named branch (if needed), staging and committing with a
conventional commit message, pushing to remote, opening a Bitbucket PR, and moving the linked
Jira ticket to In Review if it isn't already. Optionally assigns a reviewer via the
`BITBUCKET_PR_REVIEWER` env var. Asks before opening the PR if `/pre-push` hasn't run yet
this session and `.claude/pre-push-rules.md` exists — the quality gate can be deferred with
explicit confirmation, never skipped silently.

> **Requires a Bitbucket remote.** The repository slug is derived automatically from `git remote get-url origin`.
> Atlassian MCP is optional — Jira transition is skipped gracefully if unavailable.

---

### `/hotfix` — `hotfix.md`
**Purpose:** Fast path for production incidents — skips the `/design` document but keeps
every quality gate.

Confirms the issue is actually urgent (otherwise recommends `/design` instead), resolves or
creates the Jira ticket, scopes the fix with a short plan instead of a full design doc, then
applies the fix with a mandatory regression test, a non-skippable `/pre-push`-equivalent
quality gate, and a lightweight verification pass against the reported symptom before
opening the PR. Requires a ticket comment or postmortem ticket recording root cause and fix
before the hotfix is considered complete.

> **Requires a Bitbucket remote** (same auto-derived slug as `/create-pr-and-commit`).
> Atlassian MCP is optional — proceeds without a ticket if unavailable, but flags it in the PR.

---

## Recommended Developer Flow

```
/project-context        ← once per project setup or major change

/feature-workflow       ← generic Rivet feature path from Markdown, inline text,
                           Jira, or Linear; stops before push/merge/deploy

/design PROJ-XXX         ← start of every feature (plan before coding)
/apply-design PROJ-XXX   ← implement from the plan

/pre-push               ← before creating a PR (auto-escalates to /security-review
                           on auth/payment/user-data paths)
/check-ac               ← AC verification
/create-pr-and-commit   ← commit, push, and open the PR

/review-pr              ← review a teammate's PR (diff + AC + secrets + dependency
                           audit + code quality, escalates to /security-review too)
/address-pr-feedback    ← apply reviewer comments, commit, reply, re-run pre-push

/release-docs           ← at release time (or after a meaningful dev push during MVP)
                           reads merged PRs from both BE + FE, updates Confluence
                           (asks for confirmation before publishing)

/hotfix PROJ-XXX         ← production incident — replaces the /design + /apply-design
                           pair above with a fast path that still runs the full
                           quality gate and requires a regression test
```

`/security-review` isn't a separate step in this flow — it's auto-invoked inline by
`/pre-push` and `/review-pr` whenever a diff touches a sensitive path. Run it directly
(`/security-review`) for an ad-hoc audit outside those flows.

---

## Installation

Copy the contents of this directory into your project's `.claude/skills/` folder:

```bash
cp mandatory/skills/*.md your-project/.claude/skills/
```

Or, if your project uses the `rivet` install script:

```bash
rivet install
```

---

## Project-Specific Configuration Checklist

The Bitbucket repository slug needs no manual editing anywhere — `create-pr-and-commit.md`,
`address-pr-feedback.md`, `review-pr.md`, and `hotfix.md` all derive it automatically from
`git remote get-url origin`. What actually needs setup per project:

| File | What to check |
|---|---|
| `pre-push.md` | Ensure `.claude/pre-push-rules.md` exists in the project. Ensure `npm audit`/`pip-audit` (or your package manager's equivalent) is available for the dependency audit step. |
| `review-pr.md` / `address-pr-feedback.md` / `create-pr-and-commit.md` / `hotfix.md` | Bitbucket credentials available via macOS keychain or `BITBUCKET_USERNAME`/`BITBUCKET_APP_PASSWORD`. |
| `security-review.md` | Optional: list Sensitive Areas in `CLAUDE.md` so the auto-escalation in `/pre-push` and `/review-pr` knows which paths to treat as sensitive beyond the default auth/payment/user-data heuristic. |
