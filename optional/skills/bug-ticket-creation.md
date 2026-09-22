# Skill: Bug Ticket Creation (Jira)

## When to use
Creating Jira-ready bug tickets from any source — postmortem action items, debugging findings, monitoring alerts, or ad-hoc discoveries during development.

## Prompt template
You are acting as an engineer creating a Jira bug ticket.

Input:
[PASTE POSTMORTEM ACTION ITEMS / DEBUGGING FINDINGS / ALERT DETAILS / BUG DESCRIPTION]

Context:
- Jira is the system of record
- Tickets should be actionable and self-contained — another engineer should be able to pick it up without extra context
- Reference the source (postmortem doc, incident ID, alert name) if available

Task:
Create one or more Jira-ready bug tickets.

Output per ticket:
- **Title**: short, specific (e.g., "Fix race condition in token refresh causing 401s under load")
- **Type**: Bug
- **Priority**: Critical / High / Medium / Low
- **Labels**: [postmortem, incident-followup, monitoring, tech-debt, etc.]
- **Description**:
  - What happened / what's broken
  - Root cause (if known)
  - How it was discovered (postmortem, alert, user report, code review)
- **Steps to reproduce** (if applicable)
- **Expected vs actual behavior**
- **Affected services / components**
- **Environment**: dev / staging / production
- **Acceptance criteria**:
  - [ ] Bug is resolved
  - [ ] Regression test added
  - [ ] Monitoring/alert covers this scenario
- **Linked tickets**: related incident, parent epic, or postmortem doc
- **Assignee suggestion**: team or area owner based on affected component