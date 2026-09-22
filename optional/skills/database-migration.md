# Skill: Database Migration & Schema Design

## When to use

Designing new tables/columns, writing safe migrations, or reviewing schema changes for correctness and backward compatibility.

## Prompt template

You are acting as a database engineer planning a schema change.

Input:
[DESCRIBE THE DATA REQUIREMENT OR PASTE EXISTING SCHEMA]

Context:

- Database: [PostgreSQL / MySQL / other]
- ORM: [Prisma / TypeORM / Django ORM / knex / raw SQL]
- Environment: changes must be deployable with zero downtime
- Existing data: [empty table / has production data / approximate row count]

Task:
Design the schema change and write a safe migration.

Output:

- **Schema design**: tables, columns, types, constraints, indexes
- **Migration SQL or ORM migration**: forward and rollback
- **Data migration**: if existing rows need transformation
- **Deployment strategy**: ordering (migrate before deploy vs after), backfill steps
- **Zero-downtime notes**: nullable columns first, backfill, then add constraints
- **Risks**: data loss scenarios, locking concerns on large tables
- **Validation**: queries to verify migration succeeded

---

## Schema Design Checklist

### Enums vs Strings

Use a PostgreSQL enum (or ORM enum) whenever a column holds a finite, known set of values.
String columns silently accept typos and invalid values with no DB-level enforcement.

Common candidates to audit: `status`, `plan`, `type`, `decision`, `severity`, `channel`, `invoiceType`, `paymentType`.

Migration pattern (PostgreSQL):

```sql
CREATE TYPE offer_status AS ENUM ('DRAFT', 'SENT', 'PAID', 'CANCELLED');
ALTER TABLE offers ALTER COLUMN status TYPE offer_status USING status::text::offer_status;
```

### Foreign Key Constraints

Every column that references another table's `id` must have an explicit FK constraint with a cascade rule.
Missing FKs allow orphaned rows to accumulate silently.

- `ON DELETE CASCADE` — child rows deleted when parent is deleted (e.g., refresh tokens when device is deleted)
- `ON DELETE SET NULL` — nullable FK set to null (e.g., audit log `approvedBy` when user is deleted)
- `ON DELETE RESTRICT` — default; block deletion if children exist

Before adding a FK to an existing column, clean orphaned rows first:

```sql
DELETE FROM child_table WHERE parent_id NOT IN (SELECT id FROM parent_table);
ALTER TABLE child_table ADD CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent_table(id) ON DELETE CASCADE;
```

### Composite Unique Constraints

For tenant-scoped uniqueness (e.g., same phone number allowed across tenants, but not within one):

```sql
ALTER TABLE contacts ADD CONSTRAINT uq_tenant_phone UNIQUE (tenant_id, phone);
```

PostgreSQL correctly allows multiple `NULL` values in unique constraints, so nullable fields are safe.

### Indexes Checklist

Add indexes for every common query pattern. Missing indexes cause sequential scans as tables grow.

| Query pattern | Index type |
| ------------- | ---------- |
| `WHERE tenant_id = ? AND is_enabled = true` | Composite `(tenant_id, is_enabled)` |
| `WHERE tenant_id = ? AND status = ?` | Composite `(tenant_id, status)` |
| `WHERE user_id = ?` | Single `(user_id)` |
| `WHERE expires_at < NOW()` (cleanup jobs) | Single `(expires_at)` |
| Unique lookup by token | Unique constraint (already creates index — don't add a redundant `@@index`) |

### Redundant Indexes

A `@unique` constraint already creates a B-tree index. Adding an explicit `@@index` on the same column is redundant overhead — remove the duplicate.
