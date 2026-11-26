# Docs kit

The docs kit builds a project's documentation site from its own Markdown and
gates that site against the repository. It ships inside the m3l-design release
payload, so `sync-design.sh` copies it into every consumer and `SHA256SUMS`
covers it. A consumer keeps only a config file, its own parity checks and its
deploy wiring.

The kit has no dependencies. It needs Node 24 and `git`, and `git` 2.21 or later for page freshness.

## Use

```bash
node design/source/docs-kit/build.mjs --check
node design/source/docs-kit/build.mjs --out _site
node design/source/docs-kit/check-live.mjs --site _site
node design/source/docs-kit/check-live.mjs --metadata
node design/source/docs-kit/freshness.mjs
```

Each command reads `docs.config.mjs` from the current directory, or the file
named by `--config`. The directory that holds the config is the repository root.

| Command | What it does | Exit codes |
| --- | --- | --- |
| `build.mjs --out <dir>` | Writes the site | 0 written, 2 usage or config |
| `build.mjs --check` | Validates and writes nothing | 0 clean, 1 drift, 2 usage or config |
| `check-live.mjs --site <dir>` | Fetches every URL of the deployed site and compares it with the build | 0 matched, 1 mismatch, 2 usage |
| `check-live.mjs --metadata` | Compares the manifest with the GitHub repository | 0 matched, 1 mismatch, 2 usage |
| `freshness.mjs [--today <date>] [--max-age <days>]` | Lists the pages nobody has touched or reviewed for a while, as Markdown on standard output. A report, never a gate. See [Page freshness](#page-freshness) | 0 every page is fresh, 1 a page needs a look, 2 usage or config, 3 git cannot give the dates (a shallow clone) |

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
| `pages` | yes | `{ src, out, group, label, summary }` per page. `src` is a repository path, `out` is the site path, and one page must have `out` `index.html`. `summary` is optional, one line, and `llms.txt` prints it after the page's link |
| `nav` | no | Top navigation, `{ href, label }`. An `href` is a page `out` or an `https` URL |
| `exclude` | no | `{ glob, reason }` for tracked Markdown that is deliberately not a page |
| `generators` | no | Modules that return pages that cannot come from Markdown |
| `parity` | no | Modules that compare the documentation with the code |
| `brand` | no | `true` to add the MONTE3L favicon links, a copy of `favicon.ico` at the site root, and the symbol, linked to the home page, in the header. Needs `<designDir>/source/brand/` from m3l-design v1.2.0 or later, and `--check` fails if a file is missing. Default `false` |
| `llms` | no | `{ description, optionalGroups, full }`. Adds a markdown copy of every page, `llms.txt`, and the head links that point to them. See [For agents](#for-agents). Default off |
| `sitemap` | no | `true` to write `sitemap.xml`. Default `false` |
| `freshness` | no | `{ maxAgeDays, exclude, lastmod }`. `maxAgeDays` is the age past which `freshness.mjs` reports a page, default 180. `exclude` is `{ glob, reason }` for pages the report skips. `lastmod: true` writes each page's last commit date into `sitemap.xml` and needs `sitemap: true`. See [Page freshness](#page-freshness) |
| `manifest` | no | The `package.json` or `plugin.json` that `--metadata` and the homepage gate read |

A generator default-exports `async ({ root, config }) => [{ out, group, label, html }]`.
The `html` is the body of the page. The kit still checks its links and anchors.
A generated page may also return `summary` and `markdown`, which matter only
when `llms` is set. See [For agents](#for-agents).

A parity module default-exports `async ({ root, config }) => string[]`, one
message per drift. The helpers in `lib/parity.mjs` cover the common cases:
`section`, `tableColumn`, `codeSpans`, `assertSameSet` and `assertSame`.

## What `--check` fails on

Every problem is listed in one run.

| Gate | Fails when |
| --- | --- |
| Links | An internal link, a local image, a same-page anchor or a cross-page anchor does not resolve, or a link scheme is not `http`, `https` or `mailto` |
| Markdown | A page uses Markdown the renderer does not support, or an italic span |
| Headers | The generated `_headers` file exceeds Cloudflare's limits of 100 rule blocks or 2,000 characters per line |
| Coverage | A tracked `*.md` file is neither a page nor excluded, or a `pages` or `exclude` entry matches nothing |
| Design integrity | A file does not match `SHA256SUMS`, a file under `source/` is not listed in it, or the marker is not the vendored tier |
| Local CSS | A stylesheet in `<designDir>/local/` holds a colour or length literal instead of a `var(--token)` |
| Alerts | A page source has more than two GitHub alerts in a row |
| Reviewed date | Only when `freshness` is set: a page's frontmatter has a `reviewed` key that is not a real date written `YYYY-MM-DD`. A page being old is never a failure |
| Agent copies | A link in a `.md` copy is not external, an anchor or a page of the site. This is how a link split across lines shows up, because the rewrite works line by line |
| Homepage | The manifest `homepage` is not `siteUrl` |
| Parity | A parity module reports a message |

## Page freshness

`freshness.mjs` lists the pages that nobody has touched or reviewed for a while.
It is a report and never a gate: `build.mjs --check` does not fail because a page
is old, so a quiet month cannot stop a merge.

A page's age is the newer of two dates:

| Date | Where it comes from |
| --- | --- |
| Last commit | The committer date of the last commit that changed the page's file, read with one `git log` |
| Reviewed | The `reviewed: YYYY-MM-DD` line in the page's frontmatter, if there is one |

A page with no frontmatter needs nothing from its author. The limit is 180 days,
or `freshness.maxAgeDays`, or `--max-age`.

Setting `reviewed` is itself a commit to the page, so it never makes a page look
older than its last commit. Its job is to record, in the file, that a person read
the page again and found it still true, and on which day. It counts only when it
is later than the commit date.

| Finding | Meaning |
| --- | --- |
| `STALE` | The newer of the two dates is more than the limit ago |
| `FUTURE` | `reviewed` is after today. It is reported and ignored for the age, so it cannot hide a page for as long as the date lies ahead |
| `INVALID` | `reviewed` is not a real date written `YYYY-MM-DD`. It is ignored for the age, and it is the one finding that also fails `build.mjs --check`, for a site that sets `freshness` |

A page git has never seen has no commit date and is not aged unless it has a
`reviewed` date.

> [!WARNING]
> A shallow clone has only the newest commits, so every date it gave would be
> wrong in a quiet way. `freshness.mjs` exits 3 instead, and a build that sets
> `freshness.lastmod` fails with exit 2, like any config error. Check out with
> `fetch-depth: 0`.

### Sitemap dates

With `sitemap: true` and `freshness: { lastmod: true }`, `sitemap.xml` gets a
`<lastmod>` for each page: the date of the last commit that changed its file.
A `reviewed` date does not move it, because reading a page again is not changing
it, and a sitemap date is meant to say that the content changed. A page with no
commit yet gets no `<lastmod>`, and neither does a page a generator returns,
because it has no file of its own to date. It is off by default, so a site that
does not ask for it builds exactly as before.

The dates come from the history, so two builds of one commit write the same
sitemap only if both see all of it. The docs root may be a subdirectory of the
repository, and a page name may hold any character. That matters because `check-live.mjs`
compares the deployed bytes with a fresh build: give the deploy and the daily
check the same full checkout.

## For agents

Setting `llms` or `sitemap` adds files for readers that are not browsers. Both
are off by default, and a site that sets neither builds exactly as it did
before.

| Option | Adds |
| --- | --- |
| `llms: { description, optionalGroups, full }` | A markdown copy of every Markdown page (and of a generated page that returns `markdown`) at the same path with `.md`, `llms.txt`, a `rel="describedby"` link to `llms.txt` in every page head, and a `rel="alternate"` link to the copy in the head of each page that has one. `description` is the one-line summary under the title. `optionalGroups` names nav groups that go under a final `## Optional`, which tells an agent it may skip them. `full: true` also writes `llms-full.txt`, every copy in one file |
| `sitemap: true` | `sitemap.xml`, every page by its public URL |

- A copy is the page source with its links rewritten so they work from the
  copy's URL. A link to another page goes to that page's copy, a repository
  file goes to GitHub, a local `.svg` or `.png` goes to its copy under
  `assets/files/` (see [Rules for the site](#rules-for-the-site)), and an
  external link or an anchor is untouched.
  Frontmatter and HTML comments are dropped, as they are on the site.
- With `llms` set, every page `out`, generated or not, must end in `.html` so
  its copy can be named, and must be unique. A page may not be called
  `llms.txt`, `llms-full.txt` or `sitemap.xml`, and a nav group may not be
  called `Optional` unless it is listed in `optionalGroups`.
- Copies use LF line endings, so the bytes do not depend on the checkout.
  Paths in `llms.txt` and the sitemap are percent-encoded.
- `llms.txt` follows [llmstxt.org](https://llmstxt.org/): the site name, a
  summary, then one list of links per nav group, with absolute URLs.
  `llms-full.txt` is a convention of docs platforms and is not part of that
  proposal, so it has its own switch.
- A generated page is linked to its page unless it returns `markdown`, which is
  then served as its copy exactly as returned, so it must use final links.
- The kit sets no content type for these files. The host picks one from the
  extension.

## Rules for the site

- The page shell is `site.css` in this directory. It spends tokens and bundle
  classes only. A consumer that needs a layout change adds a file to
  `<designDir>/local/`, and the Local CSS gate holds it to the same rule.
- A page is on the site only if it is in `pages`. Fix a page in its source
  Markdown, never in the renderer.
- Raw HTML is never passed through. Everything is escaped.
- A local `.svg` or `.png` that a page links or embeds is copied to
  `assets/files/<repository path>` and linked from there, in the page and in its
  `.md` copy. Any other repository file still links to GitHub, and an image that
  does not exist fails `--check`. Embed a diagram with `![alt](path.svg)`: an
  image loaded by an `<img>` renders, with its own `<style>` and its dark-mode
  media query, under the site's policy. An SVG opened on its own, as a document,
  loses its inline `<style>` to `style-src 'self'`, so link to an image on the
  site only to embed it.
- The Content Security Policy pins the SHA-256 of the one inline theme script,
  so the site has no `unsafe-inline`.

## Versioning

The kit is public API. Removing or renaming a config key, a command or a flag
is a major release. Adding one is a minor release. A fix is a patch release.
