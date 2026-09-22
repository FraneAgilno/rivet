# Apply Design

Implement a design document produced by `/design`, phase by phase, with pre-flight checks,
inconsistency detection, and user confirmation gates before any ambiguous or destructive change.

## Usage

```
/apply-design <TICKET_ID_OR_PATH>
```

Examples:
- `/apply-design PROJ-123`
- `/apply-design design_docs/PROJ-123-increase-image-number.md`

---

## Instructions

### Step 0 — Locate the design document

If a ticket ID is given, glob `design_docs/<TICKET_ID>*.md` and read the first match.
If a path is given, read it directly.
If the file does not exist, stop and ask the user where the design doc is.

---

### Step 1 — Read project conventions

Read `CLAUDE.md` at the repo root. Extract and hold in memory all naming rules, TypeScript
rules, styling/token rules, reuse rules, and any patterns to follow or avoid.
These will be enforced on every edit in Step 4.

---

### Step 2 — Parse the design doc

Extract and hold in memory:
- **Ticket inventory** (Section 0 if present): all ticket IDs and dependency graph
- **Phase plan** (Section 0 — Implementation Order): which tickets are in which phase
- **Implementation steps** (Section 7): each step's target file path and what to change
- **Screen / component map** (Section 6): new vs existing components
- **API calls** (Section 6): endpoints involved
- **Acceptance criteria** (Section 9): checklist per ticket — used to verify at the end

---

### Step 3 — Pre-flight verification (run all in parallel)

Before touching any code, verify the design is consistent with the current codebase.

**3a. File existence**
For every file path referenced in Section 7, confirm it exists (use Glob).
For new files the design says to create, confirm they do NOT already exist.

**3b. Symbol existence**
For every component, function, hook, or type the design says to *modify*, confirm it
currently exists (use Grep with the symbol name).
For every symbol the design says to *create*, confirm it does NOT already exist.

**3c. Shared component check**
For every new component in the design, check if a shared/common components directory is
defined in `CLAUDE.md` (e.g. `src/shared/components/`, `components/ui/`, etc.) and search
it to confirm there is no existing component that already solves the same problem. If
found, flag it — the design may need updating before implementing. Skip if no shared
component path is defined in `CLAUDE.md`.

**3d. Import path check**
For any imports referenced in Section 7, verify the import paths exist in the codebase.

**3e. API / state dependency check**
For each API endpoint listed in Section 6, check whether a data-fetching hook or service
for it already exists (check the path defined in `CLAUDE.md`, or search the codebase for
the endpoint URL string). Note if it needs to be created.

After all checks, produce a **Pre-flight Report**:

```
PRE-FLIGHT REPORT
=================
✅  path/to/file.tsx — found
⚠️  ComponentName — design says modify, but NOT FOUND in codebase
⚠️  useXxxQuery — design says create, but ALREADY EXISTS at src/shared/state/xxx.state.ts
✅  No conflicting shared components found
❌  src/modules/xxx/xxx.screen.tsx — file does not exist
...
```

**STOP and show this report to the user.** Ask:
> "Pre-flight found N issue(s). Do you want to proceed anyway, fix the issues first, or abort?"

Do not continue until the user explicitly confirms.
If there are ❌ items, recommend resolving them before proceeding.

---

### Step 4 — Confirm implementation plan

Present a numbered plan of all implementation steps in phase order:

```
IMPLEMENTATION PLAN
===================
Phase 1 (parallel — run in any order):
  [1] PROJ-XXX — Step 1: path/to/component.tsx — create new component
  [2] PROJ-XXX — Step 2: path/to/screen.tsx — wire component into screen
  ...
Phase 2 (after Phase 1):
  [3] PROJ-YYY — Step 1: ...
```

Ask:
> "Does this plan look right? Any steps to skip, reorder, or combine before I start?"

Wait for user approval before proceeding.

---

### Step 5 — Apply changes, step by step

For each step in the approved plan:

#### 5a. Before making the change
Re-read the target file at the affected location to confirm it matches what the design describes.
If the current code differs materially from the design's description — **STOP and report**:
> "⚠️ Inconsistency at [file:line]: design says X, but current code shows Y. How would you like to proceed?"
Wait for explicit instruction before editing.

