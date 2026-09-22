# PR Review Rules

Use this checklist when reviewing pull requests. Flag any violations with specific file:line references.

---

## Files to Ignore

Skip these files during review (auto-generated or dependency files):
- `package.json` (only review scripts section if relevant)
- `package-lock.json`
- `yarn.lock`
- `pnpm-lock.yaml`
- Auto-generated type files

---

## Code Quality

- [ ] No commented-out code blocks without some explanation above it
- [ ] Functions/methods are focused and not excessively long (< 80 lines preferred)
- [ ] No magic numbers or strings - use named constants
- [ ] No duplicate code - extract shared logic into utilities
- [ ] Error handling is present where needed
- [ ] Do not redo functions or components that already exist in the project. Reuse the existing ones if possible.

---

## React Specific

- [ ] Components have proper TypeScript types/interfaces for props
- [ ] `useEffect` has correct and complete dependency arrays
- [ ] `useEffect` has comment explanation where needed
- [ ] No missing `key` props in lists/maps
- [ ] Event handlers are properly typed
- [ ] Custom hooks follow the `use` prefix convention
- [ ] No state updates on unmounted components (cleanup in useEffect)
- [ ] Memoization (`useMemo`, `useCallback`) used appropriately for expensive operations

---

## TypeScript

- [ ] No `any` types - use proper typing or `unknown`
- [ ] Interfaces/types are properly defined for data structures
- [ ] Enums or union types used for fixed sets of values

---

## Security

- [ ] No sensitive data (API keys, secrets) hardcoded
- [ ] User input is validated/sanitized
- [ ] No XSS vulnerabilities (dangerouslySetInnerHTML usage reviewed)

---

## Performance

- [ ] No unnecessary re-renders (check prop drilling, context usage)
- [ ] Large data sets use pagination or virtualization
- [ ] Images are optimized and lazy-loaded where appropriate
- [ ] No expensive operations in render path

---

## Naming Conventions

- [ ] Clear, descriptive variable and function names
- [ ] Files use kebab-case
- [ ] Components use PascalCase
- [ ] Hooks start with `use`
- [ ] Constants use UPPER_SNAKE_CASE
- [ ] Boolean variables use `is`, `has`, `should` prefixes

