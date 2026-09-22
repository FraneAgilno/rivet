# Security Review

Audit code, APIs, or infrastructure for security vulnerabilities — authentication flaws,
injection risks, data exposure, and OWASP Top 10 issues. Runs standalone on demand, and is
also auto-invoked by `/pre-push` and `/review-pr` whenever a diff touches an auth, payment,
or user-data path.

## Usage

```
/security-review
/security-review <path, file glob, or diff range>
```

With no argument, review the current diff against the default branch. `/pre-push` and
`/review-pr` invoke this skill's checklist inline against their own diff — they do not shell
out to a separate `/security-review` call, but the checklist below is the shared source of
truth both use.

---

## Instructions

1. Determine scope:
   - Explicit path/glob argument → review those files.
   - Diff range argument → review the diff.
   - No argument → `git diff origin/<default-branch>...HEAD`.
   - Invoked internally by `/pre-push` or `/review-pr` → scope is whatever files/diff the
     caller already flagged as touching a sensitive path.

2. Identify context needed to apply the checklist accurately:
   - Application type (web API / mobile backend / internal tool / public-facing)
   - Auth mechanism (JWT / session / OAuth / API key) — infer from the codebase or `CLAUDE.md`
   - Data sensitivity (PII / financial / healthcare / low) — check `CLAUDE.md`'s Sensitive
     Areas section
   - Framework — NestJS / Django / Next.js / other, for the framework-specific checklist notes

3. Apply every relevant item in the Security Checklist below. Skip items that don't apply to
   the stack or the code in scope — do not report N/A items as findings.

4. Output format (matches `/pre-push` and `/review-pr` severity conventions):

   ```
   ## Security Review

   ### 🔴 Critical
   (must fix before shipping — injection, auth bypass, data exposure)
   - <file:line> — <OWASP category> — <what's wrong> — <fix>

   ### 🟡 Warnings
   (should fix soon — weak validation, missing rate limiting)
   - <file:line> — <OWASP category> — <what's wrong> — <fix>

   ### 🟢 Recommendations
   (hardening — CSP headers, input sanitization, logging)
   - <file:line> — <suggestion>

   ### Verification
   How to confirm each Critical/Warning fix works (test cases, tools/commands to run).
   ```

5. If called from `/pre-push` or `/review-pr`, return only the 🔴/🟡 findings for merging into
   the caller's own Findings section — the caller keeps its own report format and severity
   levels; don't emit a second, separate report block.

---

## Security Checklist

