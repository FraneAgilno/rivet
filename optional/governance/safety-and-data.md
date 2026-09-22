# Safety, Data Handling, and Compliance

## Sensitive data
Do not paste the following into prompts:
- Credentials, API keys, tokens, passwords
- Production connection strings
- Customer PII (names, emails, phone numbers, addresses) unless explicitly approved and anonymized
- Proprietary client documents unless you have permission and the tool is approved for it

If you need to reference sensitive values:
- Use placeholders (e.g., `{{API_KEY}}`, `{{USER_EMAIL}}`)
- Provide redacted snippets
- Describe structure rather than content

## Security defaults
- Treat user input as untrusted; validate and sanitize.
- Apply least-privilege permissions and explicit authorization checks.
- Avoid logging secrets or full payloads containing PII.
- Call out security implications in “Risks / Edge cases” for non-trivial changes.

## Legal and licensing
- Do not copy licensed code verbatim from unknown sources.
- Prefer existing internal patterns and official documentation.
- Keep generated content original and aligned to internal policies.

## Incident handling
AI can help draft incident notes or runbooks, but does not replace incident commander judgment.
