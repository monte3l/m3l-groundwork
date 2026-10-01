---
name: customize
description: >-
  Tailors a project bootstrapped or adopted by m3l-groundwork: for a fresh
  bootstrap, interviews the owner (project kind, runtime target, test
  strictness, CI depth, which reviewer agents to keep) and applies
  deterministic edits; for an adopted pre-existing project, first reconciles
  the CLI's `.groundwork/` survey against the real repository, confirms what
  to add, how to resolve conflicts, and which optional `templates/packs/`
  pack(s) to install. Either way it then runs a live guidance pass over
  official TypeScript and Anthropic sources to validate and refine the
  result against current upstream recommendations. Use for /customize,
  "tailor this project", "adopt this project", "set up this scaffold for my
  project", or right after a fresh or adopted m3l-groundwork bootstrap.
---

# customize

The baseline this project was bootstrapped or adopted with is universal and
frozen at publish time. This skill runs in three rounds, and the ordering is
the whole design:

- **Round 0 — the baseline.** Already in place for a fresh bootstrap; for an
  adopted project, "the baseline" is instead whatever `.groundwork/` recorded
  about the project's own existing files (see Step 0).
- **Round 1 — interview-driven tailoring.** Deterministic, from the answers
  below. Prunes what the project doesn't need and selects what it does.
  Still working from frozen knowledge.
- **Round 2 — guidance-driven refinement.** Two live sweeps over official
  sources that compare, refine, and validate everything Rounds 0 and 1
  produced against what upstream actually recommends **today**. This is the
  most important round, because it is the only one whose knowledge is not
  frozen.

## Authority

Round 2's two sweeps each have authority over their **entire** domain, not a
narrow slice of it — this holds identically for a fresh bootstrap and an
adopted project; only the domain's _contents_ differ (the known baseline vs.
the project's real files):

- `typescript-guidance` (refresh mode) may amend every TypeScript facet —
  `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts` (config
  **and** the testing approach itself), packaging, the TypeScript-toolchain
  entries in `package.json`, and the toolchain steps in
  `.github/workflows/*.yml`.
- `harness-guidance` (refresh mode) may amend the whole `.claude/` surface —
  `settings.json`, hooks, agents, skills, rules, and this `CLAUDE.md`.

The interview below scopes **priority, not authority**: it tells Round 2
which facets deserve the deepest dedicated research, never which facets it
may or may not touch.

## Step 0 — Reconcile (adopt mode only)

