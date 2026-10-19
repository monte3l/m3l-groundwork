---
paths:
  - ".github/workflows/release.yml"
  - ".github/workflows/scorecard.yml"
  - ".github/workflows/security-audit.yml"
---

# Release supply-chain rules (Scorecard signals, SBOM, audit, OpenVEX)

> Split verbatim from `.claude/rules/releases.md` so it loads only when you edit the files it governs.

**Two release signals exist only for OpenSSF Scorecard's parsers.**
Signed-Releases scores release **assets** named `*.sigstore.json` (8) or
`*.intoto.jsonl` (10) and never reads GitHub's attestation store, so the
bundle is uploaded as an asset. Name it `.sigstore.json`: it is a Sigstore
bundle, and `.intoto.jsonl` would claim a format it is not. Packaging only
recognises an npm publish job that has `actions/setup-node` with
`registry-url: https://registry.npmjs.org` **and** a step running
`npm ... publish`, so the `publish` job sets that `registry-url`. It is safe
because `bin/npm-stage-publish.mjs` never reads `.npmrc` or `NODE_AUTH_TOKEN`:
it exchanges the GitHub OIDC token itself and passes the result to
`libnpmpublish` explicitly. Re-check that if the publisher is ever rewritten
to use the npm CLI.

**The SBOM (OSPS Baseline OSPS-QA-02.02, level 3) is generated, attested and
attached in the same best-effort block.** `pnpm --filter @monte3l/groundwork
sbom` writes `<tarball>.cdx.json` (CycloneDX 1.6, `--prod --lockfile-only`),
`actions/attest` attests it against the tarball, and the existing `gh release
upload` attaches it only if that attestation succeeded. Three things are
easy to get wrong. **Use `--filter`, never `-C <dir>` or a cd into the
package**: both silently describe the workspace root (`m3l-groundwork@0.0.0`)
and would attest the wrong package. **The SBOM attestation's bundle is not
uploaded**, because a second `*.sigstore.json` beside the provenance bundle
would blur what that name means to Scorecard's Signed-Releases check;
consumers verify with `--predicate-type https://cyclonedx.org/bom`. **Do not
add `artifact-metadata: write`** to the `publish` job for it: the provenance
step already runs without it, and a wider token on the OIDC job needs a
reason. The step refuses to run when the tarball's version differs from
`packages/cli/package.json`. It also records the tarball's SHA-256 on the root
component (`pnpm sbom` does not hash the artifact), because CISA's "2026
Minimum Elements for a Software Bill of Materials (SBOM)" (v2.1, 2026-07-29)
lists a component hash algorithm and value among its 17 data fields. Checked
field by field against that list, the one field not carried inside the file is
SBOM Author Signature: the Sigstore attestation signs the SBOM from outside,
which is a detached signature, not an embedded one. Say that, not "fully
conformant", if the claim is ever made. Scorecard v5.5.0 has no SBOM check, so this does
not move the score; its value is Baseline level 3 and consumers. An empty
`components` list is correct while the CLI has no runtime dependencies.

**The `pack` job audits before it builds.** Straight after install it runs
`pnpm audit --audit-level=high` and `npm audit --package-lock-only --prefix
tools/release --audit-level=high`, so no release is published while the root
lockfile, or the release-tools lockfile the OIDC-holding `publish` job installs
from, has a high or critical advisory. Both pass today. Both exit non-zero on a
hit: checked against a throwaway lockfile holding a known-vulnerable
dependency, which also showed that `audit.ignore` (GHSA ids, in
`pnpm-workspace.yaml`, pnpm 12.4 or later) excludes only the ids listed and
leaves any other high advisory failing. That key is the one sanctioned way past
the root gate, and it belongs in a PR that records the reasoning in
`docs/security-review.md`; this repo configures no equivalent for the
release-tools lockfile, so a finding there is fixed by updating the pinned
package. A transient registry failure fails the step, so re-run the job. The
policy is `SECURITY.md`'s "Dependency and code-scanning findings".

**The OpenVEX feed needs one step per release.**
`docs/m3l-groundwork.openvex.json` lists the published versions each
`not_affected` statement covers, so a new release is not covered until it is
added. Verify the tarball first, in a fresh directory, because the statements'
justification (`component_not_present`) is only true while the package ships no
dependencies, lockfile or `node_modules`:

```bash
d=$(mktemp -d) && cd "$d" && npm pack "@monte3l/groundwork@<version>" --silent \
  && tar -xzf monte3l-groundwork-<version>.tgz
find package \( -name package-lock.json -o -name node_modules \)   # expect no output
node -p 'JSON.stringify(require("./package/package.json").dependencies)'   # expect {}
```

Then, from the repository root, run this once (it bumps `version` each time, and
does not duplicate a product on a rerun), and format the file:

```bash
node -e '
const fs = require("fs");
const f = "docs/m3l-groundwork.openvex.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));
const purl = `pkg:npm/%40monte3l/groundwork@${process.argv[1]}`;
for (const s of d.statements) {
  if (!s.products.some((p) => p["@id"] === purl)) s.products.push({ "@id": purl, identifiers: { purl } });
}
d.version += 1;
d.last_updated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
' <version> && pnpm exec prettier --write docs/m3l-groundwork.openvex.json
```

The schema forbids an empty `statements` list (`minItems: 1`) and unknown keys,
so edit with care. If the package ever ships a dependency, or a statement stops
being true, change its status; do not leave it standing.

**Backfilling the bundle onto an older release.** Scorecard averages the last
five releases, so a release published before the bundle was attached scores
as unsigned until it rolls off. For a release whose tarball was attested,
the maintainer can attach the bundle by hand. Read the tarball's own digest
from the release asset, never from a local rebuild:

```bash
gh release download "@monte3l/groundwork@<version>" --repo monte3l/m3l-groundwork \
  --pattern '*.tgz' --dir /tmp/rel
gh attestation download /tmp/rel/monte3l-groundwork-<version>.tgz \
  --repo monte3l/m3l-groundwork
# writes sha256:<digest>.jsonl in the current directory; keep one bundle line
head -n1 sha256:*.jsonl > /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json
gh attestation verify /tmp/rel/monte3l-groundwork-<version>.tgz \
  --bundle /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json \
  --repo monte3l/m3l-groundwork
gh release upload "@monte3l/groundwork@<version>" \
  /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json --repo monte3l/m3l-groundwork
```

Only upload after `gh attestation verify` passes. A release with no
attestation is left alone and rolls off as new releases ship.
