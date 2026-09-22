# Skill: API & Contract

## When to use
Designing or reviewing API endpoints and schemas; ensuring backward compatibility; writing OpenAPI/Swagger summaries.

## Prompt template
You are acting as an API designer.

Context:
- Consumers include web and mobile clients
- Stability matters: avoid breaking changes
- Align naming and error formats with existing APIs

Task:
[DESCRIBE ENDPOINT OR CONTRACT CHANGE]

Output:
- Method + path (or GraphQL operation)
- Request schema (query/body)
- Response schema (success + error)
- Versioning/backward compatibility notes
- Examples (1 request/response)

---

## API Contract Standards (enforce on all endpoints)

### Response Envelope

All endpoints must return a consistent envelope:

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

Exception: auth token endpoints (login/register/refresh) may return flat `{ accessToken, expiresIn }` if changing would break existing clients.

### Tenant Isolation

- Extract `tenantId` from the JWT (`@CurrentUser('tenantId')`), never from request body or query params.
- Every list/get/mutation endpoint must scope DB queries by `tenantId`.
- Shared infrastructure endpoints (health, servers, system bots) must still require authentication even if data is not per-tenant.

### Pagination on List Endpoints

Every endpoint returning a collection must support pagination:

```text
GET /resource?limit=50&offset=0
```

- Default limit: 50
- Max limit: 100 (server-side clamp: `Math.min(Math.max(limit, 1), 100)`)
- Response: `{ entries: [...], total: N, limit: 50, offset: 0 }`
- Exception: endpoints where the result set is provably bounded (e.g., per-tenant connectors, likely ≤20 items)

### HTTP Status Codes

| Operation | Status |
| --------- | ------ |
| POST (create) | 201 Created |
| GET, PATCH, PUT | 200 OK |
| DELETE | 200 OK (with body) or 204 No Content |
| Rate limit exceeded | 429 Too Many Requests |
| Rules engine deny | 403 Forbidden |
| Validation failure | 400 Bad Request |

### Param Validation

- All `:id` path params: `@Param('id', ParseUUIDPipe)` — rejects non-UUID strings before DB layer
- Query params with type expectations: use `@Query('limit', new DefaultValuePipe(50), ParseIntPipe)`
