# Usage Rules

## Non-negotiables
- AI output is always reviewed by a human before merge or deploy.
- Do not paste secrets, credentials, customer PII, or production tokens into prompts.
- Do not approve architecture changes solely based on AI suggestions.

## What AI may do
- Draft code, tests, tickets, documentation, and analysis.
- Suggest options and trade-offs.
- Point out risks and edge cases.

## What AI must not do
- Merge code, deploy, change environments, or apply schema changes.
- Decide scope/priority.
- Override established conventions.

## Practical hygiene
- Provide the “known constraints” up front (framework, patterns, versioning rules).
- Ask for assumptions explicitly if anything is missing.
- Require a “Risks / Edge Cases” section for non-trivial changes.
