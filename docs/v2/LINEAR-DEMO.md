> Historical source reference. This imported document describes the earlier workflow, not the current Rivet release. Start with [current documentation](../site/getting-started.md).

# Record the Conference Planner demo from Linear

This replaces creating and committing `requests/session-discovery.md` with a direct read of Linear issue `CON-1`. The installed application now connects the tracker factory to a DNS-pinned HTTPS transport. Reads are read-only; it does not edit the ticket.

## Prepare before recording

Use Node 22, the prepared Claude executable environment, and the clean Conference Planner default branch. Update the existing Rivet checkout on `codex/agentic-workflow-v2` with `git pull --ff-only`. No dependency change or build is required for this source-only update.

Set `AI_REPO` and `DEMO_REPO` to the existing checkouts. From `AI_REPO`, this adds one provider without replacing other provider entries. If a Linear provider already exists, inspect it rather than creating another:

```bash
cd "$AI_REPO"
node --input-type=module - "$DEMO_REPO" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
const file = path.join(process.argv[2], '.rivet/providers.yaml');
const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
if (doc.errors.length) throw new Error('Invalid provider YAML');
const providers = doc.get('providers');
if (providers.toJSON().some(p => p.kind === 'linear' || p.id === 'linear-main')) {
  throw new Error('A Linear provider already exists; inspect its configuration.');
}
providers.add({
  id: 'linear-main', kind: 'linear', mode: 'read-only',
  capabilities: ['issues-read'], endpoint: 'https://api.linear.app',
  credentials: { apiTokenEnv: 'LINEAR_API_TOKEN' },
});
fs.writeFileSync(file, String(doc));
console.log('Added read-only Linear provider.');
NODE

git -C "$DEMO_REPO" diff -- .rivet/providers.yaml
git -C "$DEMO_REPO" add .rivet/providers.yaml
git -C "$DEMO_REPO" commit -m "chore: configure read-only Linear feature source"
```

Use a Linear personal API key with permission to read CON-1. Enter it off camera in the same zsh terminal; do not paste the value into a command, record it, or save it in tracked files:

```zsh
set +x
read -s "LINEAR_API_TOKEN?Linear API key: "
printf '\n'
export LINEAR_API_TOKEN
```

The adapter sends a personal API key as the Authorization header value. It also accepts an explicitly supplied `Bearer ...` value for OAuth credentials. Use the base endpoint `https://api.linear.app`; the adapter appends `/graphql`.

The issue must have a title, a description, and explicit acceptance criteria. Supported formats are `AC1: ...` lines or a Markdown `## Acceptance criteria` section containing bullets or checkboxes. Do not silently replace the ticket with a local request if access or content validation fails.

## On-camera replacement commands

Instead of creating a request file, show the issue in Linear:
https://linear.app/example/issue/CON-1/search-and-filter-conference-sessions

```bash
rivet() { node "$AI_REPO/bin/cli.js" "$@"; }
set -o pipefail
PROPOSAL_JSON="/private/tmp/CON-1-proposal.json"
unset RUN_ID PROPOSAL_VERSION PROPOSAL_DIGEST

rivet doctor --project="$DEMO_REPO" --json | jq

rivet feature propose \
  --project="$DEMO_REPO" \
  --ticket=CON-1 \
  --tracker=linear \
  --client=claude \
  --json | tee "$PROPOSAL_JSON" | jq
```

Stop if the command fails. After a successful proposal:

```bash
if jq -e '.ok == true' "$PROPOSAL_JSON" >/dev/null; then
  RUN_ID="$(jq -er '.result.runId' "$PROPOSAL_JSON")"
  PROPOSAL_VERSION="$(jq -er '.result.version' "$PROPOSAL_JSON")"
  PROPOSAL_DIGEST="$(jq -er '.result.proposalDigest' "$PROPOSAL_JSON")"
  jq '.result.workRequest.source' "$PROPOSAL_JSON"
fi
```

The displayed source should identify `linear` and `CON-1`, with a revision and source URL. Review the new proposal before activation. Use this proposal's version and digest for the remaining start/resume steps; values from an earlier Markdown run are not interchangeable.

Suggested narration: “The feature request lives in Linear. The CLI reads this issue and turns it into a versioned request, then proposes a plan for human approval.”

## Verification scope

Automated coverage exercises the application's real tracker-to-proposal composition using fixture network and model responses, correct issue-by-ID GraphQL shape, acceptance parsing, missing credentials, private-address rejection, and redirect rejection. Live authenticated retrieval of CON-1 must still be rehearsed with an authorized local key. Doctor alone is not proof that this ticket can be read.

API reference: https://linear.app/developers/graphql
