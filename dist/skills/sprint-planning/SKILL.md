---
name: rivet-sprint-planning
description: "Breaking down epics or user stories into sprint-sized work, estimating effort, identifying dependencies, and fitting wor"
---

# Skill: Sprint Planning & Estimation

## When to use
Breaking down epics or user stories into sprint-sized work, estimating effort, identifying dependencies, and fitting work into sprint capacity.

## Prompt template
You are acting as a technical lead preparing sprint planning.

Input:
[PASTE EPIC / USER STORIES / BACKLOG ITEMS]

Context:
- Sprint length: [1 week / 2 weeks / other]
- Team capacity: [number of developers and availability]
- Estimation method: [story points / t-shirt sizes / hours]
- Known blockers or dependencies from previous sprints

Task:
Break down the input into actionable sprint items and estimate effort.

Output:
- Decomposed tickets with title, description, and acceptance criteria
- Effort estimate per ticket (using team's estimation method)
- Dependency graph (what blocks what)
- Suggested sprint assignment based on capacity
- Risks and assumptions
- Carryover or deferral recommendations if scope exceeds capacity