# Initial source publication check

Target: public `FraneAgilno/rivet`, initially empty, default branch `main`. User authorized continuation after providing the destination and authenticating the isolated `gh-rivet` account. No package publication is included. License remains `UNLICENSED` pending owner selection.

The independent history contains the two foundation commits and the publication preparation change. Imported source provenance is recorded in `source-import.json`; private registry, old team documentation, and local harness configuration were excluded. The conference approval document is preserved as historical policy, not presented as a new approval or a current Rivet release authorization.

A pattern scan covered 423 unique existing Git blobs plus tracked working files for private-key headers, AWS identifiers, GitHub/provider tokens, and embedded URL credentials. Matches were synthetic rejection/redaction fixtures under `test/`; no live credential was identified. This bounded scan is not a comprehensive security audit.

Local documentation build at `/rivet/` and packed-package installation passed. Full runtime verification and remote CI results are recorded separately. GitHub operations use `GH_CONFIG_DIR` scoped to the Rivet account; global GitHub authentication is unchanged.

Automatic publication review rejected the original history because its planning notes, historical policy and organization-specific fixtures were not appropriate for a public snapshot. The public root excludes that history, removes client references and workstation paths from the plan, replaces organization-specific tracker examples with synthetic examples, and retains generic provider code. The original history remains local. The public snapshot must be revalidated before upload.
