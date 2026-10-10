# Step 3 — Round 1: deterministic tailoring: detail

> Full text of Step 3 from `SKILL.md`. Read this whole file before applying Round 1's edits, and re-read it after a compaction: a compacted session keeps only the start of `SKILL.md`.

## Step 3 — Round 1: deterministic tailoring

**Fresh bootstrap** applies directly, no research needed:

- **Project kind ≠ library**: if `check:exports` (publint/attw) doesn't
  apply to the chosen kind (CLI, frontend, service, plugin), remove the
  `check:exports` step from `bin/lib/verify-steps.mjs` and the
  corresponding `.github/workflows/ci.yml` line, and drop the `exports`
  field from `package.json` in favor of a `bin` field (CLI) or leave `main`/
  no public export map at all (service, plugin).
- **Runtime target = browser or both**: note that `tsconfig.base.json`'s
  `lib` and `moduleResolution` will very likely need to change — but leave
  the actual edit to Round 2's `typescript-guidance` sweep, which has full
  authority over that file and access to current bundler-resolution
  guidance you don't have without a live source.
- **Tests mandatory = warn only**: change the `test` lane in `lefthook.yml`
  and `ci.yml` from a hard failure to a non-blocking report.
- **CI depth = minimal**: drop the `test` lane's coverage gate from CI
  (still run locally); minimal keeps only format/lint/typecheck/build.
  **CI depth = thorough**: note this for Round 2 — `harness-guidance` may
  recommend additional current-best-practice lanes (e.g. a scheduled
  dependency audit) beyond what the baseline ships.
- **Agents not kept**: delete their `.claude/agents/<name>.md` file. Never
  delete `Explore`, `test-author`, or `code-implementer` even if unselected
  — they're load-bearing for the hub-and-spoke loop `CLAUDE.md` documents.
- **Packs**: nothing to do here. A fresh bootstrap's packs were installed
  (or not) by the CLI at `m3l-groundwork <dir> --pack <name>` invocation
  time, before this skill ever ran — there is no fresh-mode install path in
  `/customize` itself. To add a pack after the fact, re-run the CLI against
  this now-non-empty directory (it auto-detects adopt mode) and run
  `/customize` again; its Step 0 will offer the pack through the adopt path
  below.

**Adopt mode** re-expresses each of the same five outcomes against whatever
the project actually has, instead of a named baseline path — "tests must not
hard-fail `pre-push`" is applied to _the gate the inventory found_ (jest in
CI, husky locally, whatever it is), not to `lefthook.yml`/`ci.yml` by name.
Concretely, adopt-mode Round 1 applies exactly three things, all already
confirmed in Step 0.4:

- The **approved additions** — files `templates/core` would add that the
  project doesn't have and the user approved adding. For a schema 5 or later inventory, install them from the staged copy Step 0.1 already verified,
  using the bytes you read then (Step 0.1 also already checked that the
  staged files match the `absent` conflicts). Write them to the project at `path` (the
  `.staged` suffix stripped, never to the staged name), filling in the
  `__KEY__` tokens with the project's real values as you copy, same as
  staged packs. Only a **schema 1-4** inventory has no staged copy and reads
  additions from `inventory.templateRoot`; if that path no longer exists (a
  pruned `npx` cache, a deleted temp checkout), say so and ask for a CLI
  re-run rather than guessing at the baseline's contents.
- The **approved conflict resolutions** — for each divergent file the user
  decided on, apply that decision (keep theirs / take groundwork's / merge
  the named keys).
