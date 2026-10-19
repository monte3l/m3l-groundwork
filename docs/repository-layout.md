# Repository layout

> Moved verbatim from the root `CLAUDE.md` ("Repository Layout"). The root file keeps a short orientation.

```
packages/cli/          Phase A: the offline bootstrapper CLI
  src/                   one module per concern -- list the directory; the
                          ones that carry a contract: assets.ts (the one place
                          that locates templates/ and the plugin payload),
                          baseline-stage.ts (stages absent baseline files as
                          inert .staged copies), pack-stage.ts (the same for
                          every pack, all packs as one unit, written to a
                          temp sibling and swapped in by rename),
                          staging.ts (the suffix, posix-path rule and swap/
                          sweep helpers both share), fs-guard.ts (the shared
                          symlink refusal), fatal.ts + format-error.ts (the
                          bin's total, never-throwing error printer)
  src/harness/            the harness grader: frontmatter.ts, rules.ts, grade.ts,
                          conformance.ts, types.ts
  src/toolchain/          the toolchain grader: rules.ts, grade.ts, conformance.ts,
                          types.ts, tsconfig-chain.ts (the extends resolver the
                          survey shares)
  src/survey/             survey.ts + one collector per discovery area
                          (survey-shape, survey-toolchain, survey-harness,
                          survey-docs), fs-walk.ts, types.ts
  bin/                    m3l-groundwork.mjs -- the published entry point
  scripts/                vendor-assets.mjs -- prepack/postpack: copies templates/
                          and the plugin payload into the package for a pack
  tests/                  unit tests + `*.e2e.test.ts` (bootstrap, adopt, bin,
                          one per pack or pack combination, and
                          pack.e2e.test.ts -- the published tarball, run
                          from outside the repo)

packages/plugin/        Phase B: the /customize skill
  skills/customize/       SKILL.md (Step 0 is the adopt-mode reconcile step)
  src/                    kind-facet-map.ts, domain-map.ts, pack-map.ts,
                          plugin-map.ts, index.ts
  tests/                  unit tests for all four

.claude/                THIS repo's own harness (not the baseline's): agents/,
                         hooks/, rules/, skills/, settings.json -- installed by
                         self-adopting `templates/core`'s harness plus the
                         `statusline` pack. See "Agent
                         Operating Model". worktrees/ is unrelated -- see
                         "Known gaps".

.changeset/             Changesets config and any pending changesets.
                         See "Releases".

.claude-plugin/         marketplace.json: lists the plugin as a relative-path
                         source into packages/plugin -- never npm -- for
                         `/plugin marketplace add`.

.github/                THIS repo's own CI (not the baseline's): ci.yml (five
                         verify lanes + e2e + e2e-macos + node-current + the `verify`
                         aggregator; the e2e trio skips its work on a
                         documentation-only PR, see .claude/rules/ci.md),
                         labeler.yml (area labels from .github/labeler.yml),
                         release.yml (see "Releases"), docs.yml
                         (builds the docs site and deploys it to Cloudflare
                         Workers Static Assets -- see .claude/rules/docs-site.md
                         and docs/cloudflare-docs.md; its `smoke` job and the
                         daily docs-live.yml compare the live site and the
                         package metadata with bin/check-live-site.mjs),
                         environments.yml (weekly
                         cleanup of stale GitHub Deployments/Environments --
                         see .claude/rules/environments.md),
                         dependency-review.yml, scorecard.yml, gitleaks.yml,
                         reuse.yml (`reuse lint`), workflow-lint.yml
                         (actionlint + zizmor),
                         security-audit.yml (daily `pnpm audit`, opens one
                         issue on a high-severity advisory),
                         soak.yml (manual only: runs bin/soak.sh against the
                         published package on Linux x64/arm64 and macOS -- see
                         .claude/rules/ci.md),
                         dependabot.yml,
                         environments.json (the cleanup policy),
                         ISSUE_TEMPLATE/, pull_request_template.md

tools/                  Pinned CI tooling, kept out of `.github/` because
                         Dependabot cannot open a PR that changes files there
                         (every attempt fails with a 400 "invalid or
                         unauthorized changes"). deploy/ pins the exact
                         wrangler version docs.yml's deploy job installs;
                         release/ pins the npm version release.yml's publish
                         job installs. Each is a package.json plus a committed
                         lockfile.

bin/                    This repo's own gate scripts: verify.mjs, check-*.mjs,
                         build-docs.mjs, check-live-site.mjs, eval.mjs,
                         ci-docs-only.mjs, soak.sh.
                         The step list they all read from is
                         bin/lib/verify-steps.mjs.

evals/                  `pnpm eval` suites. `.eval-results/` is gitignored
                         output.

design/                 m3l-design, vendored -- see design/README.md and
                         .claude/rules/design-system.md. source/ is a
                         verbatim copy of an m3l-design release, tokens.css
                         is vendored with it. local/ is this repo's
                         own docs-site layout CSS, the one sanctioned
                         divergence from the vendored system (see
                         design/README.md's "design/local/").

docs/architecture.md    A human-facing distillation of this file's own
                         architecture notes -- for anyone reading the project
                         rather than editing it.
docs/assurance-case.md  The OpenSSF Best Practices Silver `assurance_case`:
                         threat model, trust boundaries, a Saltzer & Schroeder
                         argument, and a CWE Top 25 mitigation table.
docs/security-review.md The Gold-level `dynamic_analysis` write-up -- see
                         "Testing" below.
docs/glossary.md        Term definitions shared across the other docs pages.
docs/github-blueprint.md
                         The exact `gh api` commands for the GitHub settings
                         that live outside the repo -- see "Known gaps".
docs/cloudflare-docs.md The docs-site deploy target -- see
                         .claude/rules/docs-site.md.
docs/environment-janitor.md
                         The environment-cleanup GitHub App's permissions and
                         one-time setup -- see .claude/rules/environments.md.
docs/research/          THIS repo's own trackers (not the baseline's):
                         typescript-refresh.md / harness-refresh.md, read and
                         written by /customize's Round 2 guidance sweeps when
                         run against this repo itself.
GOVERNANCE.md            Decision model, roles, and access continuity --
                         OpenSSF Best Practices Silver's governance criteria.
ROADMAP.md               What's planned and what's explicitly out of scope --
                         OpenSSF Best Practices Silver's documentation_roadmap.

templates/core/         THE BASELINE -- exactly what the CLI emits. Its own
                         toolchain, .claude/ harness, CI workflows, and
                         placeholder src/tests. See its own CLAUDE.md.

templates/packs/        Optional add-on bundles installed on top of the
                         baseline. `claude-github/`, `github/`,
                         `harness-extras/`, `publishing/`, `quality/`,
                         `statusline/`, `supply-chain/`, and `worktrees/` ship
                         today; see its own README.md for the wiring
                         contract and "Known gaps" below for the deferred
                         candidates.
```
