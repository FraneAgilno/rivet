# Contributing

Use Node.js 22 or 24. Install the lockfile dependencies, then run:

```sh
npm ci
npm run check
npm run docs:build
npm run package:smoke
```

Add focused behavioral tests for new functionality, run the existing relevant regressions, and update the user-facing documentation. Keep generated distribution assets in sync with `npm run build`.

Use the existing workflow service and validation boundaries. Prefer native harness tools or existing project scripts when they already solve the problem. New model descriptors must distinguish registration, implemented execution, and live qualification.

The public repository is [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet). The license and package namespace are still being selected; npm publication remains disabled. Never include client code, credentials, or private work history in contributions.
