---
paths:
  - "bin/build-docs.mjs"
  - "bin/lib/markdown.mjs"
  - "bin/lib/site-headers.mjs"
  - ".github/workflows/docs.yml"
  - ".github/deploy-tools/**"
---

# Docs site rules (`build-docs.mjs`, the markdown renderer, `docs.yml`)

> This file is the terse checklist that auto-loads when you touch the docs
> site builder or its deploy workflow. See `docs/cloudflare-docs.md` for the
> full Cloudflare Workers Static Assets write-up.

**The docs site** (`.github/workflows/docs.yml`, deployed from `main` to
`https://groundwork.monte3l.com` on Cloudflare Workers Static Assets -- see
`docs/cloudflare-docs.md`) is a restricted, zero-dependency GFM-to-HTML
renderer (`bin/lib/markdown.mjs`) plus a builder (`bin/build-docs.mjs`) that
renders ten of this repo's own pages -- README (as `index.html`),
CONTRIBUTING, SECURITY, GOVERNANCE, ROADMAP, CODE_OF_CONDUCT, and four
`docs/*.md` pages (`docs/research/*` is excluded, an internal tracker, not
reader-facing) -- styled with `design/tokens.css`,
`design/source/components/bundle.css`, and `design/local/site.css` (the
page-shell layout `design/README.md`'s "design/local/" section reserves for
exactly this: something no single vendored component covers).

**The renderer is restricted, not a general CommonMark implementation:** it
covers exactly the markdown inventory those ten pages use (ATX headings
h1-h3 with GitHub-compatible slug ids, pipe tables, fenced code, lists,
blockquotes -- a GitHub alert `[!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`
becomes a status `m3l-callout`, a plain blockquote a neutral one --
footnotes, code spans, bold/italic, and images, including a link wrapping a
badge image) and throws a `MarkdownError` rather than guessing at anything
outside that set (an h4+, an unknown footnote reference). Every internal
link is rewritten: one of the ten pages becomes a relative link to its
sibling output file (`.md` -> `.html`, anchor kept); anything else in the
repo (`CLAUDE.md`, `LICENSE`, `templates/packs/README.md`, a `.github/**`
file) becomes a `github.com/.../blob/main/<path>` link -- there is no
raw-HTML pass-through and no unescaped text anywhere in the output.

The builder also emits `404.html` (Cloudflare's `not_found_handling:
"404-page"` serves it for any unmatched path) and a Cloudflare `_headers`
file (`bin/lib/site-headers.mjs`) carrying a real `Content-Security-Policy`
-- `script-src` pins the exact SHA-256 hash of the page's one inline
`<script>` rather than `'unsafe-inline'` -- plus HSTS,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
`Cross-Origin-Opener-Policy`.

`node bin/build-docs.mjs --check` (the `docs` step, `bin/lib/verify-steps.mjs`'s
`build` group) builds to a throwaway temp directory and fails on any broken
internal link or anchor, a stray italic `_x_`/`*x*` emphasis span surviving
in one of the ten sources -- the same bold-not-italic rule
`.claude/rules/docs.md` states, enforced here from the moment this gate
existed rather than only once that rule file did -- or a `_headers` file
that would exceed Cloudflare's own limits (100 rule blocks, 2,000 characters
per line). `--out <dir>` (plain, no `--check`) writes the real site;
`docs.yml`'s `build` job runs it with no `pnpm install` first, since the
builder is Node-builtins-only.

The `deploy` job then runs `wrangler deploy` from `.github/deploy-tools/` (a
pinned, lockfile-verified `wrangler`, installed with `--ignore-scripts` --
verified locally that an assets-only deploy needs neither esbuild's nor
workerd's postinstall-fetched binaries) against
`.github/deploy-tools/wrangler.jsonc`, authenticating with a Cloudflare API
token held in the `docs-cloudflare` GitHub environment (`main`-only, no
GitHub App: Cloudflare's Git-integration path, Workers Builds, needs its own
GitHub App installed with repo access, and CLAUDE.md's Known-gaps list
already flagged that app for tighter scoping -- direct-upload from Actions
avoids installing it at all).
