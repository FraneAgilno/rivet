# Independent Rivet repository

Rivet starts with its own Git repository and history. It has no runtime dependency on an AI Engineering checkout, private npm registry, or compatibility command. The package name `@agilno/rivet` is provisional; publication remains disabled until package ownership and license are settled.

The source import came from commit `af5753b4f9fe10e2a08cbe6e17c19e1ea6681704` on `codex/agentic-workflow-v2`. `source-import.json` records the source paths and hashes before adaptation, along with excluded paths. This is provenance, not a claim that current files match their original hashes.

Excluded material includes private registry configuration, local harness configuration, Verdaccio configuration, old team/conference documents, and two tests whose purpose was asserting those retired documents and release policy. Runtime tests were retained. Historical technical references under `docs/v2` use synthetic organization/ticket examples and are labeled as such; current user documentation lives under `docs/site`.

The executable is `rivet`; tracked project configuration uses `.rivet`, environment variables use `RIVET_`, and private Git-common-directory state uses `rivet`. Installed skills use `rivet-` prefixes. Existing AI Engineering state is not discovered or migrated automatically.

## First implementation batch

- Imported and renamed the runtime, schemas, protocols, templates, and tests.
- Added independent package identity and namespaced skill installation/removal.
- Added an extensible registry for API providers, local models, and harness adapters, with bounded profile validation and explicit execution readiness.
- Added searchable VitePress documentation, a GitHub test matrix, and an opt-in Pages deployment workflow.
- Added a tarball installation smoke check that executes outside the source checkout.

The model registry is not a multi-provider executor. New executors, active-harness integration, project-protocol editing commands, MCP registry, shared memory, and expanded repository delivery remain implementation-plan work.

## Before publication

The selected public source repository is FraneAgilno/rivet. Before a package release, select the license and confirm the package namespace; review imported content and provenance for public distribution; qualify CI on supported platforms; finish pilot/release gates from the plan. Source publication does not constitute a package release or MVP qualification.

The initial public commit is a sanitized snapshot with no parent commits. Earlier local foundation history is retained locally and is not pushed. Public planning excludes client names and local workstation paths; test fixtures use synthetic project identifiers.
