# Docs kit

The docs kit builds a project's documentation site from its own Markdown and
gates that site against the repository. It ships inside the m3l-design release
payload, so `sync-design.sh` copies it into every consumer and `SHA256SUMS`
covers it. A consumer keeps only a config file, its own parity checks and its
deploy wiring.

The kit has no dependencies. It needs Node 24 and `git`.

## Use

```bash
node design/source/docs-kit/build.mjs --check
node design/source/docs-kit/build.mjs --out _site
node design/source/docs-kit/check-live.mjs --site _site
node design/source/docs-kit/check-live.mjs --metadata
```

Each command reads `docs.config.mjs` from the current directory, or the file
named by `--config`. The directory that holds the config is the repository root.

| Command | What it does | Exit codes |
| --- | --- | --- |
| `build.mjs --out <dir>` | Writes the site | 0 written, 2 usage or config |
| `build.mjs --check` | Validates and writes nothing | 0 clean, 1 drift, 2 usage or config |
| `check-live.mjs --site <dir>` | Fetches every URL of the deployed site and compares it with the build | 0 matched, 1 mismatch, 2 usage |
| `check-live.mjs --metadata` | Compares the manifest with the GitHub repository | 0 matched, 1 mismatch, 2 usage |

## Config

`docs.config.mjs` default-exports one object.

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Site name, shown in every page title. A page whose own title is the site name shows it once |
| `repo` | yes | `https://github.com/<owner>/<name>`, the base of links to files that are not pages |
| `siteUrl` | yes | The site origin, with no path and no trailing slash |
| `designDir` | yes | `design` in a consumer, `.` in m3l-design itself |
| `marker` | no | The adoption marker, default `<designDir>/README.md` |
| `navGroups` | yes | Sidebar section names, in order |
| `pages` | yes | `{ src, out, group, label }` per page. `src` is a repository path, `out` is the site path, and one page must have `out` `index.html` |
| `nav` | no | Top navigation, `{ href, label }`. An `href` is a page `out` or an `https` URL |
| `exclude` | no | `{ glob, reason }` for tracked Markdown that is deliberately not a page |
| `generators` | no | Modules that return pages that cannot come from Markdown |
| `parity` | no | Modules that compare the documentation with the code |
| `brand` | no | `true` to add the MONTE3L favicon links, a copy of `favicon.ico` at the site root, and the symbol, linked to the home page, in the header. Needs `<designDir>/source/brand/` from m3l-design v1.2.0 or later, and `--check` fails if a file is missing. Default `false` |
| `manifest` | no | The `package.json` or `plugin.json` that `--metadata` and the homepage gate read |

A generator default-exports `async ({ root, config }) => [{ out, group, label, html }]`.
The `html` is the body of the page. The kit still checks its links and anchors.

A parity module default-exports `async ({ root, config }) => string[]`, one
message per drift. The helpers in `lib/parity.mjs` cover the common cases:
`section`, `tableColumn`, `codeSpans`, `assertSameSet` and `assertSame`.

## What `--check` fails on

Every problem is listed in one run.

| Gate | Fails when |
| --- | --- |
| Links | An internal link, a same-page anchor or a cross-page anchor does not resolve, or a link scheme is not `http`, `https` or `mailto` |
| Markdown | A page uses Markdown the renderer does not support, or an italic span |
| Headers | The generated `_headers` file exceeds Cloudflare's limits of 100 rule blocks or 2,000 characters per line |
| Coverage | A tracked `*.md` file is neither a page nor excluded, or a `pages` or `exclude` entry matches nothing |
| Design integrity | A file does not match `SHA256SUMS`, a file under `source/` is not listed in it, or the marker is not the vendored tier |
| Local CSS | A stylesheet in `<designDir>/local/` holds a colour or length literal instead of a `var(--token)` |
| Alerts | A page source has more than two GitHub alerts in a row |
| Homepage | The manifest `homepage` is not `siteUrl` |
| Parity | A parity module reports a message |

## Rules for the site

- The page shell is `site.css` in this directory. It spends tokens and bundle
  classes only. A consumer that needs a layout change adds a file to
  `<designDir>/local/`, and the Local CSS gate holds it to the same rule.
- A page is on the site only if it is in `pages`. Fix a page in its source
  Markdown, never in the renderer.
- Raw HTML is never passed through. Everything is escaped.
- The Content Security Policy pins the SHA-256 of the one inline theme script,
  so the site has no `unsafe-inline`.

## Versioning

The kit is public API. Removing or renaming a config key, a command or a flag
is a major release. Adding one is a minor release. A fix is a patch release.
