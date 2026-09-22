---
name: rivet-pre-push
description: "Run a read-only, context-aware quality gate before a branch is pushed or a pull request is"
---

# Pre-push

Run a read-only, context-aware quality gate before a branch is pushed or a pull request is
created. Review every local change, run the validation tools required by the project, scan added
content for secrets, and report a clear pass or blocking verdict.

## Usage

```text
/pre-push
```

## Operating rules

- Do not modify files, apply automatic fixes, stage changes, commit, push, or create a pull
  request.
- Do not assume the project uses TypeScript, React, `develop`, a particular package manager, or
  a particular repository layout.
- Prefer commands and policies declared by the project over generic fallback commands.
- Never print a detected secret. Report only its type and `file:line`, with the value redacted.
- A required check that cannot be run is not a pass. Classify it as blocking or warning according
  to the project's documented policy.

## Instructions

### 1. Discover the project contract and technology stack

Before selecting commands, inspect repository context in this order:

1. Repository instructions: `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, and nested
   instruction files that govern changed paths.
2. Project documentation: root and relevant package `README*` files, contribution guides, and
   documented validation or pull-request workflows.
3. Manifests and workspace definitions, including `package.json`, lockfiles,
   `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `pyproject.toml`,
   `requirements*.txt`, `go.mod`, `Cargo.toml`, and equivalent build files.
4. Tool configuration and CI workflows. Use them to confirm the actual lint, type-check, format,
   test, build, generated-file, and policy commands used by the project.

Read `.claude/pre-push-rules.md` as the project-specific static-review policy. If it does not
exist, stop and tell the user:

> pre-push-rules.md not found. Run `rivet init` in your project root to create it, then
> customise it for your team's standards.

Record the discovered context files, repository layout, languages/frameworks, package or build
manager, workspaces/packages affected by the change, and required project-native gates. Resolve
conflicts in favour of the most specific instruction governing a changed path. If instructions
remain contradictory, report the conflict as blocking instead of choosing silently.

### 2. Resolve and refresh the comparison base

Determine the pull-request base in this order:

1. A base branch explicitly supplied by the user or available from the current PR context.
2. A base branch declared by repository instructions or contribution documentation.
3. The remote default branch reported by `refs/remotes/origin/HEAD`.
4. A single unambiguous existing candidate such as `develop`, `dev`, `main`, or `master`.

Do not guess when multiple candidates are plausible. Ask the user for the base branch and stop
until it is known.

Run `git fetch origin <base>` and compare against `origin/<base>`. If the fetch fails, report that
the gate cannot prove the branch is current and classify the review as blocked. Do not silently
use a stale local branch.

### 3. Collect the complete change set

Collect these lanes separately, preserving rename and deletion status:

- Unstaged tracked changes: `git diff`
- Staged changes: `git diff --cached`
- Committed branch changes: `git diff origin/<base>...HEAD`
- Untracked, non-ignored files: `git ls-files --others --exclude-standard`

Use NUL-delimited name/status commands where possible so spaces and renames are handled safely.
Build a deduplicated union for tool execution, but retain lane membership for reporting. Use the
new path for renamed files and exclude deleted paths from tools that require files to exist.

For changed-line analysis, combine the unstaged, staged, and committed diffs. Treat every line in
an untracked file as added. Exclude diff metadata such as `+++`, `---`, and hunk headers from
content scanning.

Record:

- Number of unstaged, staged, committed, and untracked files
- Number of commits ahead of the base
- Changed files grouped by affected workspace/package and by source, tests, configuration,
  documentation, generated output, dependencies, and other files

If no changes are found, report that there is nothing to review and stop successfully.

### 4. Select validation commands from project evidence

Build a check plan before executing commands. Use this precedence:

1. Commands explicitly required by the governing context files.
2. A project-native `prepush`, `pre-push`, `precommit`, `check`, `validate`, or CI-equivalent
   command that is documented as safe and read-only.
3. Existing manifest scripts for linting, type checking, formatting, tests, or builds.
4. Direct tool fallbacks only when the tool and its configuration are present.

Scope commands to affected workspaces or changed files when the project supports safe targeting.
Do not invent flags that conflict with the installed tool version. In particular, do not assume
legacy ESLint flags or `.eslintrc.json`; detect flat `eslint.config.*`, legacy `.eslintrc*`, and
manifest-based configuration.

Apply the relevant stack lane:

- **JavaScript/TypeScript:** detect the package manager from the `packageManager` field and
  lockfile. Prefer project scripts. Otherwise run configured ESLint on changed supported files,
  TypeScript with the relevant `tsconfig`, and Prettier in check mode when installed and
  configured.
- **Python:** prefer project scripts; otherwise use configured tools such as Ruff, Black,
  mypy, or Pyright. Run only tools evidenced by project configuration.
- **Go:** use the relevant module/workspace commands and check formatting of changed Go files;
  run documented vet/test gates for affected modules.
- **Rust:** use the relevant workspace/package commands; run documented `cargo fmt --check`,
  Clippy, check, or test gates.
- **Other stacks:** run only project-native or clearly configured read-only checks discovered in
  the repository.