- The **approved packs** — installed from `.groundwork/packs/<name>/` (the
  CLI's staged, self-contained copy of inert `.staged` files — never
  `inventory.templateRoot`, which may not exist by the time this runs). Before installing, call
  `recommendPacks(answers)` from `pack-map.ts` (alongside this file, same
  copy mechanism as `kind-facet-map.ts`) with the now-confirmed
  `InterviewAnswers` and compare its verdict against Step 0.4's decision.
  `harness-extras`, `github`, `supply-chain`, `quality`, and `worktrees`
  never disagree (none of the five's recommendation varies by kind or
  answer -- `worktrees` is always `recommended: false`, since it changes the
  day-to-day workflow rather than adding a nicety, and the other four are
  always `recommended: true`), but `publishing`'s does (recommended for
  `library`/`cli`, not for `frontend`/`service`) — if the comparison surfaces a real
  conflict there or for any future kind-scoped pack, raise it rather than
  silently overriding the user's Step 0.4 answer, mirroring Step 4's "the
  one exception" rule for guidance findings. Before installing, check the
  pack's own `modes`: a pack whose `modes` doesn't include `"adopt"` (today,
  `publishing` — its release flow encodes decisions too project-specific to
  apply blind) is never auto-installed here even if staged and approved;
  instead, state in Step 7 that it needs a manual install (point at `.groundwork/packs/<name>/` and the pack's own `adoptNotes`, and say to strip the `.staged` suffix from every name when copying by hand and to replace every `__KEY__` token with the project's real value) and stop
  there for that pack. Before merging any staged `pack.json.staged` wiring, repeat
  the prototype-key check from Step 0.4(c): if a key of `wiring.settings`,
  `wiring.settingsTopLevel` or `wiring.packageScripts` is `__proto__`,
  `constructor` or `prototype`, stop the same way and change nothing. For an
  adopt-capable pack, install each file from
  `.groundwork/packs/<name>/files/<path>.staged`, using the bytes Step 0.1 read (hash-checked when a command could run), and write it to the project at `path` (the `.staged` suffix
  stripped, never to the staged name), filling in the `__KEY__` tokens with
  the project's real values as you copy (respecting any approved per-file
  conflict decision the same way the baseline's own additions are applied).
  For a schema 1-4 inventory, install each file from the unsuffixed
  `.groundwork/packs/<name>/files/<path>` instead (no `.staged` suffix to strip,
  not hash-verified; token substitution still applies).
  Then, for either schema, translate `pack.json`'s `wiring` by hand, reading it
  from `pack.json.staged` (the bytes Step 0.1 read) for a schema 5 or later inventory and
  from the unsuffixed `pack.json` for schema 1-4,
  against what Step 0.2's deep read already found — a `.claude/settings.json`
  hook fragment merges the same way the baseline's own hook entries would;
  `wiring.settingsTopLevel` is a set of top-level keys (e.g. `statusLine`)
  planted whole, and only when the project doesn't already define that key —
  when it does, show the existing value and ask, since the CLI's own
  `mergeSettingsTopLevel` treats a differing value as a hard error and this
  hand-applied path must not be laxer than the automated one (also check
  `.claude/settings.local.json` and the user's `~/.claude/settings.json`,
  either of which can shadow a project `statusLine`). For `harness-extras`
  specifically, a `statusLine`/`subagentStatusLine` collision is never a
  reason to fail the whole pack install: skip just those two settings keys
  and the three statusline scripts (`statusline.mjs`, `statusline-layout.mjs`,
  `subagent-statusline.mjs`) and install the pack's other artifacts (the
  compaction-handoff hooks and `guard-readonly-bash`) normally, stating the
  skip plainly in Step 7;
  `wiring.verifySteps` becomes a step in whatever this project's real gate
  runner is (a `package.json` script plus a line in its `lefthook.yml`/
  `.husky/pre-push`/CI workflow, written by hand to match its actual shape)
  — or, if the project has no such gate runner at all, install the pack's
  other artifacts and state plainly in Step 7 that the gate was not wired,
  rather than inventing a runner the project never asked for.

**Plugins (both modes), after packs are settled above.** Build a
`PluginRecommendationContext`: `chosenPacks` is whatever the packs decision
just above actually landed on (fresh: what `--pack` installed at bootstrap
time, detectable from the installed files -- e.g. `.changeset/config.json`
means `publishing`, `.github/workflows/claude-pr-review.yml` means `github`
(the only marker `plugin-map.ts` actually reads; `harness-extras` has no
plugin that varies by its presence, so it needs no marker here); adopt: the
packs Step 0.4(c) confirmed, revised by this step's own `recommendPacks`
comparison if it changed anything); `hasCustomSkills` is `false` for a fresh
bootstrap (nothing has authored a skill yet) and, for adopt mode, whatever
Step 0's survey found beyond the baseline's own known skill names and any
already-installed pack's skills (e.g. the `github` pack's three);
`dependencies` is the key names under `dependencies` and `devDependencies`
in the project's root `package.json` (the same read in both modes; a fresh
bootstrap carries only the baseline's own devDependencies, so no SDK plugin
is pre-selected there, and a monorepo whose SDK dependency sits only in a
workspace package is not pre-selected either -- the user can still pick it). Call
`recommendPlugins(answers, context)` from `plugin-map.ts`
(alongside this file, same copy mechanism as `pack-map.ts`) with the
now-confirmed `InterviewAnswers`, and offer every entry it returns (ten, or
eleven for the `plugin` kind, whose `plugin-dev` entry comes last) in **one**
`AskUserQuestion` call holding three multi-select questions (a question
takes at most four options, so split the list in its fixed order: entries
1-4, 5-7, and 8 to the last entry, so 8-10 or 8-11), each option pre-selected per its entry's `recommended`
boolean with its `because` shown as the evidence -- same
"visible reasoning" principle as every other inference in this skill.

Write every confirmed `true` entry into `.claude/settings.json`'s
`enabledPlugins` (`{"<id>": true}` per entry, e.g.
`"context7@claude-plugins-official": true`) -- additive and entry-by-entry,
same discipline as the CLI's own `mergeSettingsHooks` (which owns the
`hooks` block entry-by-entry, as opposed to `mergeSettingsTopLevel`'s
whole-key-at-a-time semantics): never remove or flip an entry the project
already sets explicitly (an existing `false` is a decision the user made,
not an oversight to correct), and never touch `.claude/settings.local.json`
or the user's own `~/.claude/settings.json` scope. `claude-plugins-official`
is a built-in marketplace, so no `extraKnownMarketplaces` entry is needed
for any entry.

**Committing this entry does not install the plugin for anyone.** A
project-scope `enabledPlugins: true` with no local install produces no
folder-trust auto-prompt -- Claude Code's `/plugin` Errors tab instead shows
"enabled in project settings but isn't installed here" until someone runs
the install by hand. So for every newly-`true` entry, print the exact
follow-up command in Step 7's report: `claude plugin install <id> --scope
project` (or `/plugin install <id>` inside a running session) -- the user,
and every collaborator who pulls this change, still has to run it once. Do
the same for each recommendation's `prerequisites` (the
`typescript-language-server` binary, or the Python version a plugin names) --
print them as
follow-ups, never attempt to install them.

Nothing else is touched. A project file the user didn't approve a change to
stays exactly as it was.

Run `pnpm verify` (fresh) or the project's own equivalent (adopt) after
Round 1's edits to confirm the tailored result still passes before moving to
Round 2.
