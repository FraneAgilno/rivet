---
name: rivet-testing-quality
description: "Generating test plans or tests for backend/mobile/web; defining coverage and edge cases."
---

# Skill: Testing & Quality

## When to use
Generating test plans or tests for backend/mobile/web; defining coverage and edge cases.

## Prompt template
You are acting as a QA automation engineer.

Context:
- Backend tests: [Jest / Supertest / other]
- Mobile tests: [Jest / Detox / other]
- CI expectations: fast and deterministic

Task:
[DESCRIBE FEATURE OR BUG FIX TO TEST]

Output:

- Test plan (unit vs integration vs e2e)
- Example tests (where feasible)
- Fixtures/mocks guidance
- Edge cases checklist

---

## Common Testing Pitfalls

### Mock handlers must match the real API shape

Test mocks that return a different shape than the real API hide integration bugs that only surface in production.

- If the real endpoint returns `{ success: true, data: [...] }`, the mock must return that exact envelope — not a raw array.
- If an endpoint path changes (e.g., `/v1/actions` → `/v1/assistant/history`), update mock route patterns immediately. Stale patterns match nothing and tests pass vacuously.
- Audit mock files when the real API contract changes — treat mock drift as a bug, not a low-priority cleanup.

### Auth service tests must cover security-critical flows

Happy-path login/register tests are not sufficient. Cover the paths that matter for security:

- **Refresh token rotation** — after refresh, the old token must be rejected (not just the new one issued).
- **Token reuse detection** — presenting a previously-used refresh token must invalidate the entire token family, not just return a 401.
- **Password reset token hashing** — the token stored in the DB must differ from the token in the email link.
- **Rate limiting** — exceeding the limit must return 429, not silently succeed.

### Frontend hook tests must verify envelope unwrapping

React Query hooks that call `api<T>()` must be tested for how they handle the response envelope:

- Verify the hook returns `res.data` (unwrapped), not the raw `{ success, data }` object.
- Test the fallback: if the API returns a raw array instead of an envelope (backward compatibility), the hook must still work.
- Test the empty case: `data: null` or `data: []` must not throw.

### Test file placement and tooling

- **NestJS (Jest):** spec files co-located with source (`auth.service.spec.ts` next to `auth.service.ts`). Mock Prisma with `jest.fn()` — do not use real DB in unit tests, but do use real DB in integration tests.
- **Frontend (Vitest):** files in `src/lib/__tests__/` or co-located. Use `vi.fn()` for fetch mocks; test with `jsdom` environment.
- **E2E (Playwright):** page objects in `tests/pages/`, mocks in `tests/mocks/`. Auth state persisted via `storageState` — set up once in a global setup file, not repeated per test.
