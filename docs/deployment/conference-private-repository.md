# Conference Planner Private Repository

## Current boundary

The canonical Conference Planner application is maintained in the private Bitbucket repository `_agilno/conference-planner`. It is separate from `rivet`: application code, application history, acceptance tests, and Bitbucket Pipelines remain in that repository, while the orchestration runtime and local demonstration material remain here.

On 2026-08-27, pull request #1 carried the Task 18 acceptance-evidence work. Pipeline #1 was observed as a successful verification run covering installation, audit, secret scanning, lint, type checking, unit tests, Storybook, browser tests, the Next.js build, application end-to-end tests, and evidence generation. A fresh Bitbucket fetch verified that private `main` is merge commit `f700ddc08790c2d01ceb17bfb82f77658bcdd234` and contains the pull-request head.

These are operator-observed facts, not remote attestations stored by this package. The merge and pipeline result are not a deployment and no hosted application URL is claimed. Repository visibility remains private.

## Ownership

The application repository owns:

- application implementation and application-only dependencies;
- the provider-independent local design contract;
- Bitbucket Pipelines configuration;
- application acceptance mappings and machine reports;
- deterministic application evidence generation.

`rivet` owns:

- orchestration protocols, schemas, roles, and runtime;
- the noncanonical starter snapshot used by `demo create`, including its verification-only Bitbucket Pipeline, which does not deploy;
- fake-client and fixture-based conference rehearsals;
- local checkpoint, reset, recovery, and release documentation.

The starter snapshot does not synchronize automatically with the canonical application. Application commits are not silently copied between repositories. A future template refresh must name the source commit, copy an allowlisted tree, rebuild the packaged template, and pass both repositories' checks.

## Verification reminder

Before relying on a later application revision, an operator must confirm its private Bitbucket commit, successful Pipeline result, clean checkout, dependency audit, acceptance evidence checksum, and repository visibility. A merged pull request alone does not establish deployment or durable evidence retention.
