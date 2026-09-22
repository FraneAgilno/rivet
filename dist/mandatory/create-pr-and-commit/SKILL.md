---
name: rivet-create-pr-and-commit
description: "Full workflow to commit staged changes, push the branch, open a pull request on Bitbucket,"
---

# Create PR and Commit

Full workflow to commit staged changes, push the branch, open a pull request on Bitbucket,
and move the linked Jira ticket to In Review — with correct branch naming, commit message
format, and a generated PR title and description.

## Usage

```
/create-pr-and-commit
```

---

## Instructions

### Step 1 — Check the current branch

**Guard — verify Bitbucket remote and derive repo slug:**
```bash
BB_REMOTE=$(git remote get-url origin 2>/dev/null)
if [[ "$BB_REMOTE" != *bitbucket.org* ]]; then
  echo "This skill requires a Bitbucket remote. Detected: $BB_REMOTE"
  exit 1
fi
BB_SLUG=$(echo "$BB_REMOTE" | sed 's|.*bitbucket\.org[:/]\(.*\)\.git|\1|; s|.*bitbucket\.org[:/]\(.*\)|\1|')
```

```bash
git branch --show-current
```

- If already on a feature or fix branch (not `main`, `develop`, or `release/*`):
  - Extract the ticket key using the pattern `[A-Z]+-\d+` (e.g. `PROJ-123`, `BC-7`)
  - If no ticket key is found, ask the user for it
  - Skip to Step 3
- If on `main`, `develop`, or `release/*` — proceed to Step 2 to create a branch first

---

### Step 2 — Create a branch

Branch naming:
- Feature work: `feature/<JIRA-KEY>/<short-description>`
- Bug fix: `fix/<JIRA-KEY>/<short-description>`
- `<short-description>`: 2–5 words, lowercase, hyphen-separated, derived from the ticket title or staged changes

Ask the user for the ticket key if not already known, then:

```bash
git checkout -b feature/<JIRA-KEY>/<short-description>
```

---

### Step 3 — Stage and commit

Check what is staged and unstaged:

```bash
git status
git diff --stat
```

If there are unstaged changes, ask the user which files to include before staging anything.
Never run `git add .` or `git add -A` without confirmation.

Commit message format: `type(JIRA-KEY): short imperative description`

- Types: `feat`, `fix`, `refactor`, `docs`, `style`, `perf`, `chore`, `ci`, `build`, `test`
- JIRA-KEY: uppercase (e.g. `PROJ-123`)
- Description: lowercase, imperative, under 72 chars total
- Examples:
  - `feat(PROJ-123): add search filter component`
  - `fix(PROJ-123): resolve null pointer in auth middleware`
  - `refactor(PROJ-123): extract shared hook for form validation`

Do not add `Co-Authored-By` lines or EOF markers — write only the plain commit message.

```bash
git commit -m "type(JIRA-KEY): short description"
```

---

### Step 4 — Push the branch

```bash
git push -u origin <current-branch>
```

If the branch is already up to date on remote, the push will be a no-op — proceed to PR creation.

---

### Step 5 — Get Bitbucket credentials

**Credentials:**

macOS:
```bash
security find-internet-password -s "bitbucket.org" -g
```
Extract the `acct` (→ `$BB_USER`) and `password` (→ `$BB_PASS`) fields.

Linux / Windows or if keychain lookup fails: use `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD` env vars. If neither source yields credentials, ask the user.

**Write a temporary .netrc file so credentials never appear as shell arguments:**
```bash
printf 'machine api.bitbucket.org login %s password %s\n' "$BB_USER" "$BB_PASS" \
  > /tmp/.bb_netrc && chmod 600 /tmp/.bb_netrc
```

**Token requirements:** the password must be an Atlassian API token **with scopes**
(`read:account`, `read:repository`, `read:pullrequest`, `write:pullrequest` — Bitbucket app).
Unscoped API tokens return 401 on `api.bitbucket.org`.

Do **not** pre-check auth with `GET /2.0/user` — it can return 403 even with a valid scoped
token. Just attempt the PR creation (Step 8) and handle errors there.

---

### Step 6 — Determine repo slug, target branch, and PR context

**Repo slug** — always derive from the origin remote, never hardcode:

```bash
git remote get-url origin
```

Strip the host prefix and `.git` suffix to get `<workspace>/<repo>`:
- `git@bitbucket.org:_agilno/biocirv-client.git` → `_agilno/biocirv-client`
- `https://bitbucket.org/_agilno/biocirv-client.git` → `_agilno/biocirv-client`

**Target branch** — the branch this feature branch was created from. Resolve in order:

