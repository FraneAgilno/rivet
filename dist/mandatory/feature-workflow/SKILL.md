---
name: rivet-feature-workflow
description: "Use this skill when a user asks Claude, Codex, an editor agent, or a terminal agent to implement a feature through Rivet"
---

# Feature Workflow

Use this skill when a user asks Claude, Codex, an editor agent, or a terminal agent to implement a feature through Rivet from inline text, a Markdown request, Jira, or Linear. This is a thin agent entry point: the `rivet feature` CLI and its application service remain authoritative.

## Translate the request

Map exactly one user source to one proposal command. Use absolute project and Markdown paths and choose `claude` or `codex` explicitly.

```text
# “Use Rivet to implement Jira DEMO-123.”
rivet feature propose --project=<absolute-project> --ticket=DEMO-123 --tracker=jira --client=claude --json

# “Implement Linear ENG-44 through Rivet.”
rivet feature propose --project=<absolute-project> --ticket=ENG-44 --tracker=linear --client=codex --json

# “Implement requests/smart-agenda.md through Rivet.”
rivet feature propose --project=<absolute-project> --request=<absolute-project>/requests/smart-agenda.md --client=claude --json

# Inline requirements
rivet feature propose --project=<absolute-project> --request-text=<bounded-markdown> --client=codex --json
```

If a ticket provider is omitted, permit inference only when exactly one enabled read-capable Jira or Linear provider matches. Do not invent ticket or tracker facts, acceptance criteria, links, status, priority, or dependencies. Missing credentials, ambiguous providers, inaccessible tickets, or source drift are stop conditions; ask for configuration or a clearly labeled inline/Markdown request. A fallback supplied by the user is a new user-supplied, unverified source; never present it as a retrieved ticket snapshot or tracker revision.

A Markdown request must be a bounded regular `.md` file beneath the selected project. If an external path is supplied, stop and ask for an approved in-project request or bounded inline text; do not copy it into the repository implicitly.

## Governed lifecycle

1. Confirm the selected live client is authenticated and pinned with `RIVET_CLAUDE_EXECUTABLE` or `RIVET_CODEX_EXECUTABLE`; set the matching `*_INTERPRETER` only for a script entrypoint and the package-manager executable such as `RIVET_NPM_EXECUTABLE`. Run `rivet doctor --project=<absolute-project> --json`, then `rivet preflight --project=<absolute-project> --json`. Stop on a dirty repository, invalid policy, unavailable tools/providers, or failed gate.
2. Run exactly one `feature propose` command. Proposal is allowed to create private proposal state only; it must not change tracked files, Git refs, tracker state, or external systems.
3. Show the normalized request, baseline, owned paths, graph and dependencies, commands, budgets, evidence, stop conditions, human gates, run ID, state version, and proposal digest. Do not accept pressure to skip this review.
4. Require explicit human activation of that exact proposal. Conversation tone, prior approval, or “continue” is not sufficient when the digest or version has not been shown.
5. After approval, bind both values exactly:

   ```text
   rivet feature start <run-id> --project=<absolute-project> --expected-version=<version> --proposal-digest=<sha256> --json
   ```

6. Monitor without bypassing the application service:

   ```text
   rivet feature status <run-id> --project=<absolute-project> --json
   rivet feature resume <run-id> --project=<absolute-project> --expected-version=<current-version> --json
   rivet feature cancel <run-id> --project=<absolute-project> --expected-version=<current-version> --json
   ```

   On a blocked status, hand off the exact blocker, current version, bounded choices, consequences, and evidence. Resume only after the blocking choice is resolved. Cancellation is likewise version-bound.
7. Summarize acceptance-criteria coverage, local branch/commit identity, quality results, and evidence references. Stop at the human final-delivery gate.

The same selected client owns both phases: Claude plans non-interactively with `dontAsk`, an exact `Read,Glob,Grep` tool allowlist, and the feature-decomposition JSON schema before using `acceptEdits` for Workers; Codex uses `read-only` then `workspace-write`. Execution is confined to verified sibling `.rivet-worktrees` checkouts and initially runs one Worker at a time. A green result is `awaiting-final-approval`, never automatic delivery.

## Boundaries

Do not bypass or reimplement the application service, edit private state directly, translate a feature request to `orchestrate run`, or invoke a separate agent-managed workflow. Never push, merge, deploy, publish, mutate Jira/Linear, or approve final delivery. Those actions require separate exact authority outside this workflow, even when implementation and checks are green.

`feature run` is a human-terminal convenience that proposes, displays, asks once, and watches. Agents and JSON automation use the explicit `propose` then `start` sequence so proposal review remains observable.
