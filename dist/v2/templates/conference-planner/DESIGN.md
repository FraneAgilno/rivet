# Conference Planner Design System

This is an original Agilno design system. Its review process is Impeccable-guided, but its tokens, components, documentation, and implementation are owned and maintained in this repository. No external design runtime is required to build, test, or use the application.

## Product mode

Operate. The interface helps an attendee scan sessions, understand schedule conflicts, and make a deliberate agenda choice quickly. Clarity and reliable interaction take priority over decoration.

## Design principles

- Make the current task and consequence obvious.
- Use one clear visual hierarchy instead of nested decorative containers.
- Prefer calm surfaces, sharp copy, and restrained motion.
- Represent success, error, disabled, loading, and conflict states explicitly.
- Keep interaction patterns predictable across pointer, keyboard, and touch input.
- Let content determine component height; never hide important text to preserve symmetry.

## Tokens

`src/styles/tokens.css` is the semantic source of truth. Components consume purpose-named variables for canvas, surface, text, border, action, focus, status, spacing, radius, shadow, motion, width, and touch targets.

New raw color, spacing, radius, shadow, or timing values require a semantic token first. Status colors must retain readable text and must not be the only signal communicating meaning.

## Component contracts

### Button

Buttons expose default, hover, focus, pressed, disabled, and loading states. Loading preserves the accessible name and prevents duplicate action. Focus remains visible against every surface.

### SessionCard

Session cards expose default, selected, disabled, loading, success, error, hover, focus, content-boundary, and desktop states. Session identity, time, room, and agenda state remain readable without relying on color alone.

### ConflictDialog

The conflict dialog exposes default, resolving, content-boundary, and desktop states. It is a modal decision boundary: focus enters the dialog, remains contained through resolution, and returns to the initiating control or a safe document fallback when the dialog closes.

## Accessibility and interaction

- Meet WCAG 2.1 AA for documented component states.
- Preserve semantic elements and accessible names before adding ARIA.
- Support full keyboard operation and visible focus.
- Respect reduced-motion preferences.
- Keep interactive targets at least `--touch-target-min`.
- Storybook is the manual component inspection surface.
- Playwright and axe-core are the sole automated browser accessibility owners to avoid overlapping scans.

## Responsive behavior

The mobile contract is 320 × 800 and the desktop contract is 1280 × 800. Layouts must remain usable between those boundaries without horizontal page scrolling. Components reflow according to available space rather than user-agent detection.

## Design review workflow

Use four explicit passes and record material decisions in the change:

1. **Audit** — find hierarchy, accessibility, interaction, content-boundary, and consistency defects.
2. **Polish** — improve alignment, rhythm, state clarity, and finishing details without changing product intent.
3. **Typeset** — verify readable measure, hierarchy, density, labels, and wrapping with realistic content.
4. **Distill** — remove redundant decoration, controls, copy, and containers until each remaining element serves the task.

Finish with unit tests, Storybook build, the complete Storybook Playwright matrix, application build, and a human visual review. Automated checks cannot approve a visual baseline; `design/design-system-manifest.json` remains pending until that review is recorded truthfully.

## Anti-patterns

- Decorative gradients, glass effects, or animation without product meaning.
- Cards nested inside cards merely to create visual complexity.
- Excessive rounding that erases component hierarchy.
- Placeholder copy used to make a layout look balanced.
- Hover-only information or interaction.
- Focus suppression, silent loading, or color-only status.
- Fabricated external design references, approvals, or visual-baseline claims.
