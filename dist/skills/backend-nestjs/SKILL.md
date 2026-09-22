---
name: rivet-backend-nestjs
description: "For implementing or extending NestJS services (REST or GraphQL), controllers/resolvers, DTO validation, modules, and int"
---

# Skill: Backend (NestJS)

## When to use
For implementing or extending NestJS services (REST or GraphQL), controllers/resolvers, DTO validation, modules, and integration patterns.

## What to provide
- Framework version (if relevant)
- Transport (REST / GraphQL)
- Auth strategy (JWT, sessions, etc.)
- DB access layer (Prisma/TypeORM/knex) and conventions
- Error handling conventions
- Any existing module structure

## Prompt template
You are acting as a senior NestJS backend engineer.

Context:
- Codebase uses NestJS with TypeScript
- Follow existing module boundaries and naming conventions
- Prefer DTO validation (class-validator / zod / existing standard)
- Keep APIs backward compatible unless explicitly instructed
- Include structured error responses

Task:
[DESCRIBE THE BACKEND TASK]

Constraints:
- [LIST CONSTRAINTS: perf, security, no breaking changes, etc.]

Output:
- Proposed approach (short)
- Code: modules/controllers/services/DTOs
- Edge cases and error handling
- Notes on config/env and migrations if relevant

---

## NestJS Common Pitfalls (enforce these in every task)

### DTOs & Validation
- **Never use inline TypeScript types on `@Body()`** — `@Body() body: { name?: string }` is erased at runtime. `ValidationPipe({ whitelist: true })` cannot strip/reject fields without class-validator decorators. Always create a DTO class.
- **`ParseUUIDPipe` on all `:id` params** — `@Param('id', ParseUUIDPipe)` rejects malformed UUIDs as 400 before they reach the DB layer.
- **`@IsUUID()` on UUID fields in DTOs** — `@IsString()` alone accepts any string; use `@IsUUID()` for FK/reference fields.
- **`@HttpCode` on every mutating endpoint** — POST → `201`, DELETE/action endpoints → `200`. NestJS defaults POST to 200, which is wrong.

### Module Architecture
- **Explicit module imports, not `@Global()`** — only infrastructure modules (Prisma, Config) should be `@Global()`. Business modules must declare their dependencies in `imports[]`. Invisible global dependencies break at runtime if `@Global()` is ever removed.
- **No duplicate class names across modules** — two `CreateTenantDto` with different fields cause silent bugs when imported from the wrong path. Prefix admin variants: `AdminCreateTenantDto`.
- **No dead code modules** — modules that are never imported in `AppModule` or any other module should be deleted, not left as dead `@Global()` exports.

### State Management
- **No mutable singleton state in services** — methods like `setApiKey(key)` that mutate `this.apiKey` race under concurrent requests. Pass secrets as parameters instead.
- **Controller-level Maps need lifecycle cleanup** — if a controller holds Maps (rate limiting, connection tracking), implement `OnModuleDestroy` and clean up entries to prevent memory leaks.

### Response Format
- **All endpoints return `{ success: true, data }` envelope** — auth token endpoints (login/register) may return flat structure for client compatibility, but all other endpoints must wrap responses.

### Logging
- **Audit log field names must match JWT payload** — if `JwtStrategy` returns `{ id, tenantId, email }`, use `user?.id` not `user?.userId`. A field name mismatch silently produces `null` in all audit entries.
- **No PII in log messages** — use generic messages for missing-account scenarios. Log `"password reset for non-existent account"`, not `"password reset for ${email}"`.
