<template>
  <figure class="architecture-diagram" aria-label="Rivet architecture flow">
    <div class="entry-paths">
      <div class="entry-path">
        <span class="path-label">From your coding harness</span>
        <div class="diagram-node">User<span>via coding harness</span></div>
        <span class="flow-arrow" aria-hidden="true">↓</span>
        <div class="diagram-node">Rivet protocols<span>Guided host workflow</span></div>
      </div>
      <div class="entry-path terminal-path">
        <span class="path-label">From your terminal</span>
        <div class="diagram-node">Terminal user<span>from your project</span></div>
        <span class="flow-arrow" aria-hidden="true">↓</span>
        <div class="diagram-node"><code>rivet run "task"</code><span>Direct CLI entry</span></div>
      </div>
    </div>
    <div class="join-arrows" aria-hidden="true"><span>↓</span><span>↓</span></div>
    <div class="diagram-node core-node">Rivet CLI</div>
    <span class="flow-arrow" aria-hidden="true">↓</span>
    <div class="diagram-node core-node">Workflow service</div>
    <div class="responsibilities" role="list" aria-label="Workflow service responsibilities">
      <div role="listitem" class="diagram-node">Private run state<span>and evidence</span></div>
      <div role="listitem" class="diagram-node">Project checks<span>and Git worktrees</span></div>
      <div role="listitem" class="diagram-node">Memory &amp; tool providers<span>Configurable</span></div>
      <div role="listitem" class="diagram-node">Delegated model execution<span>Optional</span></div>
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
.entry-paths, .join-arrows {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.entry-path { display: flex; flex-direction: column; gap: 0; }
.entry-path .diagram-node { min-height: 66px; display: flex; flex-direction: column; justify-content: center; }
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
.terminal-path code { white-space: normal; font-size: 13px; }
.responsibilities { position: relative; display: grid; gap: 10px; padding: 18px 0 0 28px; margin-left: 20px; text-align: left; }
.responsibilities::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; border-left: 1px solid var(--vp-c-text-3); }
.responsibilities .diagram-node { position: relative; padding: 10px 14px; }
.responsibilities .diagram-node::before { content: ""; position: absolute; top: 50%; left: -29px; width: 28px; border-top: 1px solid var(--vp-c-text-3); }
.responsibilities .diagram-node:last-child::before { height: 50%; background: var(--vp-c-bg-soft); }
.responsibilities .diagram-node::after { content: ""; position: absolute; top: calc(50% - 3px); left: -6px; width: 6px; height: 6px; border-top: 1px solid var(--vp-c-text-3); border-right: 1px solid var(--vp-c-text-3); transform: rotate(45deg); }
.responsibilities .diagram-node span { display: inline; margin-left: 6px; }
.core-node { border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
figcaption { margin-top: 20px; font-size: 12px; line-height: 1.7; color: var(--vp-c-text-2); }
@media (max-width: 480px) {
  .architecture-diagram { padding: 14px; }
  .entry-paths, .join-arrows { gap: 8px; }
  .diagram-node { padding: 10px 6px; font-size: 12px; }
  .terminal-path code { font-size: 11px; }
  .path-label { min-height: 36px; line-height: 18px; }
  .entry-path .diagram-node { min-height: 76px; }
  .responsibilities { margin-left: 10px; padding-left: 20px; }
  .responsibilities .diagram-node::before { left: -21px; width: 20px; }
  .responsibilities .diagram-node span { display: block; margin-left: 0; }
}
</style>
