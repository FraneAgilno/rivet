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

Cross-harness delegation, workflow role selection, live account trials and broader execution remain open in the implementation plan.

## Extending the registry

`src/models/registry.js` exports `createModelRegistry()`. Register an adapter descriptor with a stable ID, protocol, kind, capabilities, and implementation status, then resolve profiles against it. Registration rejects duplicate IDs and unsupported profile fields. Descriptors are immutable copies.

Registering metadata does not install an executor. Custom executors, cross-harness role delegation, authentication probes and live qualification remain separate work packages.
