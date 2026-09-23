<script setup>
import ArchitectureDiagram from '../.vitepress/components/ArchitectureDiagram.vue'
</script>

# Architecture

Rivet packages a repeatable team workflow. Coding harnesses already provide editing, terminals, MCP clients, and agent tools; Rivet should reuse those capabilities and add deterministic operations where shared configuration, state, verification, or recovery needs them.

<ArchitectureDiagram />

## Independent identity

- Command: `rivet`.
- Project policy: `.rivet`.
- Runtime environment: `RIVET_*` variables.
- Private state: Rivet-owned directories under the repository's Git common directory.
- Harness skills: `rivet-` prefix.
- Package, Git history, releases, and documentation: independent of AI Engineering.

## Harnesses and models are different

A harness provides tools and an execution environment. An API or local text model does not automatically have those tools. Model adapters must declare capabilities and their actual execution status. The framework must not require a second model process simply because the active harness calls its CLI.

The feature bridge supports both spawned adapters and an active-host contract. In host mode, Rivet prepares one durable action and isolated worktree, while the current harness performs the edit. Result submission revalidates the exact action, scope, evidence, and repository changes before integration. This keeps the workflow provider-independent without treating a model registry entry as execution authority.

## Evidence

A model's success message is not a passing test. Rivet retains the imported verification and authority machinery so outcomes can be tied to repository changes and actual checks. External delivery is separate from local verification.
