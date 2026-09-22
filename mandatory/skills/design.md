# Design

Write a design document for a Jira ticket before any code is written.
Works for FE, BE, or full-stack tickets on any project.

## Usage

```
/design <TICKET_ID>
```

Example: `/design PROJ-123`

---

## Instructions

### Step 0 — Read project conventions

Read `CLAUDE.md` at the repo root. Extract and hold in memory:
- Naming conventions
- TypeScript rules, component reuse rules, styling rules
- Patterns to follow and patterns to avoid
- Any stack-specific constraints
- Sensitive Areas (auth, payments, PII) — needed to answer the Security & Access Control
  questions in Step 2

These will be enforced in Section 7 of the design doc.

---

### Step 1 — Parallel research (run all simultaneously)

**1a. Fetch the primary ticket**

Use `mcp__claude_ai_Atlassian__getJiraIssue` with the provided ticket ID.

Extract:
- `fields.summary` — title
- `fields.description` — full description including any URLs
- `fields.issuelinks` — all linked tickets
- `fields.attachment` — attached files
- Any URLs in the description (figma.com, confluence, notion, etc.)

**1b. Fetch all linked tickets**

Use `mcp__claude_ai_Atlassian__getJiraIssue` for each linked ticket ID in parallel.
Prioritize tickets marked IMPLEMENTS, BLOCKS, RELATES TO, or CLONES.
Extract summary, description, AC, and any further URLs from each.

**1c. Explore the codebase**

Spawn an Explore subagent with a prompt tailored to the ticket topic:

> Search for all code relevant to [TOPIC FROM TICKET]. Find:
> (1) existing components, screens, or modules that implement the described behaviour or would be modified,
> (2) shared components in src/shared/ that are relevant or could be reused,
> (3) existing types, constants, or state hooks related to this feature,
> (4) existing tests for any of the above.
> Return file paths, component/function names, and a one-line description of each.

**1d. Explore linked design and documentation files**

Collect all URLs found across the primary ticket and all linked tickets. Then for each:

- **Figma URLs** (figma.com):
  - Fetch using `mcp__claude_ai_Figma__get_design_context` (primary) and `mcp__claude_ai_Figma__get_screenshot` for visual reference. Use `mcp__claude_ai_Figma__get_metadata` for component/layer names if needed.
  - Extract: screen names, component names, user flow annotations, any noted interactions
  - If Figma MCP is unavailable or returns an error, note the URL and inform the user:
    > "Figma MCP is not configured or could not access this file. Share screenshots or describe the design for full context."

- **Confluence URLs**:
  - Fetch using `mcp__claude_ai_Atlassian__getConfluencePage` or equivalent
  - Extract any relevant specs, decisions, or background context

- **Other URLs** (Notion, Google Docs, etc.):
  - Attempt to fetch with WebFetch if publicly accessible
  - If not accessible, note the URL and ask the user to paste the relevant content

---

### Step 2 — Synthesize before asking questions

After Step 1, identify what is already known from tickets, code, and designs.
Only ask questions that genuinely cannot be answered from gathered context.
Group all unknown questions in a single message — never ask one at a time.

Questions to evaluate (skip if already answered by research):

**Scope & Behaviour**
- What is the entry point / trigger for this feature?
- Are there edge cases or failure modes the ticket doesn't mention?
- Are there states to handle: empty, loading, error, offline?

**UI & Design**
- Are there designs not yet linked in the ticket?
- Are there interaction details not covered in Figma (animations, transitions, gestures)?
- Are there responsive/device-size considerations?

**Data & API**
- What API endpoints are involved? Already built or pending BE work?
- What are the request/response shapes (if not in a linked BE ticket)?
- Are there any data transformation or mapping requirements?

**Security & Access Control**
- Does this introduce or change any auth/authorization boundary (new role, permission
  level, or who can access what)?
- Does this touch PII or other data listed in `CLAUDE.md`'s Sensitive Areas section?
- Are there rate-limiting or abuse-prevention needs (new public-facing endpoint, form
  submission, or search)?

**Navigation** *(skip for BE-only tickets)*
- What screen/page does this flow from and to?
- Are there deep link, back-navigation, or tab state requirements? (mobile)
- Are there routing, redirect, or URL parameter requirements? (web)

**Testing**
- What level of testing is expected: unit only, unit + integration, or E2E?

