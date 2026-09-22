---
name: rivet-kubernetes-troubleshooting
description: "Investigating issues in Kubernetes clusters — pulling logs, checking pod health, diagnosing crashes, restarts, and deplo"
---

# Skill: Kubernetes Troubleshooting & Log Analysis

## When to use
Investigating issues in Kubernetes clusters — pulling logs, checking pod health, diagnosing crashes, restarts, and deployment failures.

## Prerequisites
- `kubectl` installed locally
- AWS CLI configured with a profile that has EKS access
- `kubeconfig` set up for the target cluster (or run `aws eks update-kubeconfig --name <cluster> --profile <profile> --region <region>`)

## Prompt template
You are acting as an SRE investigating a live Kubernetes issue.

Input:
[DESCRIBE THE ISSUE: service down, errors in monitoring, slow responses, pod crashes, deployment stuck, etc.]

Context:
- Cluster: [cluster name]
- AWS profile: [profile name]
- Namespace: [namespace]
- Service/deployment: [name]
- Environment: [dev / staging / production]

Task:
Investigate the issue using kubectl and AWS CLI.

### Investigation steps

1. **Identify the pods**
   - `kubectl get pods -n <namespace>` — check status, restarts, age
   - `kubectl get pods -n <namespace> -o wide` — check node placement

2. **Check pod health**
   - `kubectl describe pod <pod> -n <namespace>` — events, conditions, resource limits
   - Look for: OOMKilled, CrashLoopBackOff, ImagePullBackOff, Pending, Evicted

3. **Pull logs**
   - `kubectl logs <pod> -n <namespace>` — current container logs
   - `kubectl logs <pod> -n <namespace> --previous` — logs from last crashed container
   - `kubectl logs <pod> -n <namespace> -c <container>` — specific container in multi-container pods
   - `kubectl logs <pod> -n <namespace> --tail=200` — last 200 lines
   - `kubectl logs <pod> -n <namespace> --since=30m` — last 30 minutes

4. **Check deployments and rollouts**
   - `kubectl get deployments -n <namespace>`
   - `kubectl rollout status deployment/<name> -n <namespace>`
   - `kubectl rollout history deployment/<name> -n <namespace>`

5. **Check resources and limits**
   - `kubectl top pods -n <namespace>` — CPU/memory usage
   - `kubectl top nodes` — node-level resource pressure

6. **Cross-service correlation**
   - `kubectl get events -n <namespace> --sort-by=.metadata.creationTimestamp` — recent cluster events
   - `kubectl get ingress -n <namespace>` — check routing
   - `kubectl get svc -n <namespace>` — check service endpoints

### Output
- **Status summary**: which pods are healthy, which are not
- **Root cause**: what the logs and events indicate
- **Fix recommendation**: rollback, config change, resource adjustment, or code fix
- **Commands run**: list of commands and key output for the postmortem record

### Related skills
- For analyzing the root cause after gathering data: see `debugging.md`
- For writing up the incident afterward: see `incident-postmortem.md`