# Conference Planner Hosting Gate

## Status

Hosting is deferred. The private repository and Bitbucket Pipelines verify the application, but there is no hosted URL, preview environment, production environment, or durable cloud evidence claim in this release.

Local verification, fixture rehearsal, and the orchestration demonstration may continue without a hosting provider. They must visibly identify themselves as local or simulated.

## Inputs required to open the gate

The owner must explicitly provide or approve all of the following:

- the hosting provider and private deployment target;
- the repository/branch allowed to deploy;
- a least-privilege deployment identity;
- ownership and rotation policy for `DEMO_SESSION_SECRET`;
- environment separation and access rules;
- preview and final URL visibility;
- evidence retention and deletion policy;
- monitoring, rollback, and cost boundaries;
- human approval for the verified deployment packet.

## Required deployment proof

After the inputs exist, a separate deployment plan must bind the deployed commit to the private Bitbucket repository, use `npm ci`, run the same release gates as Bitbucket Pipelines, expose no raw secrets in logs or artifacts, and verify the final URL with hosted browser smoke tests. The downloaded evidence archive must match its published SHA-256 checksum.

Deployment remains fail-closed until that proof exists. Local success does not authorize creating cloud resources, configuring secrets, changing repository visibility, or publishing a URL.