**Constraints**
- Performance expectations (list size, pagination, image loading)?
- Backwards compatibility with existing navigation state or persisted data?

---

### Step 3 — Write the design doc

Using all gathered context, write the full design document.

**File location:** `design_docs/<TICKET_ID>-<kebab-case-title>.md`

If `design_docs/` does not exist, create it.

---

#### Standard template (single ticket)

```markdown
# Feature Design: [TICKET_ID] — [Feature Title]

## Summary
[1–3 sentences: what this ticket implements and why it matters to the user.]

---

## 1. Goal
[2–5 sentences focused on the user/product "why", not the technical "how".]

---

## 2. Functional Requirements
- **FR1:** [Observable, testable behaviour — what the user can do or see]
- **FR2:**
...

---

## 3. Non-Functional Requirements
- **NFR1:** [Performance, accessibility, error handling, offline behaviour, security/access control, etc.]
...

---

## 4. Out of Scope
- [What this ticket explicitly does NOT include]
...

---

## 5. Context & Background

| Field | Details |
|---|---|
| Ticket(s) | |
| Linked tickets | |
| Related screens / modules | |
| Design files | |
| API / BE dependencies | |

---

## 6. Design & Flow

### User Flow
[Step-by-step: what the user sees and does, from entry point to exit]

### Screen / Component Map
| Screen / Component | File path | New or existing | Notes |
|---|---|---|---|

### Data Model
| Field | Type | Source (API / local state / form) | Notes |
|---|---|---|---|

### API Calls
| Endpoint | Method | When called | Notes |
|---|---|---|---|

---

## 7. Implementation Steps

### Step 1 — [What] — `path/to/file.tsx`
[What to add/change and why. Reference specific component/function names from the Explore results.]
[Note which CLAUDE.md conventions apply — naming, tokens, reuse, etc.]

### Step 2 — [What] — `path/to/file.ts`
...

---

## 8. Open Questions
- **Q1:**
...

---

## 9. Acceptance Criteria
- [ ] ...
- [ ] ...
```

---

#### Extended template (multiple tickets)

Use this when the design spans 2 or more tickets.

```markdown
# Feature Design: [UMBRELLA_ID] — [Feature Title]

## Summary
[1–3 sentences covering all tickets and their shared user-facing goal.]

---

## 0. Ticket Inventory

| Ticket | Title | Type | Depends on |
|---|---|---|---|
| PROJ-XXX | ... | FE / BE / Design | — |
| PROJ-YYY | ... | FE | PROJ-XXX |

### Implementation Order
- **Phase 1 (parallel):** PROJ-XXX, PROJ-YYY — [why they can run in parallel]
- **Phase 2:** PROJ-ZZZ — depends on Phase 1

---

## 1. Goal
...

## 2. Functional Requirements

### PROJ-XXX — [Short title]
- **FR1:** ...

### PROJ-YYY — [Short title]
- **FR2:** ...

## 3–5. [Same as standard template]

## 6. Design & Flow
[Unified flow showing where each ticket's changes fit]

## 7. Implementation Steps

### PROJ-XXX — [Short title]
#### Step 1 — `path/to/file.tsx`
...

### PROJ-YYY — [Short title]
#### Step 1 — `path/to/file.tsx`
...

## 8. Open Questions
- **Q1 [PROJ-XXX]:** ...
- **Q2 [PROJ-YYY]:** ...

## 9. Acceptance Criteria

### PROJ-XXX
- [ ] ...

### PROJ-YYY
- [ ] ...
```

---

### Step 4 — Ask about open questions

After writing the doc, ask the user:
1. Are any items in Section 8 blocking — need to be resolved before implementation starts?
2. Do the Acceptance Criteria in Section 9 look complete?

---

## Inconsistency signals — always stop and ask

| Signal | What to ask |
|---|---|
| Figma URL is inaccessible or MCP returns an error | "Figma MCP could not access this file — share screenshots or describe the design to continue." |
| Linked ticket not found or returns an error | "Could not fetch [TICKET-ID] — skip it, or paste the relevant details?" |
| Ticket has no acceptance criteria | "No AC found in the ticket — describe expected behaviour, or should I infer from the description?" |
| Codebase search returns no results for the feature area | "No existing code found for this feature — confirm it's net-new, or is it under a different name?" |
| Multiple tickets with unclear dependency order | "Ticket dependency order is ambiguous — which should be implemented first?" |
