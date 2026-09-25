# Model providers

Rivet's registry distinguishes coding harnesses, hosted APIs, local models, and compatible endpoints. Model IDs are configured by the user rather than restricted to a list of product model names.

```sh
rivet models list
rivet models list --json
```

| Provider ID | Kind | Current execution status |
| --- | --- | --- |
| `claude-code` | Harness | Imported adapter; environment/version requirements still apply |
| `codex` | Harness | Imported adapter; environment/version requirements still apply |
| `anthropic` | Hosted API | One-shot text delegation adapter |
| `openai` | Hosted API | One-shot text delegation adapter |
| `gemini` | Hosted API | One-shot text delegation adapter |
| `ollama` | Local models | One-shot text delegation adapter |
| `openai-compatible` | Compatible API, including local endpoints | One-shot text delegation adapter |

These adapters have automated protocol and transport coverage; live provider qualification remains open. A listed provider is not a claim that its model was called or its account authenticated.

## Validate a profile

Create a JSON file:

```json
{
  "provider": "ollama",
  "model": "your-installed-model",
  "endpoint": "http://localhost:11434",
  "timeoutMs": 30000,
  "maxOutputTokens": 2048
}
```

```sh
rivet models check --profile=./model-profile.json --json
```

This validates configuration locally and reports execution readiness separately. It does not contact the endpoint or run a model. Hosted profiles may name a credential environment variable using `credentialEnv`; never store the credential value in the profile. HTTPS is required except for explicitly supported loopback endpoints.

## Delegate one text request

```sh
rivet models delegate "Review this approach and identify risks" --profile=./model-profile.json
```

Run in an interactive terminal. Rivet displays the exact prompt, provider, model, destination and limits before asking for approval. Approval expires after 30 seconds. It rereads the profile before dispatch and stops if it changed. Only the supplied prompt is sent; Rivet does not collect project files or start another coding harness. Keep secrets out of prompts and shell history. Credential-shaped prompts are conservatively rejected, which can also reject example assignments that resemble secrets.

The returned text is **unverified advice**. It is displayed, never executed or recorded as successful project verification. Terminal control characters are removed from displayed responses. Ctrl+C cancels approval or the request. A cancelled or failed request is not retried; a provider may already have received it and charged usage.

Hosted profiles require `credentialEnv` naming an existing environment variable. For example:

```json
{
  "provider": "openai",
  "model": "your-model-id",
  "credentialEnv": "OPENAI_API_KEY",
  "timeoutMs": 60000,
  "maxOutputTokens": 2048
}
```

| Provider | Wire protocol and endpoint |
| --- | --- |
| `anthropic` | Messages at `https://api.anthropic.com/v1/messages` |
| `openai` | Responses at `https://api.openai.com/v1/responses`, with storage disabled |
| `gemini` | GenerateContent at `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |
| `ollama` | Chat at explicit loopback base, such as `http://localhost:11434`; appends `/api/chat` |
| `openai-compatible` | Explicit public HTTPS or loopback HTTP base, such as `http://localhost:8080/v1`; appends `/chat/completions` |

Hosted services use their fixed origins. For compatible endpoints, `credentialEnv` is optional; set it if authentication is required. HTTP is limited to `localhost`, `127.0.0.1` and `[::1]`, pinned to loopback. Loopback HTTPS, private network endpoints and redirects are unsupported. Public HTTPS uses validated and pinned DNS addresses.

### Limits and current scope

- Explicit `timeoutMs` from 1 to 120000 and `maxOutputTokens` from 1 to 1000000 are required. The chosen model may support a smaller output limit.
- Prompts are limited to 64 KiB, response bodies to 1 MiB and returned text to 256 KiB.
- Only complete text responses with valid reported usage are accepted. Tool calls, refusals, truncation and incomplete responses fail. Usage is provider-reported, not independently measured or a billing guarantee.
- `maxCostUsd` profiles can be validated by `models check`, but direct delegation rejects them because monetary limits cannot currently be enforced. No currency budget is silently ignored.
- `--json` and unattended delegation are unavailable. There are no automatic retries, fallback models, tool calls or streaming output.
- Arbitrary model names are allowed, but a model must support this provider's request and response contract. This does not promise compatibility with every model or server version. Both requested and reported model identities are retained by the runtime.

