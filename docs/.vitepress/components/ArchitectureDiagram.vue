<template>
  <figure class="architecture-diagram" aria-label="Rivet architecture flow">
    <div class="entry-paths">
      <div class="entry-path">
        <span class="path-label">From your coding harness</span>
        <div class="diagram-node">User</div>
        <span class="flow-arrow" aria-hidden="true">↓</span>
        <div class="diagram-node">Coding harness</div>
        <span class="flow-arrow" aria-hidden="true">↓</span>
        <div class="diagram-node">Rivet protocols</div>
      </div>
      <div class="entry-path terminal-path">
        <span class="path-label">From your terminal</span>
        <div class="diagram-node">Terminal user</div>
        <code>rivet run "task"</code>
        <span class="path-note">Direct CLI entry</span>
      </div>
    </div>
    <div class="join-arrows" aria-hidden="true"><span>↓</span><span>↓</span></div>
    <div class="diagram-node core-node">Rivet CLI</div>
    <span class="flow-arrow" aria-hidden="true">↓</span>
    <div class="diagram-node core-node">Workflow service</div>
    <span class="flow-arrow" aria-hidden="true">↓</span>
    <div class="responsibilities">
      <div class="diagram-node">Private run state<span>and evidence</span></div>
      <div class="diagram-node">Project checks<span>and Git worktrees</span></div>
      <div class="diagram-node">Memory &amp; tool providers<span>Configurable</span></div>
      <div class="diagram-node">Delegated model execution<span>Optional</span></div>
    </div>
    <figcaption>Both entry paths use the same CLI and workflow service. Provider availability varies; see <a href="./integrations.html">integrations</a> and <a href="./models.html">models</a>.</figcaption>
  </figure>
</template>

<style scoped>
.architecture-diagram {
  margin: 28px 0;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  text-align: center;
}
.entry-paths, .join-arrows, .responsibilities {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.entry-path { display: flex; flex-direction: column; gap: 0; }
.path-label { margin-bottom: 12px; font-size: 12px; font-weight: 600; color: var(--vp-c-text-2); }
.diagram-node {
  padding: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.diagram-node span { display: block; font-weight: 400; color: var(--vp-c-text-2); }
.flow-arrow, .join-arrows { display: block; color: var(--vp-c-text-2); line-height: 30px; }
.join-arrows { display: grid; }
.terminal-path code { margin: auto 0; padding: 10px 4px; white-space: normal; font-size: 13px; }
.path-note { font-size: 12px; color: var(--vp-c-text-2); }
.core-node { border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
figcaption { margin-top: 20px; font-size: 12px; line-height: 1.7; color: var(--vp-c-text-2); }
@media (max-width: 480px) {
  .architecture-diagram { padding: 14px; }
  .entry-paths, .join-arrows, .responsibilities { gap: 8px; }
  .diagram-node { padding: 10px 6px; font-size: 12px; }
  .terminal-path code { font-size: 11px; }
  .responsibilities { grid-template-columns: 1fr; }
}
</style>
