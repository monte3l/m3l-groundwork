# templates/packs/

Optional add-on bundles, installed **on top of** `templates/core` rather
than folded into it. A pack exists for one of two reasons: an artifact was
generically useful but cut from the baseline purely to hold its hard caps
(≤5 agents, ≤8 skills, ≤10 hooks, ≤3 CI workflows, ≤12 root scripts —
`templates/core`'s own `CLAUDE.md`), or it applies to only some project
kinds and shouldn't tax every bootstrap by default.

## Layout

```
templates/packs/<name>/
├── pack.json      # manifest: budget, requires, wiring
└── files/         # the pack's own file tree, mirroring the project root
                    # exactly as templates/core/ does -- emitted the same way
```

## The wiring contract

**A pack never edits YAML or JavaScript.** It may add files under `files/`,
and may extend exactly two JSON structures the baseline already reads at
runtime: `.claude/settings.json` (hook registrations) and
`bin/lib/verify-steps.packs.json` (gate steps, keyed to one of the five
fixed verify groups `templates/core/bin/lib/verify-steps.mjs` defines —
`format`/`lint`/`typecheck`/`build`/`test`). A gate registered this way runs
under `pnpm verify`, every `lefthook.yml` `pre-push` lane, and every
`.github/workflows/ci.yml` job automatically, because all three already
enumerate groups rather than individual steps.

`pack.json` fields:

- `schemaVersion` — currently `1`.
- `modes` — `["fresh"]` and/or `["fresh", "adopt"]`. Only artifacts with no
  dependency on the baseline's exact file layout (an agent, most hooks) are
  safely adopt-capable; a gate that assumes a specific source layout should
  say so honestly in `adoptNotes` instead of claiming `adopt`.
- `budget` — the pack's cap deltas (`agents`/`skills`/`hooks`/`workflows`/
  `scripts`), checked against `templates/core`'s own counts by a structural
  test, never against `templates/core` + every other pack.
- `requires.paths` — baseline files a pack artifact imports (e.g.
  `bin/lib/agent-roster.mjs`). Checked at install time in fresh mode; a
  missing requirement is a hard install error, not a silent partial install.
- `wiring.settings` — a `.claude/settings.json` hook fragment, merged
  append-only and idempotently.
- `wiring.packageScripts` — `package.json` script additions. Most packs need
  none: a gate registers directly as `["node", "bin/check-x.mjs"]` in
  `wiring.verifySteps`, not as a `pnpm` script.
- `wiring.verifySteps` — entries appended to `bin/lib/verify-steps.packs.json`.
- `adoptNotes` — free text surfaced verbatim in `/customize`'s Step 0
  confirmation round when the pack applies to an adopted project.

## Install path

- **Fresh mode**: the CLI installs a pack directly (`--pack <name>`,
  repeatable) — it wrote the baseline moments ago, so there's no uncertainty
  to defer.
- **Adopt mode**: the CLI never installs a pack. It surveys which packs
  apply and stages their payload at `.groundwork/packs/<name>/`;
  `/customize`'s Step 0 confirms and Round 1 installs, translating
  `wiring.verifySteps`/`wiring.settings` against the project's _real_ gate
  runner and hook config — read for real by that point, not guessed at
  offline.

## Available packs

| Pack             | Contents                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness-extras` | A type-design-analyzer agent, the compaction-handoff hook pair, a read-only Bash guard, and a per-file size ratchet gate — the four artifacts the original baseline build cut purely to hold its caps. |

`github-ops` (dependabot/scan-alert triage skills) and `publishing` (a
release workflow + npm-publish gates) are documented follow-ups, not yet
built — see root `CLAUDE.md`'s Known gaps.
