# Installation details

## Install the CLI globally

```sh
npm install --global github:FraneAgilno/rivet#main
rivet setup --project=.
rivet setup --project=. --write
```

The source branch is a moving alpha, not a versioned npm release. For reproducible installation, replace `main` with a reviewed commit SHA. Global npm installation uses your existing npm prefix; configure a user-owned prefix/runtime manager if necessary rather than running the installer as root.

## Project or global instructions

`setup` defaults to the current directory and both supported harness targets. It previews by default. `--write` applies the setup. Global setup installs instructions without writing project policy:

```sh
rivet setup --global --target=both
rivet setup --global --target=both --write
```

Project preview is read-only. It lists exact root or immediate-child package-script steps, provenance, unresolved required checks, and warnings; it does not run the checks. Generated child steps are written only after `--write`. Repeating setup preserves an existing complete valid `.rivet` configuration byte-for-byte, including later user edits.

To install just the minimal instructions, with no project configuration:

```sh
rivet install --minimal --project=. --target=codex
rivet install --minimal --global --target=claude
```

The minimal installer uses `.agents/skills/rivet/` for Codex and `.claude/skills/rivet/` for Claude Code. Global paths use the same directories under your home directory. These follow the documented [Codex skill locations](https://developers.openai.com/codex/skills) and [Claude Code skill locations](https://code.claude.com/docs/en/skills).

It records ownership and installed-content hashes alongside the skill. Repeating the command is safe; updates replace only unmodified managed files. Collisions or user edits stop the operation so you can review them. It does not rewrite `AGENTS.md` or `CLAUDE.md`, install unrelated capability packs, or configure provider credentials.

## Update or remove

Update the CLI using the same npm install command, then repeat minimal installation for the original scope and targets. Remove managed instructions with:

```sh
rivet uninstall --minimal --project=. --target=both
rivet uninstall --minimal --global --target=both
```

Removal preserves unowned files and refuses to delete modified managed content. Project policy is retained. Remove the globally installed CLI separately with `npm uninstall --global @agilno/rivet`.

## Advanced legacy capability packs

The earlier `install --all` and interactive installers remain available. They install the larger imported skill collection and use their original harness paths, including `.codex/skills` for Codex. They are separate from the new minimal installation lifecycle; use matching legacy uninstall options to remove those packs.

## Contributor checkout

```sh
git clone https://github.com/FraneAgilno/rivet.git
cd rivet
npm ci
npm run build
node bin/cli.js --help
```

Use `--json` with setup and minimal install/uninstall for machine-readable results. If setup reports partial completion, preserve the written configuration, resolve the installation conflict, and rerun. Configuration and harness installation are separate transactions.
