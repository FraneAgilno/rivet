# Baseline and verification

The original source commit was tested before adaptation. The unrestricted local baseline contained 1,727 tests: 1,707 passed, 19 failed, and one was skipped. A sandboxed run additionally failed 14 tests requiring loopback listeners; those were environment restrictions rather than source regressions.

The 19 baseline failures arose from September 20 lease fixtures being checked against the September 21 real clock. Rivet's tests now inject the fixture clock into lease-related operations. Lock timing continues to use the real clock; production lease enforcement is unchanged.

New regression coverage checks CLI/package identity, independent state paths, preservation of other frameworks' installed skills, provider registration, profile validation, and honest model readiness. The package smoke check installs a packed tarball into a fresh temporary prefix and runs help and the model registry outside the checkout.

VitePress is pinned to stable 1.6.4 with a Vite 6.4.3 override to avoid advisories in its older default dependency range. This override is verified by the local documentation build; it should be reevaluated when VitePress publishes a stable dependency update. The compatible `fast-uri` dependency was also updated. The resulting dependency audit reported zero vulnerabilities at implementation time.

GitHub Actions and Pages have not run remotely. Local checks do not constitute live model-provider, MCP-provider, or cross-platform qualification.

## Foundation results

Local `npm run check`: 1,268 tests, 1,267 passed, zero failed, one skipped. The smaller count reflects exclusion of the two retired documentation/release-policy test files described in the import manifest. A subsequent focused registry check passed all four tests after tightening descriptor type validation.

`npm run docs:build` and `npm run package:smoke` passed. These results were obtained on the local macOS environment, not the declared CI matrix.