#### 5b. Apply the change
Use the Edit tool for modifications, Write only for new files.
Enforce all conventions extracted from `CLAUDE.md` in Step 1 — naming rules, typing rules,
styling conventions, reuse patterns, and anything marked as "avoid". Do not apply
assumptions from other projects; use only what `CLAUDE.md` specifies.

#### 5c. Write or update tests for new behavior
If this step introduces new behavior (new function, endpoint, component, hook, or branch),
write or update a test covering it before moving to 5d — don't rely solely on whatever tests
already existed. Apply the same bar as `testing-quality.md`:
- Assert real behavior, not just that a snapshot matches or that a function was called.
- Mocks must match the real API response shape (envelope vs raw array) — copy the actual
  shape from an existing handler rather than guessing.
- If the step touches auth or another security-critical path, cover the failure path
  (rejected token, expired session, wrong role) — not just the happy path.
If the step only changes existing behavior with pre-existing coverage, and no new branch or
edge case was introduced, updating tests is optional — say so explicitly in the step summary
rather than silently skipping.

#### 5d. After each step, run relevant tests
Detect the package manager from `package.json` (`yarn`, `npm`, or `pnpm`) and run:
```bash
<pm> test <path-to-test-file> --watchAll=false   # jest
# or the test command defined in CLAUDE.md
```
If tests fail, report the failure and ask:
> "Tests failed for this step. Fix automatically, or do you want to review first?"

#### 5e. Phase boundary gate
After completing all steps in a phase, before moving to the next:
1. Run ESLint on all changed files (detect package manager from `package.json`):
   ```bash
   <pm> eslint --no-eslintrc -c .eslintrc.json --max-warnings 0 <changed files>
   ```
2. Present a phase summary: steps applied, steps skipped, and why.
3. Ask: **"Phase N complete. Proceed to Phase N+1?"** — wait for confirmation.

---

### Step 6 — Acceptance criteria verification

After all phases are complete, go through Section 9 for each ticket.
For each `[ ]` AC item, determine:

- ✅ **Covered by code change** — the relevant implementation clearly satisfies this behaviour
- ✅ **Covered by tests** — a test exists that exercises this behaviour
- 🔍 **Manual QA needed** — requires device testing, visual verification, or live API
- ❌ **Not implemented** — no code change covers this item

Print the result:
```
ACCEPTANCE CRITERIA REVIEW
===========================
PROJ-XXX
  ✅ User can select up to 25 images
  ✅ Error shown when limit exceeded
  🔍 Image order preserved after re-opening (requires device test)
  ❌ Progress indicator during upload — not yet implemented
```

For any ❌ items, ask:
> "These AC items are not covered — implement them now, or track as a follow-up?"

---

### Step 7 — Open questions gate

Re-read Section 8 (Open Questions). For any unresolved questions, flag them with context.
If a question was blocking and its step was skipped, confirm whether a follow-up ticket is needed.

---

### Step 8 — Wrap-up

Report:
- Total steps applied vs. skipped
- Files changed (list with one-line description)
- Tests added or updated
- Any steps skipped and why
- Outstanding open questions or blocked items
- Suggested next actions (device QA, BE coordination, follow-up ticket, etc.)

---

## Inconsistency signals — always stop and ask

| Signal | What to ask |
|---|---|
| Design references a file that doesn't exist | "File not found — create it, or is the path wrong?" |
| Design says modify X but X is not found | "Symbol to modify not found — already renamed, or wrong name?" |
| Design says create X but X already exists | "Component/hook already exists — update it, skip, or merge?" |
| Existing shared component could replace a new one the design proposes | "Found existing shared component that may solve this — use it instead?" |
| Design's component structure conflicts with CLAUDE.md reuse rules | "Design proposes a new component, but a shared one exists — confirm approach?" |
| Test file the design references does not exist | "Test file not found — create new file or skip?" |
| Code at the target location has diverged significantly from what the design describes | "Code has diverged from design — show diff and ask how to proceed" |
