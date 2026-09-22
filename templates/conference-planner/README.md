# Agilno Conference Planner

This deterministic demo starts as a local-only Next.js repository with seeded conference data, quality tooling, and tracked `.rivet` policy. It does not create a remote repository, connect a cloud account, or deploy anything.

## Why Next.js 15

The template intentionally pins Next.js 15.5.23 and React 19.0.0. Next.js 15 is the compatibility baseline for the conference workflow because AWS Amplify Hosting documents support for Next.js 15 deployments and its App Router/SSR model, while preserving a stable target instead of silently moving the demo to a new framework major. Review Amplify's current supported-features documentation before a real deployment.

## Start locally

```sh
npm ci
npm run dev
```

Run the reproducible baseline gates with `npm run check`. Playwright browsers are deliberately not downloaded during generation; install Chromium with `npx playwright install chromium` before `npm run test:e2e`.

## Local agenda cookie

The `/api/agenda` route stores a personal schedule without a database. It validates add/remove commands, prevents half-open interval conflicts, and signs a versioned agenda with Web Crypto HMAC-SHA256 in an HttpOnly, SameSite=Lax cookie. Set `DEMO_SESSION_SECRET` to a long random value in your local or hosted environment. No secret value is included in this repository. Hosted production responses also mark the cookie Secure. The route returns a configuration error until the environment reference is populated.

## Original custom design system

[`DESIGN.md`](DESIGN.md) defines the product mode, visual principles, component contracts, responsive behavior, and review vocabulary for the original Agilno design system. The workflow is Impeccable-guided: it uses explicit audit, polish, typeset, and distill passes while keeping all implementation and design ownership in this repository.

`design/design-system-manifest.json` records the executable component states, semantic-token source, responsive viewports, accessibility contract, and human-owned visual-baseline status. The demo has no external design-provider, design credential, or design-tool runtime dependency.