Explicit role selection is described below. Live account trials and broader workflow integration remain open in the implementation plan.

## Select a model or harness by role

Keep reusable profiles and role choices in a JSON file, for example `model-roles.json`:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "local-review": {
      "provider": "ollama",
      "model": "your-installed-model",
      "endpoint": "http://localhost:11434",
      "timeoutMs": 30000,
      "maxOutputTokens": 2048
    }
  },
  "roles": {
    "review": { "kind": "text", "profile": "local-review" },
    "implementation": { "kind": "harness", "harness": "codex" },
    "planning": { "kind": "active-harness" }
  }
}
```

```sh
rivet models role --roles=./model-roles.json --role=review --json
rivet models delegate "Review this approach" --roles=./model-roles.json --role=review
rivet models delegate "Add a greeting module" --roles=./model-roles.json --role=implementation
```

Inspection validates the whole file locally and reports the selected target without calling a model. Role and profile names use lowercase letters, digits and hyphens, beginning with a letter. Each map holds at most 64 entries; the file is limited to 64 KiB. Unknown fields, invalid targets and missing profile references are rejected.

An unassigned role defaults to `active-harness`. That selection starts no account request or nested process: the command tells you to continue using the Rivet workflow in your current harness. It does **not** perform the task or claim it completed.

A `text` role uses the same prompt preview, approval and bounded advisory response described above. A `harness` role explicitly selects `claude` or `codex` and runs the existing terminal task workflow, with capability discovery, plan approval, isolated checkout, dependency approval and recorded checks. Run inside your configured project, or supply `--project=<path>` for a harness role. Harness tasks retain the existing 4,000-byte task limit and installed CLI/authentication requirements. Text roles do not read project files.

The selected role, referenced profile and target are reread across approval. Changes stop dispatch or activation. An unavailable target fails without switching to another model. Delegating to a different harness requires an installed CLI; desktop applications alone do not provide a spawned executor.

These are explicit role delegation operations. The file is not automatically loaded by `rivet run` or used to assign individual nodes inside an existing workflow. A harness role delegates the whole task through the current workflow. Worker harness routing is configured separately below. Live cross-harness/API demonstrations remain open; fixture tests do not qualify a real provider account or desktop host.

## Choose a harness for workflow workers

For terminal feature workflows, add `harness: claude` or `harness: codex` to the existing worker role in `.rivet/orchestration.yaml`. For example, the relevant fields of your existing role become:

```yaml
id: implementation-worker
kind: worker
harness: codex
# Include the role's existing capacity, delegation, authority,
# permissions, budget and completion-profile fields.
```

Then start a task with the planning harness you want:

```sh
rivet run "Add a greeting module" --harness=claude
```

In this example Claude plans the work and Codex executes the worker nodes. The compiler selects its existing boss/manager/worker role chain; every worker node from that decomposition uses the selected worker role's configured harness. Without `harness`, workers use the run's selected harness as before.

Rivet records the worker executor and its client limits in the exact plan you approve. The terminal preview shows these assignments, and both installed CLIs must pass capability checks. A changed role selection invalidates the existing plan at activation or resume. An unavailable executor blocks work without switching providers. Workers retain the same scoped launch contract, isolated worktree, result validation, evidence requirements and project checks.

The optional field applies to worker roles. Boss and manager nodes retain their existing governance responsibilities and human approval gates. Active-host workflows reject a configured spawned-worker override; remove that override to work entirely through the active agent. API/local text profiles remain advisory and cannot execute implementation nodes.

This setting selects a CLI adapter. It does not select arbitrary per-node model IDs, assign a different model to every role, or qualify desktop app execution. Claude's existing bounded client profile still applies when Claude is selected as a worker. Cross-harness fixture coverage is automated evidence; real account and host demonstrations remain required by T14.

## Extending the registry

`src/models/registry.js` exports `createModelRegistry()`. Register an adapter descriptor with a stable ID, protocol, kind, capabilities, and implementation status, then resolve profiles against it. Registration rejects duplicate IDs and unsupported profile fields. Descriptors are immutable copies.

Registering metadata does not install an executor. Custom executors, broader role routing and live qualification remain separate work packages.
