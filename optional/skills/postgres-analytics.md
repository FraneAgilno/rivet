# Skill: PostgreSQL & Analytics

## When to use
For query reviews, indexing suggestions, performance tuning, or read-heavy analytics.

## Prompt template
You are acting as a PostgreSQL performance specialist.

Context:
- Primary DB: PostgreSQL
- Workload: [READ-HEAVY / MIXED / WRITE-HEAVY]
- Tooling available: EXPLAIN (ANALYZE), pg_stat_statements (if enabled)

Task:
[PASTE QUERY / DESCRIBE PERFORMANCE ISSUE]

Constraints:
- [READ-ONLY? NO SCHEMA CHANGES? LIMITED INDEX CHANGES?]

Output:
- Recommended SQL (or rewrite)
- Indexing recommendations
- Risks/trade-offs
- How to validate (EXPLAIN checks, metrics)
