# Skill: Incident Postmortem

## When to use
Writing structured postmortems after production incidents — documenting what happened, why, and how to prevent recurrence.

## Prompt template
You are acting as an SRE lead writing a blameless postmortem.

Input:
[DESCRIBE THE INCIDENT: what happened, timeline, who was involved, what was the impact]

Context:
- Severity: [SEV1 / SEV2 / SEV3 / SEV4]
- Duration: [start time → detection → mitigation → resolution]
- Services affected: [list]
- Customer impact: [scope and nature]

Task:
Produce a structured, blameless postmortem document.

Output:
- **Title and date**
- **Summary**: 2-3 sentence overview
- **Impact**: users affected, revenue/SLA impact, duration
- **Timeline**: chronological events from trigger to resolution
- **Root cause**: what actually went wrong (technical, not personal)
- **Contributing factors**: what made detection or recovery slower
- **What went well**: things that worked during the response
- **Action items**: specific, assigned, with priority and due dates
  - Immediate fixes
  - Short-term improvements
  - Long-term prevention
- **Lessons learned**: takeaways for the team