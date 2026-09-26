# Installation details

## Install the CLI globally

```sh
npm install --global --install-links github:FraneAgilno/rivet#main
rivet --help
rivet setup
rivet setup --write
```

The source branch is a moving alpha, not a versioned npm release. For reproducible installation, replace `main` with a reviewed commit SHA. Global npm installation uses your existing npm prefix; configure a user-owned prefix/runtime manager if necessary rather than running the installer as root.

Keep `--install-links` in the source install command. A tested npm 10 installation without it reported success but linked the package to a deleted temporary Git clone, leaving `rivet` unavailable. Verify `rivet --help` succeeds before setup. This flag requests a packaged installation rather than a directory link; see [npm installation options](https://docs.npmjs.com/cli/v10/commands/npm-install/#install-links).

## Install for one project without a global CLI

From the project root, use npm to run the installer once:

```sh
npm exec --yes --ignore-scripts --install-links --package=github:FraneAgilno/rivet#main -- rivet install --project-runtime
node .rivet.cjs setup
node .rivet.cjs setup --write
```

Use a reviewed commit SHA instead of `main` for reproducible source selection. Use Node 22 or newer, npm 10 or newer, and Git. Unsupported Node versions are rejected before installation changes. The initial command requires access to the GitHub source and dependency registry; it does not require a global Rivet executable.

Project installation snapshots the running Rivet package and installs its runtime and dependencies into your private `~/.cache/rivet/project-runtimes` cache. A small owned `.rivet.cjs` file pins the Rivet source. Each user keeps their platform-specific runtime and resolved dependency inventory privately. Your application's `package.json`, lockfile and dependencies are preserved. The selected minimal harness instructions use this project reference even when another Rivet version is available globally. Use `--target=claude` or `--target=codex` to install only one target; both are the default. Use `--project=<path>` only when automatic project discovery is insufficient.

From the project root, use the same commands through the reference:

```sh
node .rivet.cjs run "Implement the requested change"
node .rivet.cjs task status
node .rivet.cjs task resume
node .rivet.cjs doctor
```

The reference uses your current Node runtime and validates the pinned Rivet source and private dependency inventory before loading Rivet. It keeps the current working directory and needs no PATH export. The installed harness discovers the project root and uses the reference for its own commands. Review and commit the project reference, configuration and instructions before starting a workflow that requires a clean checkout. Another collaborator needs their own private runtime installation; the cache is not committed to the project.

Repeat the `npm exec` command above from the selected approved source to update the pin. Unchanged sources reuse a verified cache. Edited or unowned project references and instructions stop replacement. Later ordinary `setup` calls preserve the pinned harness routing. Interrupted installation preserves existing application files; inspect any reported partial instruction installation before retrying.

Remove the owned project installation with:

```sh
node .rivet.cjs uninstall --project-runtime
```

Uninstall preserves project policy and application files. Removing only one harness target retains the reference while another managed target still needs it. Shared cached runtimes are retained because other projects may use them. Global CLI installation and global harness instructions are separate scopes.

## Install a verified candidate tarball

When a maintainer supplies an approved candidate tarball and its trusted SHA-256 checksum, use the thin bootstrap from a reviewed Rivet checkout:

```sh
sh /path/to/rivet/scripts/install.sh \
  --artifact "/path/to/agilno-rivet-0.1.0-alpha.0.tgz" \
  --sha256 "<trusted-64-character-sha256>" \
  --prefix "$HOME/.local"
```

Use the checksum from the approved release record. A checksum supplied only beside an untrusted download does not establish authenticity. A published candidate channel is still pending; the source installation above remains available.

The bootstrap requires Node 22 or newer, npm 10 or newer, Git, and tar on PATH. It copies the local tarball into a private temporary directory and checks that copy and its Rivet package identity before invoking npm. It then installs those verified bytes with lifecycle scripts disabled, verifies the installed Rivet command, and prints PATH and project setup instructions. Registry access may be needed for dependencies, which are resolved separately from the checksummed Rivet tarball.

Omit `--prefix` to use your current npm global prefix. Use a user-owned prefix or runtime manager. The bootstrap keeps your existing PATH, does not modify shell profiles, and removes its temporary copy on completion or failure. A failed npm installation can leave partial content in the selected prefix; inspect the reported location before retrying.

See the [candidate checklist](./release.md) for artifact creation, qualification and release decisions.

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
