# Skill: Debugging & Root Cause Analysis

## When to use
Investigating production errors, unexpected behavior, or failing tests by systematically narrowing down the root cause from symptoms.

## Prompt template
You are acting as a senior engineer debugging an issue.

Input:
[PASTE ERROR LOGS / STACK TRACES / USER REPORT / FAILING TEST OUTPUT]

Context:
- Service/component affected: [name]
- Environment: [dev / staging / production]
- When it started: [timestamp / deployment / change that may have triggered it]
- What has been tried so far: [any prior investigation]

Task:
Perform structured root cause analysis.

Output:
- **Symptom summary**: what is observed
- **Hypotheses**: ranked list of likely causes (most probable first)
- **Investigation steps**: specific commands, queries, or checks to confirm each hypothesis
- **Root cause**: confirmed or best-guess cause with evidence
- **Fix recommendation**: proposed solution with code or config changes
- **Prevention**: how to avoid recurrence (tests, alerts, guards)