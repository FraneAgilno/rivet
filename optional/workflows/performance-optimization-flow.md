# Performance Optimization Flow

1) Measure
- Capture baseline metrics (p95/p99, CPU/mem, query times)
- Gather EXPLAIN plans for slow queries

2) Analyze
- Identify bottlenecks (N+1 patterns, missing indexes, over-fetching, heavy payloads)

3) Improve
- Implement query or code changes
- Prefer safe incremental rollouts

4) Validate
- Re-run benchmarks and compare to baseline
- Monitor after rollout

5) Document
- Record what worked and why (so it’s reusable)
