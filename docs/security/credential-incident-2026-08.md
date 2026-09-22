# Credential Incident Record — 2026-08

## Redaction notice

This record is fully redacted. It contains no credential, token, password, sensitive username, or other secret value. The affected identity is described generically so this document is safe to retain in version control.

## Incident summary

- **Discovery:** Plaintext credential-bearing registry guidance was discovered in repository documentation during the August 2026 remediation review. The value was removed from the current tree without being copied into this record or remediation output.
- **Exposure window:** Unknown; pending human-led investigation of repository access, distribution, mirrors, caches, and relevant service audit records.
- **Affected identity:** A registry authentication identity used for package operations. Sensitive usernames and account identifiers are intentionally omitted.
- **Rotation evidence/status:** **Pending human action.** No external credential rotation was performed by this repository change. The registry owner or authorized security administrator must rotate or revoke the affected credential and record non-secret evidence, such as an audit-event identifier and completion timestamp, in the private incident system.
- **Git-history remediation decision/status:** **Decision pending.** The current tree has been remediated, but no Git history was rewritten. Repository and security owners must assess whether coordinated history remediation is necessary, considering forks, clones, caches, release artifacts, disruption, and the fact that rewriting history does not invalidate an exposed credential.
- **Follow-up secret scan:** `gitleaks` was not installed in the remediation environment and was not installed as part of this task. A metadata-only candidate-pattern check reported no matches in the current tree and reported README filename/line metadata in prior revisions, confirming that historical remediation remains unresolved. These narrow checks do not constitute a comprehensive secret scan and cannot prove the absence of other secrets. An approved scanner should be run by an authorized human in a controlled environment with redacted output.

## Action record

| Owner | Action | Date | Result |
| --- | --- | --- | --- |
| Documentation remediation owner | Remove credential-bearing guidance from the current README without reproducing the value | 2026-08-15 | Completed; no secret value recorded |
| Registry owner / authorized security administrator | Rotate or revoke the affected external credential and preserve non-secret audit evidence | Pending | Human-owned pending action |
| Repository owner and security lead | Decide whether coordinated Git-history remediation is required | Pending | Pending; no history rewrite performed |
| Authorized security reviewer | Run approved current-tree and full-history secret scans with redacted reporting | Pending | Pending; local tooling limitation recorded |
| Incident owner | Establish the exposure window from access and audit records | Pending | Pending investigation |

## Required closure evidence

Close this incident only after the private incident system records the decision owner, action date, non-secret evidence reference, and result for credential rotation, exposure-window investigation, Git-history handling, and approved follow-up scanning. Do not add any secret value to this file, an issue, a commit message, command output, or Git history.