Run targeted tests or build checks when project instructions require them for the changed
surface. Do not substitute a generic command for a documented project gate.

Classification:

- Lint errors, type errors, failed required tests/builds, and failed project policy gates are
  Critical and blocking.
- Lint warnings are Warnings unless the project treats warnings as errors.
- Formatting violations are Warnings unless the project explicitly makes them blocking.
- A missing tool/config for a documented required gate is Critical. An inapplicable optional
  check is Skipped with a reason.

Capture the exact command, scope, exit status, and concise result for every check. Do not report
raw output that contains sensitive values.

### 5. Scan sensitive paths and added content

Scan every changed or untracked file, not only source-code extensions.

#### Sensitive-path policy

Treat these as Critical unless the project explicitly defines a safe encrypted/generated lane:

- `.env*` files except clearly named templates such as `.env.example`, `.env.sample`, and
  `.env.template`
- Private-key and certificate containers such as `*.pem`, `*.key`, `*.p12`, and `*.pfx`
- Files inside `secrets/` or `ops/secrets/`

A basename that merely contains `secret` or `credential` is a Warning requiring inspection, not
an automatic blocker. This avoids blocking legitimate source code and documentation about secret
handling.

#### Added-content policy

Scan only added lines from every change lane, plus all lines of untracked files. At minimum,
detect:

- Private-key headers
- AWS access-key identifiers such as `AKIA[0-9A-Z]{16}`
- Known token/key formats for providers used by the project
- Webhook URLs containing embedded credentials
- Suspicious assignments to names containing `password`, `secret`, `api_key`, `apikey`,
  `token`, `private_key`, or `credential` when followed by a non-trivial literal value
- Long hex or base64-like literals assigned to a suspicious key name

Ignore obvious template markers such as `<your-key>`, `${ENV_VAR}`, `process.env.*`,
`placeholder`, `example`, or repeated dummy characters. Test fixtures and documentation examples
may be downgraded to Warning only after reviewing their context; they must still be listed.

A credible secret is Critical and blocking. Tell the user to remove it and rotate/revoke it if it
may ever have been exposed. If any file cannot be read or any diff cannot be scanned, fail closed:
report a Critical scan failure for that path.

### 6. Apply repository and static-review rules

Review all relevant changed lines against `.claude/pre-push-rules.md` and the governing context
files. Treat the rule file's categories as authoritative; do not assume React or TypeScript rules
apply to unrelated stacks.

Also check these portable repository concerns when applicable:

- Direct work on a protected/base branch. Warn by default; block only when project policy says so.
- Generated or distribution artifacts. Confirm they match the documented generator/build and
  were intentionally included.
- Manifest and lockfile coherence.
- Required documentation, registry, schema, migration, or generated-file synchronization.
- New code/configuration that bypasses an existing project abstraction or official command.
- Changed tests that weaken assertions, introduce skips/bypasses, or use prohibited mocks.

Project-native validation complements static review; neither replaces the other.

For every finding provide:

- Severity: Critical, Warning, or Suggestion
- Rule or check violated
- `file:line` (or repository-level scope when no line applies)
- Brief evidence-based explanation
- Concrete suggested fix when applicable

Do not flag style preferences that are absent from project rules. Do not claim a rule passed unless
the relevant files and command output support that claim.

### 7. Produce the review report

Use this structure, adapting the tool rows to the detected stack:

```markdown
## Pre-push Review

### Verdict
BLOCKED / PASS WITH WARNINGS / PASS

### Project Context
- Base: origin/<base>
- Context files: ...
- Stack/workspaces: ...
- Package/build manager: ...

### Changes Detected
- Unstaged: X files
- Staged: X files
- Committed: X files across Y commits
- Untracked: X files
- Total unique files: X

### Tool Checks
| Check | Command / scope | Result |
|---|---|---|
| Project gate | `<command>` | ✅ / ❌ / ⚠️ / ⏭️ reason |
| Lint | `<command>` | ✅ / ❌ / ⚠️ / ⏭️ reason |
| Types | `<command>` | ✅ / ❌ / ⏭️ reason |
| Tests/build | `<command>` | ✅ / ❌ / ⏭️ reason |
| Format | `<command>` | ✅ / ⚠️ / ⏭️ reason |
| Secrets | added lines + sensitive paths | ✅ / ❌ |

### Summary
- X Critical, Y Warnings, Z Suggestions
- Categories affected: ...

### Findings

#### 🔴 Critical
(blocking issues — fix before pushing)

#### 🟡 Warnings
(should fix or explicitly accept before pushing)

#### 🟢 Suggestions
(non-blocking improvements grounded in project rules)

### Checks Passed ✅
- List only checks and applicable rules actually verified

### Checks Skipped ⏭️
- Check — reason
```

Verdict rules:

- **BLOCKED:** one or more Critical findings, a required check could not run, the base could not
  be refreshed, or secret scanning was incomplete.
- **PASS WITH WARNINGS:** no Critical findings and at least one Warning.
- **PASS:** no Critical findings or Warnings, and every required check completed.

If the verdict is PASS, congratulate the user on a clean pre-push review.