Each item is tagged with the relevant [OWASP Top 10 2021](https://owasp.org/Top10/) category:
**A01** Broken Access Control · **A02** Cryptographic Failures · **A04** Insecure Design · **A05** Security Misconfiguration · **A07** Identification & Authentication Failures · **A09** Security Logging & Monitoring Failures

Items marked **[NestJS]**, **[Django]**, or **[Next.js]** have framework-specific notes. Everything else applies to any stack.

---

### Auth & Tokens — A07

- [ ] **Refresh tokens in httpOnly cookies, not localStorage** — any XSS script can read `localStorage`. Cookie must have `httpOnly: true`, `Secure: true` (HTTPS), `SameSite: Strict`, and `Path` scoped to the auth route (e.g., `/v1/auth`).
  - **[NestJS]** Use `cookie-parser` middleware + `res.cookie(name, value, options)` in the auth controller. Frontend must pass `credentials: "include"` on all fetch calls.
  - **[Django]** Set `SESSION_COOKIE_HTTPONLY = True`, `SESSION_COOKIE_SECURE = True`, `SESSION_COOKIE_SAMESITE = "Strict"` in `settings.py`. For JWT, write the token in a view using `response.set_cookie(...)` with same flags.

- [ ] **Rate limiting on all auth endpoints** — minimum: register ≤3/min, login ≤5/min, forgot-password ≤3/min, reset-password ≤5/min.
  - **[NestJS]** `ThrottlerGuard` must be registered as `APP_GUARD` in `AppModule` (configuring it without registering the guard has no effect). Add `@Throttle({ default: { ttl: 60000, limit: 5 } })` per endpoint.
  - **[Django]** Use `django-ratelimit` (`@ratelimit` decorator) or DRF's `DEFAULT_THROTTLE_CLASSES` with `AnonRateThrottle`/`UserRateThrottle`. For brute-force lockout use `django-axes`.

- [ ] **Password complexity beyond min length** — `@MinLength(8)` or `min_length=8` alone allows "12345678". Require at least 1 uppercase, 1 lowercase, 1 digit.
  - **[NestJS]** `@Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)` on register and reset-password DTOs.
  - **[Django]** Add `MinimumLengthValidator` + custom `validate()` function in `AUTH_PASSWORD_VALIDATORS`.

- [ ] **Password reset tokens hashed in DB** — store `SHA-256(token)`, send the raw token by email. A DB breach must not allow password reset for any account.

- [ ] **Refresh token reuse detection** — when a used token is re-presented, invalidate the entire token family (all sessions for that login chain) and log a warning. Deleting only the latest token on refresh is insufficient.

- [ ] **Session/presence cookies HMAC-signed** — a cookie whose value is only checked for presence (`if (!cookie?.value)`) can be forged with `document.cookie = "session=1"`. The value must include a timestamp + HMAC-SHA256 signature verified server-side.
  - **[Next.js]** Verify in `middleware.ts` (or `proxy.ts` for Next.js 16+) using `crypto.subtle`.

- [ ] **2FA partial tokens not in sessionStorage** — `sessionStorage` is accessible to XSS. Pass via URL query param (`/verify-2fa?t=<token>`) or keep in React state only.

---

### Input Validation & Mass Assignment — A04

- [ ] **Validated schema objects on all request bodies** — TypeScript type annotations (`body: { name?: string }`) are erased at runtime. Inline interfaces provide no runtime validation.
  - **[NestJS]** Always use class-validator DTOs with `@Body() dto: MyDto`. Without this, `ValidationPipe({ whitelist: true })` cannot strip/reject extra fields, enabling mass assignment.
  - **[Django/DRF]** Always use a serializer class — never pass `request.data` directly to `Model.objects.create(**data)`. Set `read_only_fields` to prevent privilege escalation via writable fields.

- [ ] **UUID validation on all ID params** — reject malformed IDs at the routing layer before they reach the DB.
  - **[NestJS]** `@Param('id', ParseUUIDPipe)` on every `:id` route param. `@IsUUID()` on UUID fields in DTOs (not just `@IsString()`).
  - **[Django]** Use `<uuid:pk>` URL converter. DRF `UUIDField` on serializer fields.

- [ ] **No raw SQL with string interpolation** — use parameterized queries.
  - **[NestJS/Prisma]** Use `` $queryRaw`SELECT * FROM t WHERE id = ${id}` `` (tagged template), not `$queryRawUnsafe`.
  - **[Django]** Use `Model.objects.filter(id=id)` or `cursor.execute(sql, [param])`, never `f"... WHERE id = {id}"`.

---

### Secrets & Cryptography — A02

- [ ] **Sensitive third-party config encrypted at rest** — fields like `apiKey`, `botToken`, `password`, `secret` in an integration/connector config table must be encrypted before DB persistence (AES-256-GCM or equivalent), not stored as plain JSON. A DB dump or SQL injection must not expose all third-party credentials.

- [ ] **No PII in log messages** — log generic messages for missing/invalid account scenarios. Write `"password reset for non-existent account"`, not `"password reset for ${email}"`.

---

### Authorization & Tenant Isolation — A01

- [ ] **Tenant ID from JWT, not request** — extract `tenantId` from the verified JWT payload, never from request body, query params, or headers. Trusting client-supplied tenant context allows cross-tenant data access.
  - **[NestJS]** `@CurrentUser('tenantId')` decorator.
  - **[Django]** Read from `request.user.tenant_id` set by the authentication backend; reject any `tenant_id` in the request body for scoped queries.

- [ ] **All execution paths go through the same authorization layer** — if there is an AI assistant flow and a direct API endpoint performing the same action, both must evaluate the same rules/permissions. Direct API shortcuts that bypass the rules engine are a full authorization bypass.

- [ ] **CORS blocks localhost in production** — `http://localhost:*` in the CORS allowlist in production allows local malware or browser extensions to send authenticated cross-origin requests. Allow localhost only when `NODE_ENV !== "production"`.

---

### Security Logging — A09

- [ ] **Audit log user ID field matches JWT payload field names** — if the JWT strategy returns `{ id, tenantId }`, the audit interceptor must read `user.id`, not `user.userId`. A field name mismatch silently writes `null` to every audit record, making forensic investigation impossible.

---

### Headers & Configuration — A05

- [ ] **HTTP security headers active on the backend**
  - **[NestJS]** `app.use(helmet())` in `main.ts` — covers CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
  - **[Django]** `django.middleware.security.SecurityMiddleware` + `SECURE_HSTS_SECONDS`, `SECURE_CONTENT_TYPE_NOSNIFF`, `X_FRAME_OPTIONS = "DENY"`, `django-csp` for Content-Security-Policy.

- [ ] **Next.js security headers in `next.config.ts`** — add a `headers()` export with at minimum: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`.

- [ ] **Auth state directories restricted** — directories storing session keys or auth state files on disk (e.g., OAuth tokens, bot session data) must be `chmod 700` and owned by the service user, not world-readable.
