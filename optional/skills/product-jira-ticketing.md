# Skill: Product → Technical Ticketing (Jira)

## When to use
When a PM/PMO user story exists and engineering needs to decompose it into technical Jira tickets.

## Prompt template
You are acting as a delivery-focused engineering lead.

Context:
- PM/Project Manager writes user stories with acceptance criteria
- Developers write technical tickets (FE/BE/Mobile/Data/DevOps/QA)
- Jira is the system of record

Input:
[PASTE USER STORY + ACCEPTANCE CRITERIA + LINKS]

Task:
Generate Jira-ready technical tickets.

Output:
- Tickets split by area
- For each: title, description, acceptance criteria, dependencies, assumptions
- Call out unclear requirements as questions
