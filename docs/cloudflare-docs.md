# Cloudflare docs site: setup and runbook

This project's docs site (`bin/build-docs.mjs`, `.github/workflows/docs.yml`)
deploys to Cloudflare Workers Static Assets at
[`groundwork.monte3l.com`](https://groundwork.monte3l.com), a Custom Domain
under the `monte3l.com` zone (Cloudflare Free plan). It replaced GitHub
Pages: the maintainer owns `monte3l.com` on Cloudflare and wants every
project's docs site hosted there, on a domain they control, rather than on
`github.io`.

This is not a rendered page of the site itself -- it is not in
`bin/build-docs.mjs`'s `PAGES` list, so it is read on GitHub, not on the
docs site. `CLAUDE.md`'s "Architecture notes" is the design record; this
file is the one-time setup and later-projects runbook.

> [!NOTE]
> Workers Static Assets, not Pages: Cloudflare's own guidance for a new
> static site (as of late 2026) is "use Workers instead of Pages" -- Pages
> keeps working but gets no further feature investment. An assets-only
> Worker needs no script of its own.

## One-time setup (done by hand, before merging the PR that adds `docs.yml`)

1. **Create a Cloudflare API token** (dashboard: My Profile → API Tokens →
   Create Token → Custom Token).
   - Name: `gh-m3l-groundwork-docs`.
   - Permissions: **Account** → Workers Scripts → **Edit**; **Zone**
     (`monte3l.com`) → Workers Routes → **Edit**.
   - Zone Resources: scope to the `monte3l.com` zone only, not "All zones".
   - Set a TTL (a 1-year expiry is a reasonable forced-rotation date --
     record it wherever this project tracks recurring maintenance).
   - Cloudflare's tokens use a `cfut_`-prefixed value, which secret
     scanners such as gitleaks (already running in this repo, see
     `.github/workflows/gitleaks.yml`) recognize.
   - This token cannot be scoped to a single Worker -- Workers Scripts:
     Edit is account-wide. That's why it's stored as an **environment**
     secret restricted to `main` (next step), not a plain repo secret.
2. **Get the account ID** (dashboard sidebar, or `Workers & Pages` overview
   page -- it's also in any `wrangler` command's output).
3. **Create the GitHub environment**, so the token is scoped to protected
   deploys only:
   ```
   gh api -X PUT repos/monte3l/m3l-groundwork/environments/docs-cloudflare \
     -f 'deployment_branch_policy[protected_branches]=false' \
     -f 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/monte3l/m3l-groundwork/environments/docs-cloudflare/deployment-branch-policies \
     -f name=main
   gh secret set CLOUDFLARE_API_TOKEN --env docs-cloudflare --repo monte3l/m3l-groundwork
   gh secret set CLOUDFLARE_ACCOUNT_ID --env docs-cloudflare --repo monte3l/m3l-groundwork
   ```
4. **Confirm no existing DNS record** collides with the subdomain:
   `dig groundwork.monte3l.com` should return nothing before the first
   deploy. A Custom Domain (`.github/deploy-tools/wrangler.jsonc`'s
   `routes`) fails to attach if the hostname already carries a CNAME.
5. **Zone-wide security settings** (Cloudflare dashboard, `monte3l.com`
   zone, all available on the Free plan):
   - SSL/TLS → Edge Certificates → **Always Use HTTPS**: on.
   - SSL/TLS → Edge Certificates → **Minimum TLS Version**: 1.2, **TLS
     1.3**: on.
   - DNS → **DNSSEC**: enable it.
   - Defer zone-wide **HSTS** and **CAA records** for now. HSTS is already
     sent per-response from `_headers` (`bin/lib/site-headers.mjs`).
     Custom Domains issue **Advanced Certificates**, which Cloudflare's
     automatic CAA-record convenience (adding the four default CAs once you
     add any CAA record) does **not** cover -- adding a CAA record without
     listing every CA an Advanced Certificate might use risks a failed
     re-issuance. Verify Advanced Certificates' actual issuing CA(s) before
     adding CAA records at the zone level.
6. **First deploy:** merging the PR that adds `docs.yml` triggers the
   `build`/`deploy` jobs on the next push to `main`. Watch the run; a green
   `wrangler deploy` step means the upload itself succeeded. There's no
   automated post-deploy smoke test (see `docs.yml`'s own header comment
   for why: Cloudflare's Bot Fight Mode reliably 403s a GitHub
   Actions-runner `curl`, and that can't be selectively bypassed without
   either weakening the zone's bot protection or allowlisting GitHub
   Actions' entire rotating IP range) -- verify the deploy by hand instead:
   run `curl -sI https://groundwork.monte3l.com` and confirm the CSP, HSTS
   and other headers from `bin/lib/site-headers.mjs` are present, that the
   certificate is valid, and that a bad path (e.g.
   `https://groundwork.monte3l.com/does-not-exist`) returns a real 404.
7. **Uninstall (or de-scope) the Cloudflare Workers & Pages GitHub App**,
   if it's installed on this org: it's only needed for Cloudflare's Git
   integration (Workers Builds), which this setup deliberately doesn't use
   -- direct upload from GitHub Actions (`wrangler deploy` in `docs.yml`)
   needs no GitHub App at all. If it's not installed, there's nothing to
   do.
8. **After the first successful deploy**, verify `.bestpractices.json`'s
   `hardened_site_justification` claim against the live site
   (`curl -sI https://groundwork.monte3l.com`) -- it was written assuming
   this rollout succeeds, but wasn't curl-verified against a live domain at
   the time it was written (the domain didn't exist yet).

## Known, accepted trade-off: the `.html` redirect hop

`wrangler.jsonc` sets `html_handling: "auto-trailing-slash"` (Cloudflare's
default) rather than `"none"`, because `"none"` was tested and breaks `/`
(no automatic `index.html` at the root path -- confirmed with a local
`wrangler dev` run). The cost of keeping the default: every link this site
generates points at an explicit `.html` file (`CONTRIBUTING.html`, ...),
and `auto-trailing-slash` 307-redirects each of those to the extensionless
path (`/CONTRIBUTING`) before serving it. This is an accepted, deliberate
trade -- one extra, edge-served hop per navigation -- not a bug. Rewriting
every generated link to be extensionless from the start would remove the
hop but is a larger change to `bin/build-docs.mjs`'s link-resolution logic
than this rollout's scope covers.

## Adding project #2's docs site

`.github/deploy-tools/package.json` carries an `overrides` floor, `undici: ^7.29.1`, because wrangler 4.141.0's miniflare resolves an undici with open advisories; drop it once miniflare itself requires undici >= 7.29.1.

This setup is deliberately local to this repo for now (see this repo's
`CLAUDE.md`, "Known gaps" analog for the docs pipeline). Until it's
extracted into a shared `monte3l/.github` repo, stand up a new project's
site by copying the pattern:

1. Copy `.github/deploy-tools/` and `.github/workflows/docs.yml` into the
   new repo, renaming the Worker (`wrangler.jsonc`'s `name`), the Custom
   Domain hostname, and the GitHub environment name if desired.
2. Repeat the one-time setup above for the new repo: a new API token (or
   reuse one scoped to the whole account plus every zone it'll ever need --
   a fresh, narrowly-scoped token per project is preferred), a new
   `docs-cloudflare` environment, and a DNS check for the new hostname.
3. One Worker and one Custom Domain per project (e.g.
   `groundwork.monte3l.com`, `<project-2>.monte3l.com`) is the pattern to
   repeat -- not a single shared hostname with path-based routing. It keeps
   each site's `_headers` independent, keeps asset requests free
   (Cloudflare's static-asset requests don't count against the Workers
   free-plan request limit), and 100 Custom Domains per zone is far more
   headroom than this is likely to ever need.
4. When a second project needs this, extract the deploy job and the
   `_headers`-generation pattern into reusable workflows/a shared package,
   rather than copying the YAML a third time.