1. `CLAUDE.md` — a `defaultBranch` / `targetBranch` entry, if present
2. The branch the current branch diverged from — among the repo's long-lived branches,
   pick the one closest to HEAD (fewest commits between merge-base and branch tip):

   ```bash
   for b in dev develop main master; do
     git show-ref --verify --quiet "refs/remotes/origin/$b" \
       && echo "$b $(git rev-list --count "$(git merge-base HEAD "origin/$b")..origin/$b")"
   done | sort -k2 -n | head -1
   ```

   (e.g. if the repo's default working branch is `dev`, this yields `dev`, not `main`)

3. Fall back to `main`

**Gather context for the PR description:**

```bash
git fetch origin <target-branch>
git log origin/<target-branch>...HEAD --oneline
git diff origin/<target-branch>...HEAD --name-status
```

Draft:
- **Title**: `JIRA-KEY: Short imperative description` (under 70 chars) — derived from branch name and commits
- **Summary**: 2–4 sentences on what changed and why
- **Changes**: bulleted list grouped by area (backend, frontend, infra, tests)
- **How to test**: manual or automated verification steps
- **Screenshots**: include a placeholder section if UI was changed
- **Risks & rollback**: anything reviewers should watch for

---

### Step 7 — Quality gate check

If `.claude/pre-push-rules.md` exists in the project root and `/pre-push` has not been run
yet in this session, ask before opening the PR:

> "pre-push hasn't been run yet — run it now before opening the PR, or proceed anyway?"

- If the user asks to run it, run `/pre-push` and report the result. If it finds Critical
  issues, ask whether to fix them first or proceed to the PR regardless.
- If the user says proceed anyway, continue to Step 8 without re-prompting.

If `.claude/pre-push-rules.md` does not exist, or `/pre-push` already ran this session, skip
this step silently.

---

### Step 8 — Create the PR via Bitbucket API

Use the `<repo-slug>` and `<target-branch>` resolved in Step 6.

Check if a reviewer is configured via `BITBUCKET_PR_REVIEWER` env var. If set, include it;
if not, omit the `reviewers` field entirely.

```bash
# Without reviewer:
curl -s --netrc-file /tmp/.bb_netrc \
  -X POST \
  -H "Content-Type: application/json" \
  https://api.bitbucket.org/2.0/repositories/$BB_SLUG/pullrequests \
  -d '{
    "title": "<title>",
    "description": "<description>",
    "source": { "branch": { "name": "<current-branch>" } },
    "destination": { "branch": { "name": "<target-branch>" } },
    "close_source_branch": true
  }'

# With reviewer (when BITBUCKET_PR_REVIEWER is set):
curl -s --netrc-file /tmp/.bb_netrc \
  -X POST \
  -H "Content-Type: application/json" \
  https://api.bitbucket.org/2.0/repositories/$BB_SLUG/pullrequests \
  -d '{
    "title": "<title>",
    "description": "<description>",
    "source": { "branch": { "name": "<current-branch>" } },
    "destination": { "branch": { "name": "<target-branch>" } },
    "close_source_branch": true,
    "reviewers": [{ "account_id": "<BITBUCKET_PR_REVIEWER>" }]
  }'
```

Return the PR URL from the `links.html.href` field in the response.

**If the API returns 401 (invalid, expired, or unscoped token):**

Tell the user to create a scoped API token and update the keychain:

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>
2. **Create API token with scopes** → app **Bitbucket** → scopes `read:account`,
   `read:repository`, `read:pullrequest`, `write:pullrequest`
3. Store it in the keychain:

   ```bash
   security add-internet-password -U -s "bitbucket.org" -a "<email>" -w "<token>"
   ```

   (On Linux/Windows, update the `BITBUCKET_APP_PASSWORD` env var instead.)

Then retry the PR creation.

---

### Step 9 — Move Jira ticket to In Review

If Atlassian MCP is unavailable, skip this step silently.

Fetch the current ticket status:
```
mcp__claude_ai_Atlassian__getJiraIssue  →  fields.status.name
```

If the status is already `In Review` (or equivalent — `Code Review`, `Under Review`), skip.

Otherwise fetch available transitions:
```
mcp__claude_ai_Atlassian__getTransitionsForJiraIssue  (issueIdOrKey: <JIRA-KEY>)
```

Find the transition whose name matches `In Review`, `Code Review`, or `Under Review`
(case-insensitive). If found, apply it:
```
mcp__claude_ai_Atlassian__transitionJiraIssue  (issueIdOrKey: <JIRA-KEY>, transitionId: <id>)
```

If no matching transition is found, note it to the user:
> "Could not find an 'In Review' transition for <JIRA-KEY> — move it manually."

---

### Step 10 — Clean up credentials

```bash
rm -f /tmp/.bb_netrc
```

---

## Inconsistency signals — always stop and ask

| Signal | What to ask |
|---|---|
| No ticket key found in branch name | "No ticket key found — provide the JIRA key to continue?" |
| No staged changes and no unstaged changes | "Nothing to commit — stage the relevant files first, or abort?" |
| Bitbucket credentials not found in keychain or env vars | "No credentials found — provide your Atlassian email and a scoped API token?" |
| PR creation returns 401 | Walk the user through creating a scoped token (see Step 8) — do not retry with the same credentials |
| PR already exists for this branch | "A PR already exists — show the existing PR link, or create a new one anyway?" |
| Push fails due to non-fast-forward | "Push rejected — pull and rebase first, or force push?" |

---

## Notes

- Step 7 is the only point that runs `/pre-push` automatically-on-prompt — don't run it
  proactively elsewhere in this flow, and don't skip asking in Step 7 even if the user seems
  to be in a hurry.
- If a PR already exists for the branch, the API will return an error — inform the user and provide
  the existing PR link if available.
- Never force-push unless the user explicitly requests it.
- Do **not** add any AI attribution to commit messages or PR descriptions — no "Co-Authored-By: Claude", no "Generated with Claude Code", no similar footers.