1. Look for `.groundwork/inventory.json`.
   - **Absent, and no `.groundwork/` directory either → this is a fresh
     bootstrap; skip straight to Step 1.** Everything below this step applies
     only when an inventory exists.
   - **Absent, but `.groundwork/` exists → a previous CLI adopt run did not
     complete** (the CLI deletes the old inventory before it stages anything
     and writes the new one last, so no inventory beside a `.groundwork/`
     directory means the run died part-way). **Stop. Never fall through to
     the fresh flow** -- that would run fresh-mode tailoring on an
     established project. Tell the user: "`.groundwork/` is incomplete: a
     previous adopt run did not finish, or `inventory.json` was removed.
     If this project was never adopted (it was bootstrapped fresh), delete
     `.groundwork/` and run `/customize` again. Otherwise re-run
     `npx @monte3l/groundwork@rc .` and then run `/customize` again."
     Change nothing.
   - **Present, but not valid JSON, or its `schemaVersion` is not an integer
     of at least 1 → stop and change nothing.** Tell the user: "`.groundwork/inventory.json`
     is not valid JSON or has no usable `schemaVersion`. Re-run
     `npx @monte3l/groundwork@rc .` and then run `/customize` again."

   **Check `inventory.schemaVersion` before reading anything else.** This
   skill understands schema versions **1 through 5** (the highest it knows is
   5). If `schemaVersion` is **higher than 5**, the CLI that wrote it is newer
   than this plugin: **stop and change nothing**, do not interpret the
   inventory (a newer schema may have renamed or repurposed fields, and a
   confident misreading is worse than none), and tell the user to update the
   plugin and re-run `/customize`. Say which update applies to the copy
   that is running. For the plugin install, run `/plugin update`. For a
   project-local copy in `.claude/skills/customize/`, `/plugin update` does
   not touch it, and re-running the CLI alone does not either: the CLI
   never overwrites a copy that differs, it writes a fresh one to
   `.groundwork/customize/`, which Claude Code does not load. So delete
   that directory first (this discards any local edits the project made to
   its copy) and then re-run `npx @monte3l/groundwork@rc .`. A
   copy in `.groundwork/customize/` is refreshed by re-running the CLI. What
   each version added:

   | `schemaVersion` | Adds                                                                                                                                                                                                                                                                                                                      | If absent                                                                                                                        |
   | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
   | 1               | the survey, `conflicts`                                                                                                                                                                                                                                                                                                   | (the floor)                                                                                                                      |
   | 2               | `packs`                                                                                                                                                                                                                                                                                                                   | no packs to offer; skip the pack question                                                                                        |
   | 3               | `harnessGrade`, `harnessConformance`                                                                                                                                                                                                                                                                                      | skip the harness-grade starting point                                                                                            |
   | 4               | `toolchainGrade`, `toolchainConformance`                                                                                                                                                                                                                                                                                  | skip the toolchain-grade starting point                                                                                          |
   | 5               | `stagedBaseline` (`{ dir, suffix, files }`): the baseline additions staged at `.groundwork/baseline/`, each as `{ path, staged, sha256 }`; `stagedPacks` (per pack: `{ name, dir, suffix, manifest, files }`): every pack staged at `.groundwork/packs/<name>/`, its manifest and each file as `{ path, staged, sha256 }` | schema 1-4 only: read baseline additions from `inventory.templateRoot`; packs use the unsuffixed copy under `.groundwork/packs/` |

   **For a schema 5 inventory only: verify the staged baseline now, before
   anything is offered to the user.** A schema 1-4 inventory has no
   `stagedBaseline`: skip this whole block (every bullet below, including
   its stop list) and use the `inventory.templateRoot` fallback in Round 1.
   The inventory lives in the project tree and is untrusted input, so check
   it before trusting any entry:

   - `stagedBaseline.dir` must equal `.groundwork/baseline` exactly, and
     `stagedBaseline.suffix` must equal `.staged` exactly. Take both values
     from this list, not from the inventory: a `dir` of `.` with an empty
     `suffix` would make you "verify" live project files.
   - For every entry of `inventory.stagedBaseline.files`, require
     `staged === path + ".staged"`, and require `path` to be relative, free
     of any `..` segment, and not absolute. Reject the entry if `path` is
     `""` or `"."`. Reject it too if `path` contains a `\` or a `:` (a
     Windows `..\..` or `C:foo` would slip past the other checks). Reject a
     duplicate `path` or a duplicate `staged` among the entries. These fields
     use `/` separators on every platform: `conflicts[].relPath`,
     `packs[].fileConflicts[].relPath`, `stagedBaseline.dir`,
     `stagedBaseline.files[].path` and its `.staged` name. Other paths in
     the inventory are not normalized: `templateRoot` and `targetDir` are
     absolute native paths, as are the survey's tsconfig chain entries.
   - The `absent` conflicts in `inventory.conflicts` and the paths in
     `stagedBaseline.files` must name the same set of files. If they
     disagree (an `absent` conflict with no staged entry, or a staged entry
     that is not an `absent` conflict), that is a mismatch: stop, with the
     same message as a hash mismatch, before anything is offered or approved.
   - Read each staged file at `.groundwork/baseline/<staged>` **once**.
     It must exist, and the SHA-256 of its **raw bytes** (no end-of-line
     normalization, no decoding) must equal the entry's `sha256`. Compute it
     with, for example, this one-liner (it targets a POSIX shell or Git Bash,
     not `cmd.exe` or an old PowerShell), passing the file as a single quoted
     argument in place of `<file>`:
     `node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' <file>`
     Keep those same bytes for the install in Round 1 (substitute tokens into
     them) rather than reading the file a second time.
   - **Staged packs, in the same block.** For every entry of
     `inventory.stagedPacks`:
     - `dir` must equal `.groundwork/packs/<name>`, built from the entry's
       own `name`, and `suffix` must equal `.staged`. Take both from this
       list, not from the inventory.
     - `name` must be a single path segment: not empty, not `.` or `..`, and
       free of `/`, `\` and `:`. Reject a duplicate pack `name`.
     - `manifest.path` must equal `pack.json` and `manifest.staged` must
       equal `pack.json.staged`.
     - For every entry of its `files`, require `staged === path + ".staged"`,
       and apply the same path checks as the staged baseline's files above
       (relative, no `..` segment, not absolute, not `""` or `"."`, no `\` or
       `:`). Reject a duplicate `path` or a duplicate `staged` among one
       pack's files.
     - The pack names in `inventory.packs` and in `inventory.stagedPacks`
       must be the same set, and for each pack its `fileConflicts[].relPath`
       set must equal its `files[].path` set.
     - Read the staged manifest at `<dir>/pack.json.staged` and each staged
       file at `<dir>/files/<staged>` once, and apply the SHA-256 check above
       to the raw bytes of each. Keep the bytes Step 0.1 read (hash-checked
       when a command could run): Round 1's install and the prototype-key
       check in Step 0.4(c) use them, with no second read.
   - **No shell tool available.** If a Bash or other command-running tool is
     available, compute the hash as above. If you cannot run a command, do
     not work around it: write no scratch script; while verifying, make no
     `Write` or `Edit` outside `.groundwork/` (Round 1's confirmed installs are
     not part of verification), dispatch no subagent to look for a shell, and
     search for a command tool at most once. Skip only the SHA-256
     comparison. Run every other check in this block with the file tools
     (`Read`, `Glob`, `Grep`): the files exist, `staged === path + ".staged"`,
     the paths are relative with no `..`, `\` or `:`, no duplicates, `dir`
     and `suffix` exact, the `absent` conflicts and `stagedBaseline.files`
     name the same set, and no extra staged file exists: list the staged
     files with the `Glob` pattern `.groundwork/baseline/**/*.staged` and
     compare with `stagedBaseline.files`. A `Glob` can skip hidden paths
     (most staged files are dot-paths), honour an ignore file or truncate a
     long list, so a result shorter than `stagedBaseline.files.length`, or
     that looks truncated, is undetermined: report it in the Step 0.4 summary
     and continue, since every listed entry's existence is already checked
     one by one; only an extra `*.staged` file, one whose path is not in
     `stagedBaseline.files`, stops the run. Run the same structural checks
     for `inventory.stagedPacks`: each pack's `<dir>/pack.json.staged` and
     every `<dir>/files/<staged>` exists, `staged === path + ".staged"` with
     paths that are relative and free of `..`, `\` and `:`, no duplicates,
     `name`, `dir`, `suffix`, `manifest.path` and `manifest.staged` exact,
     the pack names in `inventory.packs` and `inventory.stagedPacks` the
     same set, and each pack's `fileConflicts[].relPath` and `files[].path`
     the same set. List each pack's staged files with the `Glob` pattern
     `.groundwork/packs/*/files/**/*.staged` (the same hidden-path and
     truncation caveats apply) and compare with that pack's `files`: an
     extra `*.staged` file not named there stops the run. This is a partial no-shell
     substitute for what the hash proves, and it is not tamper-resistance.
     Then spend no further turns on verification and go on to the deep
     read. State this plainly at the top of your first message to the user (the Step 0.4 summary, not a
     separate earlier stop), and ask whether to continue or stop in that
     same confirmation: the SHA-256 check was skipped because no command
     could be run; a passing check would only have proven that the staging
     is complete and matches the inventory, not that the files are
     untampered; and which structural checks you did verify instead. Also
     record the skip in `.groundwork/adoption-report.md` when you write the
     findings back in Step 0.3. A structural failure, including an extra staged file, still stops, exactly as the stop list below says.
   - An empty `files` list is legitimate (nothing was missing from the
     project) and creates no `.groundwork/baseline/` directory; that alone is
     not a failure.
   - **For a schema 5 inventory, a `stagedBaseline` that is missing, not an
     object, or whose `files` is not an array also stops the run** (a
     `files: {}` is not an empty list); so does a `stagedPacks` that is
     missing or not an array, or a pack entry that is not an object or whose
     `files` is not an array. **Any invalid entry, missing file or hash mismatch (including a
     wrong `dir` or `suffix`), any duplicate `staged` or `path` or pack `name`, any
     `absent` conflicts and `stagedBaseline.files` that do not name the same
     set, any pack whose names or file paths disagree with `inventory.packs`, and
     (no-shell path) an extra `*.staged` file not named in
     `stagedBaseline.files` or in a pack's `files`
     means stop -- all of Round 1, including conflicts and packs -- and
     change nothing.** This is the single stop list for the staged baseline and the staged packs.
     Tell the user: "The staged baseline in `.groundwork/baseline/` or a staged pack in `.groundwork/packs/` is incomplete or does not match `.groundwork/inventory.json` (<the first entry that failed and why>). Re-run `npx @monte3l/groundwork@rc .` and then run `/customize` again." **Never fall back to `inventory.templateRoot` for a schema 5 inventory, packs included:** that fallback exists for a schema 1-4 inventory only, and only for the baseline additions (a schema 1-4 inventory's packs are read from their unsuffixed copy, see Step 0.4(c) and Round 1).
   - What a passing check proves: the staging is complete and matches the
     inventory. It does **not** prove the files are untampered -- anyone who
     can edit the staged files can edit the inventory's hashes too.

   An inventory with `schemaVersion` below 5 has no staged copy; its
   approved additions are read from `inventory.templateRoot` (see Round 1).

2. **The deep read.** The CLI's survey is an index, not an interpretation —
   it flagged what it found but could not parse (`needsReading: true` on
   git-hook config, workflow files; anything in `survey.undetermined`) and
   what it could only index, not summarize (`docs`). Read all of it for
   real: the eslint config, the git-hook manager's actual stage commands,
   the CI workflow job steps, `CLAUDE.md`, `CONTRIBUTING.md`, and any
   docs/ADR files the survey indexed. Dispatch this as parallel read-only
   `Explore` agents, one per discovery area (shape/toolchain, harness, docs),
   so you aggregate their findings rather than reading everything yourself.
   The harness agent also starts from `inventory.harnessGrade` (the report's
   `## Harness grade` section): a deterministic, offline check of the
   existing `.claude/` wiring. Its **wiring findings** (a hook registration
   naming a missing file, a skill or agent with unreadable frontmatter, a
   `CLAUDE.md` path that no longer exists) are facts to verify against the
   real files, not verdicts to take on trust. Its **quality findings** are
   advisory. `inventory.harnessConformance` counts how far the harness has
   drifted from the baseline's — information only, since divergence from the
   baseline is the point of adopting. An inventory with `schemaVersion` below
   3 carries neither field; skip this and continue.

   The toolchain agent likewise starts from `inventory.toolchainGrade` (the
   report's `## Toolchain grade` section): a deterministic, offline check of
   the tsconfig chain, ESLint and vitest config, verify-step wiring, and
   toolchain pins. It reads files and never runs them, and it reads
   `eslint.config.js`/`vitest.config.ts` by pattern rather than by evaluating
   them -- so a **wiring finding** (a build project that emits nowhere, a
   verify step naming a script or file that does not exist, a `.node-version`
   that contradicts `engines.node`) is a fact to verify against the real files,
   and a **quality finding** (a missing strict flag, an option TypeScript has
   deprecated, ESLint without type-aware linting, a coverage gate that is not
   per-file) is advisory. Absence is never a finding: a project with no vitest
   config simply has no coverage-gate line. `inventory.toolchainConformance`
   counts drift from the baseline's toolchain files -- information only. An
   inventory with `schemaVersion` below 4 carries neither field; skip this and
   continue.

3. **Write the findings back** into `.groundwork/adoption-report.md`,
   replacing the CLI's index-level sections ("a `lefthook.yml` exists")
   with semantic ones ("pre-push runs lint and typecheck; tests do not
   gate"). If the no-shell bullet in step 1 applied, carry its skip note
   into the rewritten report: this step replaces the report's sections, so
   a note written earlier would be dropped.
4. **Confirm.** Give a short summary in chat, then ask **one**
   `AskUserQuestion` covering: (a) _did this miss anything about your
   project?_ — the free-text option is the point of this question, not a
   formality — (b) the conflict resolutions from the inventory's conflict
   table, batched by facet (toolchain config, harness) rather than one
   question per file (the harness facet's batch also carries any wiring
   findings you confirmed in the deep read, offered as fixes to make, and the
   toolchain facet's batch does the same for confirmed toolchain wiring findings) — and
   (c) **which pack(s) to install**, from `inventory.packs`. For each pack, show its `budget`, its
   `wiringObservations` (facts about how it would land — e.g. "no
   `bin/lib/verify-steps.packs.json` found: no `bin/verify.mjs`-shaped gate
   runner detected", or "`.claude/settings.json` already sets a top-level
   `statusLine`"), and its `adoptNotes` verbatim; a pack whose gate
   dependency the project doesn't have is still offered for its other
   artifacts, with that limitation stated plainly rather than silently
   dropped. This is index-level evidence from the CLI, not a kind-based
   judgment — see Step 3's note on revisiting it once the interview confirms
   the project's kind.

   The same question also carries (d) if the no-shell bullet applied: say the
   SHA-256 check was skipped, what a passing check would have proven,
   which checks ran instead and any undetermined result, and
   ask whether to continue or stop.

   Before offering any pack, check each staged `.groundwork/packs/<name>/pack.json.staged` (the bytes Step 0.1 read, hash-checked when a command could run; not a fresh read):
   if `__proto__`, `constructor` or `prototype` is a key of its `wiring.settings`
   (hook event names), `wiring.settingsTopLevel` or `wiring.packageScripts`
   (script names), stop. The project tree is untrusted, and the CLI refuses such a
   pack before staging it, so a staged manifest carrying one was edited after
   staging. Name the pack, the field and the key, tell the user to delete
   `.groundwork/` and re-run the CLI, and offer nothing from this run. Change nothing.
   For a schema 1-4 inventory (the layout of the CLI releases before the `.staged` convention) there is no `.staged` copy and no hash: read the unsuffixed `.groundwork/packs/<name>/pack.json` (not hash-verified) and run this same prototype-key check on it.

5. **Record the confirmed decisions** to `.groundwork/adoption-decisions.json`
   so a compacted or resumed session doesn't silently lose them and re-ask.
   A CLI re-run deletes this file along with the old inventory, because its
   decisions were made against the previous staging; a decisions file found
   beside a fresh inventory therefore belongs to this inventory.

## Step 1 — Interview

**Fresh bootstrap:** ask the following in **two** `AskUserQuestion` calls
(the tool caps a single call at four questions), each with a sensible
default marked "(Recommended)":

Call one (four questions):

1. **Project kind** — library / CLI / frontend or web app / service.
2. **Runtime target** — Node / browser / both.
3. **Tests mandatory in the pre-push gate?** — yes (default; matches the
   baseline) / warn only.
4. **CI depth** — minimal / standard (default; matches the baseline) /
   thorough.

Call two (one question):

5. **Which baseline agents to keep** — multi-select over `Explore`,
   `test-author`, `code-implementer`, `code-reviewer`,
   `silent-failure-hunter` (all kept by default).

**Adopt mode:** ask the same five questions, but this becomes a
_confirmation_ round rather than a cold ask. Pre-select each answer from
Step 0's findings and **show the evidence alongside it** — "library — you
have an `exports` map and no `bin` field", not just a silent default. The
user confirms or corrects each one. This is why the CLI's survey deliberately
never names a `ProjectKind` itself (see its own `types.ts`): the inference
happens once, here, visibly, with its reasoning attached — not buried in an
offline heuristic no one reviews.

Packs are **not** re-asked here — Step 0.4 already collected that decision
(adopt mode) or the CLI already installed at bootstrap time via `--pack`
(fresh mode, nothing left to ask). Step 3 below is where a confirmed kind can
revise a pack decision made before the interview ran.

## Step 2 — Plan facets (deterministic)

Read `kind-facet-map.ts`, alongside this file in the same skill
directory — a small, pure, unit-tested module (its canonical, tested source
lives in the m3l-groundwork repo at `packages/plugin/src/kind-facet-map.ts`;
this is a verbatim copy the bootstrapper placed here so the skill is
self-contained). Its `planFacets(answers)` function is the kind-to-facet
table: the same five answers always produce the same facet-emphasis plan
for both sweeps. You do not need to run it as code — it's short enough to
apply by inspection.

State the resulting plan in your response before proceeding — this is what
Round 2's two skill invocations will be told to emphasize.

## Step 3 — Round 1: deterministic tailoring

**Fresh bootstrap** applies directly, no research needed:

- **Project kind ≠ library**: if `check:exports` (publint/attw) doesn't
  apply to the chosen kind (CLI, frontend, service), remove the
  `check:exports` step from `bin/lib/verify-steps.mjs` and the
  corresponding `.github/workflows/ci.yml` line, and drop the `exports`
  field from `package.json` in favor of a `bin` field (CLI) or leave `main`/
  no public export map at all (service).
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
  project doesn't have and the user approved adding. For a schema 5 inventory, install them from the staged copy Step 0.1 already verified,
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
  instead, state in Step 6 that it needs a manual install (point at `.groundwork/packs/<name>/` and the pack's own `adoptNotes`, and say to strip the `.staged` suffix from every name when copying by hand and to replace every `__KEY__` token with the project's real value) and stop
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
  not hash-verified; token substitution still applies) and read the wiring from
  the unsuffixed `pack.json`; then translate `pack.json`'s `wiring` by hand
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
  skip plainly in Step 6;
  `wiring.verifySteps` becomes a step in whatever this project's real gate
  runner is (a `package.json` script plus a line in its `lefthook.yml`/
  `.husky/pre-push`/CI workflow, written by hand to match its actual shape)
  — or, if the project has no such gate runner at all, install the pack's
  other artifacts and state plainly in Step 6 that the gate was not wired,
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
already-installed pack's skills (e.g. the `github` pack's three). Call
`recommendPlugins(answers, context)` from `plugin-map.ts`
(alongside this file, same copy mechanism as `pack-map.ts`) with the
now-confirmed `InterviewAnswers`, and ask **one** `AskUserQuestion`
(multi-select) offering all seven, pre-selected per each entry's
`recommended` boolean with its `because` shown as the evidence -- same
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
for any of the seven.

**Committing this entry does not install the plugin for anyone.** A
project-scope `enabledPlugins: true` with no local install produces no
folder-trust auto-prompt -- Claude Code's `/plugin` Errors tab instead shows
"enabled in project settings but isn't installed here" until someone runs
the install by hand. So for every newly-`true` entry, print the exact
follow-up command in Step 6's report: `claude plugin install <id> --scope
project` (or `/plugin install <id>` inside a running session) -- the user,
and every collaborator who pulls this change, still has to run it once. Do
the same for each recommendation's `prerequisites` (the
`typescript-language-server` binary, Python 3.8+) -- print them as
follow-ups, never attempt to install them.

Nothing else is touched. A project file the user didn't approve a change to
stays exactly as it was.

Run `pnpm verify` (fresh) or the project's own equivalent (adopt) after
Round 1's edits to confirm the tailored result still passes before moving to
Round 2.

## Step 4 — Round 2: the guidance pass

Invoke both guidance skills in **refresh mode**, in parallel:

```
Skill(skill: "typescript-guidance", args: "mode: refresh")
Skill(skill: "harness-guidance", args: "mode: refresh")
```

Each sweep reads its own tracker (`docs/research/typescript-refresh.md` /
`docs/research/harness-refresh.md`), fans out its five fixed facets — using
Step 2's plan to decide which facet gets the deepest attention this run,
not which facets it's allowed to touch — and enters plan mode with a
remediation plan if it finds drift.

Also offer `typescript-guidance`'s `gaps` mode here, for gaps rather than
drift — what TypeScript-ecosystem tooling the project is missing entirely, as
opposed to either sweep's "is what's already configured still current." It
is not a third mandatory sweep: run it only if the user wants a tooling-gap
pass alongside the two refreshes.

**In adopt mode**, a sweep's domain is the project's real files, classified
by `domain-map.ts`'s `classifyPath` (the same module and glob lists that
guard the emitted baseline — broadened to cover common non-baseline
equivalents like `.eslintrc.*`/`jest.config.*`/`.husky/**`). A config file
that classifies as `uncovered` is a **reportable coverage gap**, exactly the
adopt-mode analogue of the structural test that guards `templates/core` —
name it in Step 6's report rather than silently skipping it.

**Applying findings.** A Round 2 finding carrying an allowlisted source URL
outranks both the baseline and Round 1, and should be applied. Name in your
final summary every place the findings disagreed with what Round 0/1
shipped — that disagreement list is the feature: it's the evidence the
baseline had gone stale.

**The one exception.** Where a finding would undo an **explicit interview
answer** from Step 1 — the user said tests must not gate `pre-push`,
guidance says they should — surface the conflict and leave the user's
answer standing. Guidance refines the _how_; the interview sets the _what_.
Record the conflict in the relevant tracker either way, so it isn't silently
rediscovered next sweep.

## Step 5 — No network

If neither guidance skill can reach its sources (offline, sandboxed, no
`WebFetch`/`WebSearch` available): **skip Round 2 entirely, say so plainly,
write no tracker update, and leave Rounds 0 and 1 standing.** A tracker
stamped with a `last-verified` date and no real sweep behind it is worse
than an honest `unset` — the next sweep would trust a lie. Report exactly
which round the customization stopped at.

## Step 6 — Report

One-line-per-item summary: the five interview answers, what Round 1 changed
deterministically, what Round 2's two sweeps found and applied (or "skipped
— no network"), and the current state of both trackers (`last-verified=` and
outstanding drift, if any). **In adopt mode**, add: what Step 0 found that
the CLI's report missed (if anything), which conflicts were resolved and
how, any domain-map coverage gap Step 4 surfaced, and **which packs were
installed and what each wired** (or, for a pack whose gate had no runner to
attach to, that it was skipped and why).

Also list **which plugins were enabled** (each newly-`true`
`enabledPlugins` entry, with the exact `claude plugin install <id> --scope
project` follow-up command it still needs) and which were offered but
declined, plus any prerequisite named against an enabled plugin
(`typescript-language-server` on `PATH`, Python 3.8+) as a follow-up the
user still has to satisfy.
