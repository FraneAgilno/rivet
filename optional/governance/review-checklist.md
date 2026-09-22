# Human Review Checklist

Use this checklist when copying AI output into tickets, code, or docs.

## Code
- [ ] Matches repository conventions (structure, naming, lint rules)
- [ ] Handles validation, errors, and edge cases
- [ ] No security regressions (authz, input handling, data exposure)
- [ ] No accidental breaking API changes
- [ ] Observability included where appropriate (logs/metrics)

## Tests
- [ ] Includes happy path + failure cases
- [ ] Deterministic (no flaky timers, unstable external deps)
- [ ] Adds regression coverage for bug fixes

## Jira tickets
- [ ] Clear acceptance criteria
- [ ] Dependencies and assumptions listed
- [ ] Split by ownership boundaries (FE/BE/Mobile/Data/DevOps/QA)

## Docs
- [ ] Reflects real behavior (not aspirational)
- [ ] Includes runbook updates if ops behavior changed
