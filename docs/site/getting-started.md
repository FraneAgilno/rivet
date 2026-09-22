# Install and explore

## Current alpha setup

Use Node.js 22 or 24 and Git. The CI matrix targets macOS and Linux; remote CI results are not available until the GitHub repository is created. Native Windows support is not qualified yet.

Clone the public source repository:

```sh
git clone https://github.com/FraneAgilno/rivet.git
cd rivet
npm ci
npm run build
node bin/cli.js --help
node bin/cli.js models list
```

To install the `rivet` command locally from this checkout:

```sh
npm install --global .
rivet --help
```

The package name is provisional and publication is disabled. There is no public `npx` installation command yet. The one-command installer is a planned milestone.

## Optional harness skills

Run from the consumer project:

```sh
rivet install --all --target=both
```

Use `--target=claude` or `--target=codex` to choose one, or add `--global` for machine-wide skills. Installed skills use `rivet-` names so they coexist with other frameworks. Reload your harness if it does not discover newly installed skills immediately.

These imported skills still describe the earlier bounded workflow. They are not proof that the new active-harness workflow or additional harness installers are finished. Review the [implementation status](./status.md) before using them.

## Project configuration

```sh
rivet init --project=/absolute/path/to/project
```

This previews configuration. Add `--write` to create the reviewed `.rivet` policy files. Credentials and private run state belong outside tracked project configuration. The CLI deliberately does not consume `.agilno` configuration or `AI_ENGINEERING_*` environment variables.

## Remove installed skills

```sh
rivet uninstall --all --target=both
```

Use the same project/global scope used during installation. Other frameworks' unprefixed skills are preserved.
