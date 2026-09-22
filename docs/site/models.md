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
| `anthropic` | Hosted API | Registry descriptor; executor planned |
| `openai` | Hosted API | Registry descriptor; executor planned |
| `gemini` | Hosted API | Registry descriptor; executor planned |
| `ollama` | Local models | Registry descriptor; executor planned |
| `openai-compatible` | Compatible API, including local endpoints | Registry descriptor; executor planned |

None is live-qualified by this foundation batch. A listed provider is not a claim that its model was called or its account authenticated.

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

## Extending the registry

`src/models/registry.js` exports `createModelRegistry()`. Register an adapter descriptor with a stable ID, protocol, kind, capabilities, and implementation status, then resolve profiles against it. Registration rejects duplicate IDs and unsupported profile fields. Descriptors are immutable copies.

Registering metadata does not install an executor. API execution, authentication probes, usage enforcement, and live qualification follow as separate work packages.
