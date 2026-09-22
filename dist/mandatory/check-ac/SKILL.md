---
name: rivet-check-ac
description: "Verify that the current branch satisfies the acceptance criteria of its linked Jira ticket."
---

# Check Acceptance Criteria

Verify that the current branch satisfies the acceptance criteria of its linked Jira ticket.

## Usage

- `/check-ac` — run AC check
- `/check-ac no` — same, kept for backwards compatibility

## Instructions

1. Get the current branch name:

   ```
   git branch --show-current
   ```

   Extract the ticket ID — it follows the pattern `[A-Z]+-\d+` anywhere in the branch name
   (e.g. `feature/PROJ-123/increase-image-number` → `PROJ-123`, `fix/BC-12/auth-bug` → `BC-12`).

   If no ticket ID is found, inform the user and stop.

2. Fetch the Jira issue using `mcp__claude_ai_Atlassian__getJiraIssue`:

   - issueIdOrKey: the extracted ticket ID (e.g. `PROJ-123`)

   Extract from the response:
   - `fields.summary` — ticket title
   - `fields.description` — full description (acceptance criteria are usually listed here)
   - `fields.status.name` — current status

   Parse out the acceptance criteria. They may be:
   - A section explicitly labelled "Acceptance Criteria" or "AC"
   - A bulleted or numbered list in the description
   - Inline conditions described in prose

   If no criteria are found, note that and proceed with a general diff review.

3. Get the full diff of the branch against main:

   ```
   git fetch origin main
   git diff origin/main...HEAD
   ```

4. For each acceptance criterion, reason over the diff and assign a status:

   - ✅ **PASS** — the diff clearly satisfies this criterion
   - ❌ **FAIL** — the diff clearly does not satisfy this criterion, or contradicts it
   - 🔍 **MANUAL** — cannot be verified from code alone (UI behaviour, device testing, edge cases, etc.)

5. Output format:

   ```
   ## AC Check — PROJ-XXX: <ticket title>

   ### Acceptance Criteria

   | # | Criterion | Status | Notes |
   |---|-----------|--------|-------|
   | 1 | <criterion text> | ✅ PASS / ❌ FAIL / 🔍 MANUAL | <brief reasoning or what to test> |
   | 2 | ...               | ...                           | ...                               |

   ### Summary
   - ✅ PASS: X / Y
   - ❌ FAIL: X / Y
   - 🔍 MANUAL (requires testing): X / Y

   ### Verdict
   <One of the following>
   - 🟢 Ready to ship — all criteria passed or require manual QA only
   - 🔴 Blocked — X failing criteria must be resolved before merging
   ```

6. After the AC table, scan the diff for missing best practices and UX standards. These do NOT affect the verdict — they are advisory only. Apply only the categories relevant to the stack identified in `CLAUDE.md`:

   **Universal (all stacks)**
   - Empty state handling — lists or data with no feedback when empty
   - Loading states — async operations with no loading indicator
   - Error states — inputs or API calls with no error feedback to the user
   - Trim/sanitize — user text inputs that aren't trimmed before submission
   - Disabled state — submit buttons that remain active while a request is in flight

   **Frontend / mobile**
   - Accessibility — missing `aria-label` / `accessibilityLabel` on interactive elements, images without alt text
   - Placeholder text — inputs missing placeholder or label
   - Text inputs — `autoCapitalize`, `autoComplete`, `keyboardType` (mobile); `autocomplete`, `inputmode` (web)
   - Keyboard avoiding — forms that may be obscured by the on-screen keyboard (mobile only)

   **Backend / API**
   - Input validation — required fields not validated, no 400 response for malformed input
   - Auth checks — endpoints missing authentication or authorisation guards
   - Error codes — errors returning 200 with an error body instead of a proper HTTP status

   Only flag items relevant to what changed in the diff. Skip categories with no related changes.

   Append to the output after the Verdict:

   ```
   ### 💡 Best Practice Tips
   <Only include if there are findings. If nothing to flag, omit this section entirely.>

   - 💡 <file:line> — <what was missed and why it matters>
   - 💡 <file:line> — ...
   ```

7. If there are ❌ FAIL items:
   - List specific file paths and line numbers from the diff that evidence the failure
   - Tell the user: "Fix the failing criteria and re-run `/check-ac`."

8. If there are NO ❌ FAIL items (all are ✅ PASS or 🔍 MANUAL):
   - Tell the user the branch is ready to PR. Remind them to run `/release-docs` at release time to publish the feature list to Confluence.

## Notes

- Focus on what changed, not the entire codebase. Only diff against `origin/main`.
- Be conservative: if you are unsure, mark 🔍 MANUAL rather than ✅ PASS.
- UI-only criteria (animations, visual polish, layout) are always 🔍 MANUAL.
- Criteria about API behaviour, error handling, or backend responses are always 🔍 MANUAL unless the diff includes explicit handling for those cases.
