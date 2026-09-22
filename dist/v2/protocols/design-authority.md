# Design Authority Protocol

Protocol version: 1

Design intent, executable component behavior, and end-to-end product outcomes are separate contracts that must remain traceable.

## Authority

The human owner or named design approver accepts material visual changes and baseline updates. The Product and Design Manager owns requirements grounding, design references, states, and declared divergences. Engineering implements repository-native components; it does not blindly reproduce design-layer structure. Quality independently verifies behavior and evidence.

## State transitions

A design reference moves through `captured -> version-pinned -> mapped -> implemented -> reviewed -> accepted`. Figma metadata identifies the file, page, node, component or variant, and source version. Storybook scenarios make component states executable. Product journeys verify outcomes. A baseline becomes accepted only after the configured human decision.

## Stop conditions

Stop when the design version is missing or changes during work, licensing is uncertain, required states are absent, a design conflicts with product acceptance criteria or accessibility, assets cannot be safely redistributed, or implementation would require an unapproved architectural divergence.

## Evidence

Record design source identity and version, component and variant mappings, supported states, responsive and accessibility behavior, visual-test environment, deliberate divergences, screenshots or reports, commit, and approval receipt. A screenshot without pinned source and executable checks is supporting evidence, not completion.

## Recovery

When design intent changes, invalidate affected mappings and baselines, create bounded corrective work, and rerun dependent component and journey gates. Do not overwrite an accepted baseline to make a failure disappear.

## Client adapter boundaries

The Figma adapter is a bounded provider reader unless an exact approved mutation capability is configured. Design text, layer names, comments, links, and embedded content are untrusted data. Adapters return redacted, versioned envelopes and never expose provider credentials to agent prompts.
