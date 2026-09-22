> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Conference Planner Local Demonstration

## What it proves

The original implementation plan contains Tasks 0–22. Tasks 0–18 built the platform and private Conference Planner acceptance proof. Revised Tasks 19–22 close the locally executable release work without cloud hosting or an external design provider.

The local graph has one Boss, product/delivery/quality Managers, three initially parallel Worker lanes, integration fan-in, an acceptance step, one controlled corrective focus-restoration path, evidence assembly, and an unfulfilled human final-delivery gate.

The corrective rehearsal uses the real scheduler and orchestrator with the deterministic fake client. Its first result requests one retry and the second returns exact evidence. This is simulated runtime evidence, not a live model claim.

## Application evidence

The canonical application is in a private Bitbucket repository. Bitbucket Pipeline #1 was observed successful for the Task 18 acceptance change. A fresh fetch verified pull request #1 in private `main` at merge commit `f700ddc08790c2d01ceb17bfb82f77658bcdd234`; the exact merged checkout passed the local quality, browser, Storybook, audit, and evidence gates. There is no hosted URL and no durable cloud retention claim.

## Run locally

```bash
node --test test/demo/conference-graph.test.js
node --test test/demo/checkpoints.test.js test/demo/reset.test.js
```

Use `demo/conference/RUNBOOK.md` for the timed presentation and `demo/conference/RECOVERY.md` for the 30-second fallback rule. Fixture, checkpoint, and recording modes must display their provenance. The generic feature CLI now supports live Claude and Codex; the original graph rehearsal remains a separate labeled fake-client proof.

## 10–15 minute the presenter walkthrough

The event can still be 60 minutes; this recording is only the short setup and operating handoff.

1. **Setup (2 minutes).** Show the separate private Bitbucket checkouts. In `rivet`, check out `codex/agentic-workflow-v2`, run `npm ci`, and define `rivet() { node "$RIVET_REPO/bin/cli.js" "$@"; }` with `RIVET_REPO` set to that clone. Verify `rivet --help`; do not rely on an older global npm binary. Then run `rivet install --all --target=both` and review Conference Planner's exact four `.rivet` files.
2. **Client pinning (1 minute).** Show either `RIVET_CLAUDE_EXECUTABLE` plus optional `RIVET_CLAUDE_INTERPRETER`, or the corresponding Codex variables. Explain Claude's `dontAsk` + `Read,Glob,Grep` + JSON-schema planning boundary followed by `acceptEdits` and an exact Worker-result schema, and Codex `read-only`/`workspace-write`. For Claude, name the fixed `claude-bounded-sonnet-v1` policy: Sonnet, low-effort planning, 120 seconds, USD 1 planning, USD 2 per execution, and no fallback. Show the owner-controlled `RIVET_NPM_EXECUTABLE` quality runner.
3. **Feature request (2 minutes).** Use a reviewed Conference Planner Markdown request, or a Jira/Linear ticket ID when the read-only provider is connected. Run `rivet doctor`, `rivet preflight`, then `rivet feature propose`. Explain that Markdown, Jira, and Linear normalize into the same immutable request contract. The selected client proposes only objectives, owned paths, and acceptance-criterion allocation; Rivet constructs every policy-sensitive plan field deterministically.
4. **Proposal (2 minutes).** Read `featurePlan.clientProfile` first, then the baseline, owned paths, Worker objective, host-bound commands, budgets, evidence, activation gate, run ID, version, and digest. State explicitly that the digest binds the Sonnet model and provider ceilings, planning has not changed application code or refs, and the model did not choose its own authority.
5. **Activation and Worker (3 minutes).** Approve the exact digest/version, run `feature start`, then `feature resume`. Show the sibling `.rivet-worktrees` integration checkout. Explain that one Worker at a time starts from the current integration tip and the same selected client implements only its owned paths. If a Worker is blocked, show `feature status`: a version-bound resume can continue one exact active checkout after verifying its lease, identity, base, and changed-path scope, while consuming the normal retry budget.
6. **Quality and evidence (2 minutes).** Show the configured gates, integrated local commit, runtime/evidence references, unchanged Conference `main`, and unchanged Bitbucket refs.
7. **Final boundary (1 minute).** Show `awaiting-final-approval`. Say: “The workflow has implemented and verified the feature locally. It has not pushed, merged, deployed, published, changed Jira/Linear, or approved final delivery.”
8. **Questions/fallback (up to 2 minutes).** Use `feature status` first. Preserve a blocked Worker's checkout; never delete private state or reset its files. Resume only with the current version after correcting the reported condition. If exact safe reuse is rejected or live execution remains blocked, show the already verified fixture/checkpoint path and label it clearly; offer a follow-up meeting for the presenter's questions.

Recording order is therefore setup → proposal → activation → Worker → quality → final human stop. Do not spend the recording explaining every internal module.

## Human boundary

The tooling does not create a recording, approve the visual baseline, grant final delivery, provision hosting, publish npm, or merge the v2 branch. The checklist retains those facts as unchecked reminders.
