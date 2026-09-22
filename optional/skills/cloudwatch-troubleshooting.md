# Skill: CloudWatch & EC2 Troubleshooting

## When to use
Investigating issues on EC2-hosted services where logs are shipped to CloudWatch — pulling logs, checking instance health, and diagnosing application or infrastructure failures.

## Prerequisites
- AWS CLI installed locally
- AWS profile configured with access to CloudWatch Logs, EC2, and relevant services
- Know the log group name(s) for the target service

## Prompt template
You are acting as an SRE investigating an issue on EC2-hosted services using CloudWatch.

Input:
[DESCRIBE THE ISSUE: service errors, high latency, instance unreachable, deployment failure, etc.]

Context:
- AWS profile: [profile name]
- Region: [e.g., eu-west-1]
- Log group: [e.g., /app/api-service or /var/log/syslog]
- EC2 instance ID(s): [if known]
- Environment: [dev / staging / production]

Task:
Investigate the issue using AWS CLI.

### Investigation steps

1. **Find the log group and streams**
   - `aws logs describe-log-groups --profile <profile> --region <region> --log-group-name-prefix <prefix>`
   - `aws logs describe-log-streams --log-group-name <group> --profile <profile> --region <region> --order-by LastEventTime --descending --limit 10`

2. **Pull recent logs**
   - `aws logs tail <log-group> --profile <profile> --region <region> --since 30m`
   - `aws logs tail <log-group> --profile <profile> --region <region> --since 30m --follow` — live tail
   - `aws logs filter-log-events --log-group-name <group> --filter-pattern "ERROR" --profile <profile> --region <region> --start-time <epoch-ms>` — filter for errors

3. **Check EC2 instance health**
   - `aws ec2 describe-instance-status --instance-ids <id> --profile <profile> --region <region>`
   - `aws ec2 describe-instances --instance-ids <id> --profile <profile> --region <region> --query 'Reservations[].Instances[].{State:State.Name,Type:InstanceType,LaunchTime:LaunchTime}'`

4. **Check CloudWatch metrics**
   - `aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --start-time <ISO> --end-time <ISO> --period 300 --statistics Average --profile <profile> --region <region>`
   - Key metrics: CPUUtilization, StatusCheckFailed, NetworkIn/Out, DiskReadOps

5. **Check CloudWatch alarms**
   - `aws cloudwatch describe-alarms --state-value ALARM --profile <profile> --region <region>`

6. **Check system logs (if accessible)**
   - `aws ec2 get-console-output --instance-id <id> --profile <profile> --region <region>` — boot/kernel logs
   - Check `/var/log/` log groups if system logs are shipped to CloudWatch

### Common patterns
- **OOM**: look for "Out of memory" or "Killed process" in system logs, check memory metrics
- **Disk full**: check DiskSpaceUtilization custom metric or `/var/log/messages`
- **App crash loop**: filter for repeated startup/shutdown log patterns
- **Network issues**: check StatusCheckFailed_System, security groups, NACLs

### Output
- **Status summary**: instance and application health
- **Root cause**: what the logs and metrics indicate
- **Fix recommendation**: restart, resize, config change, or code fix
- **Commands run**: list of commands and key output for the postmortem record

### Related skills
- For analyzing the root cause after gathering data: see `debugging.md`
- For writing up the incident afterward: see `incident-postmortem.md`
- For Kubernetes-based services: see `kubernetes-troubleshooting.md`