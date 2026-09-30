# Upstream tooling sources -- the allowlist

The sibling allowlist to `typescript-sources.md` in this same directory
(reused directly for the TypeScript-owner tier, not duplicated). This file
is `gaps` mode's ecosystem-tooling list and covers the TypeScript-adjacent
tooling `research` and `refresh` don't sweep: the package manager, the lint
runner's non-TypeScript-specific config, the test runner, the formatter,
dependency hygiene, and Node's own release schedule.

**A `gaps`-mode research brief passes the union of both files' domain lists**
when an area touches TypeScript itself (the tsconfig/typed-linting areas
always need `typescript-sources.md`'s list too); an area this file alone
covers (pnpm settings, Node pinning) needs only this file's list. Each file's
own GitHub caveat applies only to the GitHub paths it names regardless -- a
path allowed by `typescript-sources.md`'s caveat is not automatically allowed
by this file's caveat, and vice versa.

## Domain allowlist

Pass verbatim as `WebSearch`'s `allowed_domains`, alongside
`typescript-guidance`'s own list when both are in scope for a given area:

```
pnpm.io, knip.dev, vitest.dev, eslint.org, prettier.io, docs.npmjs.com,
nodejs.org
```

Plus **the official docs of a tool the project's interview actually
selected** for bundling, if one was chosen and isn't already covered above
(a specific bundler's own docs).

One of the fixed domains is **path-scoped within a domain
`typescript-guidance` also uses, for a different path**:

- `nodejs.org` hosts the whole Node.js documentation site.
  `typescript-guidance`'s own allowlist scopes it to `/api/typescript.html`
  (the runtime type-stripping boundary). This file's own scope is
  `/en/about/previous-releases` (the LTS/EOL schedule), for the
  Node-version-pinning area only. Passing a bare `nodejs.org` to
  `allowed_domains` allows both paths; treat a citation from any other
  `nodejs.org` path as out of scope for either allowlist.

## The tier

Every domain here is **T1 by default** for its own tool -- owner-normative,
the same standing `typescript-guidance`'s T1 gives `typescriptlang.org` for
TypeScript itself. Most of these tools have exactly one canonical doc
source, unlike TypeScript's ecosystem of adjacent linters/checkers, so most
citations from this file carry `TIER: T1` in the findings format `research` mode defines (which `gaps`
mode reuses).

- `pnpm.io` -- pnpm's own CLI, workspace, and `.npmrc`/supply-chain-setting
  reference.
- `knip.dev` -- unused-dependency/unused-export tooling.
- `vitest.dev` -- the default test runner this baseline ships. **Tier here
  is T1**, for a different purpose than its T2 listing in
  `typescript-sources.md`: that file's T2 covers auditing the config of a
  test runner the interview has already selected (`research`/`refresh`);
  this file's T1 covers recommending vitest be **added** to a project that
  has no test runner configured at all yet (`gaps`). Once a runner is
  selected and configured, further scrutiny of its config is
  `research`/`refresh` territory at T2, not `gaps` mode's -- the same domain
  carries two tier labels because the modes consult it for two different
  purposes.
- `eslint.org` -- ESLint's own core rules and flat-config reference (as
  opposed to `typescript-eslint.io`, which stays `research`/`refresh`'s
  territory for typed-linting presets specifically).
- `prettier.io` -- formatting.
- `docs.npmjs.com` -- npm-the-registry conventions (`package.json` fields,
  `engines`, publishing) as distinct from any one package manager's CLI.
- `nodejs.org/en/about/previous-releases` -- the LTS/EOL schedule, for the
  Node-version-pinning area. See the path-scope note above.

**Explicitly out of scope**, named so an agent that finds one drops it
rather than substituting it for missing coverage:

- A package manager's or tool's community wiki, forum post, or blog
  aggregator (as opposed to its own docs site).
- An individual author's blog post about a tool, however highly ranked.
- `github.com/tsconfig/bases` and similar community-consensus
  repositories -- consensus, not an owner's own word.

## GitHub caveat

`allowed_domains` filters by domain, not path, so a bare `github.com`
allowance would let through any repo. Agents researching an area covered by
this file may include `github.com` and `raw.githubusercontent.com` in their
search domains, but must **only cite or fetch URLs under**:

- `changesets/changesets` (release automation)
- `typescript-eslint/typescript-eslint` (only for the release-compatibility
  question -- "does this typescript-eslint version support this TypeScript
  version" -- the rule semantics themselves stay `typescript-guidance`'s
  T2 territory via `typescript-eslint.io`)
- `nodejs/Release` (the machine-readable Node release schedule, cross-checked
  against `nodejs.org/en/about/previous-releases`)

Drop any other GitHub result, however highly ranked, the same as
`typescript-guidance`'s own caveat requires.

## Coverage discipline

Reject any non-allowlisted domain outright and say so in the report, rather
than substituting a community blog, an individual author's material, or a
Stack Overflow answer for missing coverage. A facet that turns up no
qualifying source is itself a reportable coverage gap, not a reason to lower
the bar -- see `SKILL.md`'s Gaps mode, step 2.

## Current-date anchor

Every research brief must state today's date explicitly, the same discipline
`typescript-guidance` applies -- a `retrieved <date>` stamp otherwise depends
on the spoke inferring the date itself, which is unreliable.
