# Repository inspection

Rivet provides a common read interface for GitHub.com, Bitbucket Cloud and GitLab.com. It identifies repositories, reads branches and pull/merge requests, and records checks and reviews without turning those observations into permission to deliver.

## Inspect from your project

From a configured Git project, including a nested folder:

```sh
rivet repositories inspect
rivet repositories inspect --review=14
```

The first command reads repository metadata. The second captures a pull request (GitHub/Bitbucket) or merge request (GitLab), its head commit, checks and review observations. Use the number from the selected repository.

If multiple distinct repositories or configured providers match, select them explicitly:

```sh
rivet repositories inspect --remote=upstream --provider=team-github --review=14 --json
```

Rivet does not assume that `origin` is the publishing target. An explicit `--project=/absolute/project` is available when running elsewhere. These commands perform network reads; `rivet integrations check` only reports configuration readiness.

## Configure read access

Add an entry to the existing `providers` list in `.rivet/providers.yaml`:

```yaml
- id: team-github
  kind: git-ci
  mode: read-only
  transport: direct-api
  capabilities: [repository-read, checks-read]
  endpoint: https://api.github.com
  projectIds: [your-project-id]
  resourceIds: [your-team/your-repository]
  credentials:
    tokenEnv: RIVET_REPOSITORY_TOKEN
```

Use the project's actual ID and repository path. Set the referenced environment variable outside tracked configuration. The inspection CLI accepts a bearer token; it does not copy credentials from another application. Use a provider-issued token with read access to the selected resources. Tokens and credential values are excluded from output. For Bitbucket Cloud, use an OAuth or repository access token supported as a bearer credential; Atlassian user API tokens require Basic authentication and are not accepted by this CLI. See [Bitbucket authentication](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).

| Provider | API endpoint | Repository scope example |
| --- | --- | --- |
| GitHub.com | `https://api.github.com` | `team/repo` |
| Bitbucket Cloud | `https://api.bitbucket.org/2.0` | `workspace/repo` |
| GitLab.com | `https://gitlab.com/api/v4` | `group/subgroup/repo` |

Repository inspection requires `repository-read`; review inspection also requires `checks-read`. Disabled, out-of-project, out-of-repository and mismatched endpoint entries are not selected. Credentials must be present before any provider request. SSH or HTTPS Git remotes identify the repository; API reads use HTTPS.

## Capability and qualification matrix

| Capability | GitHub.com | Bitbucket Cloud | GitLab.com |
| --- | --- | --- | --- |
| Repository and branch reads | Implemented | Implemented | Implemented |
| Pull/merge request identity and head SHA | Implemented | Implemented | Implemented |
| Commit checks/status observations | Implemented | Implemented | Implemented |
| Review observations | Implemented | Implemented | Implemented |
| Common interface writes | Unavailable | Unavailable | Unavailable |
| Separate HTTPS branch publication | Implemented, create-only | Implemented, create-only | Implemented, create-only |
| Separate native review creation | Implemented | Pending | Implemented |
| Full review/merge/deployment lifecycle | Planned | Planned | Planned |
| Public repository/branch read smoke | Passed | Passed | Passed |
| Public review inspection smoke | Passed on Rivet PR #14 | Pending | Pending |
| Authenticated sandbox and delivery qualification | Pending | Pending | Pending |

Public smoke checks on 2026-09-25 read `FraneAgilno/rivet`, `atlassian/atlassian-frontend-mirror` and `gitlab-org/gitlab` without credentials. The GitHub check also inspected Rivet PR #14. These bounded reads do not establish private-repository access or complete delivery support.

The existing lower-level GitHub adapter retains its governed operations. The common repository interface is read-only. MCP and local CLI repository execution, custom API hosts, GitHub Enterprise, Bitbucket Data Center and self-managed GitLab are not qualified through this interface.

For local delivery preparation and the governed service foundation, see [delivery lifecycle](./delivery.md). Separate delivery executors support GitHub PR and GitLab MR creation for already published verified branches, plus merges under documented bounded policy subsets. Create-only HTTPS branch publication is implemented separately for all three providers. Native Bitbucket review/merge delivery and live qualification remain pending.

## Interpreting results

An inspection is a bounded observation at a particular time, not an atomic provider snapshot. Reviews and checks can change after they are read. It rechecks the request head after collecting related evidence and fails if that head changed. Checks from a different commit cannot count as current evidence. A review observation without a provider-supplied commit binding cannot prove approval of the current commit.

No checks is not a passing required-check gate. Observed approvals are not a substitute for branch protection, required reviewers, project policy or explicit delivery authority. Repository inspection does not merge, deploy, update a tracker or mark a Rivet task delivered.

Pagination is bounded. Access errors, missing branches, rate limits, malformed results and inconsistent snapshots stop inspection rather than producing partial success. Retry after correcting access or waiting for provider availability; inspect again after a new commit.

## Provider references

- [GitHub REST checks](https://docs.github.com/en/rest/checks/runs) and [pull request reviews](https://docs.github.com/en/rest/pulls/reviews).
- [Bitbucket Cloud commit statuses](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/) and [pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).
- [GitLab commits](https://docs.gitlab.com/api/commits/) and [merge request approvals](https://docs.gitlab.com/api/merge_request_approvals/).
