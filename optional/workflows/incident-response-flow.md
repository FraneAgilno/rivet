# Incident Response Flow

1) Detect & assess
- Alert fires or user report comes in
- Assess severity: who is affected, how many, what's broken
- Assign severity level (SEV1: full outage → SEV4: minor degradation)

2) Investigate
- Identify which services are affected and where they run
- For Kubernetes: use Kubernetes Troubleshooting skill (pod status, logs, events)
- For EC2/CloudWatch: use CloudWatch Troubleshooting skill (log groups, instance health, metrics)
- Correlate across services if multiple are impacted

3) Diagnose
- Use Debugging & Root Cause Analysis skill to structure findings
- Form hypotheses, rank by likelihood, confirm with evidence
- Identify the trigger (deploy, config change, traffic spike, external dependency)

4) Mitigate & fix
- Restore service first (rollback, restart, scale, failover)
- Apply targeted fix once root cause is confirmed
- Verify the fix resolves the symptoms

5) Postmortem
- Use Incident Postmortem skill to document the incident
- Include timeline, root cause, contributing factors, action items
- Share with the team — blameless, focused on prevention

6) Follow-up tickets
- Use Bug Ticket Creation skill to turn postmortem action items into Jira tickets
- Assign owners, set priorities, and link back to the postmortem document
- Track completion in subsequent sprints