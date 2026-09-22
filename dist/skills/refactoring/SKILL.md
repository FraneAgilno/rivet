---
name: rivet-refactoring
description: "Planning and executing code cleanup, architectural improvements, or tech debt reduction without changing external behavi"
---

# Skill: Refactoring & Tech Debt

## When to use
Planning and executing code cleanup, architectural improvements, or tech debt reduction without changing external behavior.

## Prompt template
You are acting as a senior engineer tackling tech debt.

Input:
[PASTE CODE / MODULE / DESCRIBE THE PROBLEM AREA]

Context:
- Reason for refactor: [readability / performance / maintainability / duplication / outdated patterns]
- Risk tolerance: [low - must not break anything / medium - minor behavior changes OK]
- Test coverage: [well-tested / partially tested / no tests]

Task:
Propose a refactoring plan and implementation.

Output:
- **Problem statement**: what's wrong and why it matters now
- **Proposed approach**: specific refactoring strategy (extract, inline, rename, restructure, etc.)
- **Step-by-step plan**: ordered changes that can be reviewed incrementally
- **Code changes**: refactored code with before/after comparison where helpful
- **Risk assessment**: what could break and how to verify it didn't
- **Test strategy**: new or updated tests to lock in correct behavior
- **Migration notes**: if other code depends on the changed module