# Official Anthropic sources — the allowlist

The single source list consulted by `harness-guidance` in both modes.
Editing this file is the one edit site when Anthropic moves, renames, or
adds a domain.

## Domain allowlist

Pass verbatim as `WebSearch`'s `allowed_domains`:

```
anthropic.com, www.anthropic.com, claude.com, www.claude.com,
platform.claude.com, code.claude.com, docs.claude.com, docs.anthropic.com
```

Anthropic's engineering posts, research papers, and news all live under
`anthropic.com` (including `/engineering`, `/research`, `/news`), so this
one allowlist covers whitepapers and blog posts as well as docs.

## GitHub caveat

`allowed_domains` filters by domain, not path, so a bare `github.com`
allowance would let through any repo. Agents may include `github.com` and
`raw.githubusercontent.com` in their search domains, but must **only cite or
fetch URLs under the `anthropics` GitHub org** — `github.com/anthropics/...`
or `raw.githubusercontent.com/anthropics/...` — and drop any other GitHub
result, even a highly-ranked one.

## First-class sources to enumerate directly

Search ranking is not exhaustive — a recent post can be silently missed
unless an agent is told to check these directly:

- **Claude Code CHANGELOG** —
  `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`.
  The authoritative, version-ordered record of Claude Code feature and
  behavior changes. Because it's version-ordered, it can be read as a
  **delta** from a known prior version — the primary input for refresh
  mode's Step 2.
- **Blog / news / engineering / research index pages** — enumerate directly:
  - `https://www.anthropic.com/news`
  - `https://www.anthropic.com/engineering`
  - `https://www.anthropic.com/research`
  - `https://claude.com/blog`

## Current-date anchor

Every agent brief must state today's date explicitly. A `retrieved <date>`
stamp otherwise depends on the spoke inferring the date itself, which is
unreliable.

## Coverage discipline

Reject any non-allowlisted domain outright and say so in the report, rather
than substituting a community blog, a third-party summary, or a Stack
Overflow answer for missing official coverage. If a facet turns up no
official source, that is itself a reportable finding (a coverage gap), not
a reason to lower the bar.
