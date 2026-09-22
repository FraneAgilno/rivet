# Optional Skills & Resources

Everything in this directory is optional — install what your team needs.

---

## Contents

- [`skills/`](./skills/README.md) — stack-aware prompt templates (NestJS, Django, React Native, Postgres, DevOps, QA, etc.)
- [`agents/`](./agents/README.md) — role-based prompts that combine multiple skills (Backend, Mobile, QA, Delivery, DevOps, Data/Perf)
- [`workflows/`](./workflows/) — end-to-end flows (feature delivery, bug fix, performance, incident response)
- [`templates/`](./templates/) — Jira + PR templates you can paste into tickets/PRs
- [`governance/`](./governance/) — rules, constraints, and review checklists

---

## Installation

Use the `rivet install` command to pick which optional skills to install.
Mandatory skills (in `mandatory/`) are always installed automatically — they are not listed here.

```bash
rivet install         # interactive picker — project scope
rivet install --global  # interactive picker — global scope
rivet install --all   # install everything without prompting
```
