# Step 0 — Reconcile (adopt mode only): detail

> Full text of Step 0 from `SKILL.md`. Read this whole file before acting on Step 0, and re-read it after a compaction: a compacted session keeps only the start of `SKILL.md`.

Contents:

1. Look for `.groundwork/inventory.json` (fresh vs. interrupted vs. adopt)
2. The deep read (the survey is an index, not an interpretation)
3. Write the findings back into `.groundwork/adoption-report.md`
4. Confirm (one `AskUserQuestion` round: additions, conflicts, packs)
5. Record the confirmed decisions to `.groundwork/adoption-decisions.json`

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
   skill understands schema versions **1 through 6** (the highest it knows is
   6). If `schemaVersion` is **higher than 6**, the CLI that wrote it is newer
   than this plugin: **stop and change nothing**, do not interpret the
   inventory (a newer schema may have renamed or repurposed fields, and a
   confident misreading is worse than none), and tell the user to update the
   plugin and re-run `/customize`. Say which update applies to the copy
   that is running. For the plugin install, run `/plugin update`. For a
   project-local copy in `.claude/skills/customize/`, `/plugin update` does
   not touch it, and re-running the CLI alone does not either: the CLI
   never overwrites a copy that differs (nor removes any other entry the
   project owns there, nor writes through a symlinked `.claude`), it writes a
   fresh one to `.groundwork/customize/`, which Claude Code does not load. So delete
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
   | 6               | `survey.harness.pluginLayout`: `null`, or `{ manifest, components }` when the project root holds `.claude-plugin/plugin.json` (`components` lists which of `hooks/hooks.json`, `skills/`, `agents/`, `commands/`, `.mcp.json` exist)                                                                                      | no plugin-layout evidence; ask the project kind cold rather than pre-selecting one                                               |

   **For a schema 5 or later inventory: verify the staged baseline now, before
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
     `stagedBaseline.files[].path` and its `.staged` name, `stagedPacks[].dir`,
     `stagedPacks[].files[].path` and `stagedPacks[].files[].staged`. Other paths in
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
     `.groundwork/packs/**/*.staged` (the same hidden-path and
     truncation caveats apply) and compare with every listed manifest and
     file: an extra `*.staged` file at any depth under `.groundwork/packs/` that is neither a listed manifest nor a listed file stops the run. This is a partial no-shell
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
   - **For a schema 5 or later inventory, a `stagedBaseline` that is missing, not an
     object, or whose `files` is not an array also stops the run** (a
     `files: {}` is not an empty list); so does a `stagedPacks` that is
     missing or not an array, or a pack entry that is not an object or whose
     `files` is not an array. **Any invalid entry, missing file or hash mismatch (including a
     wrong `dir` or `suffix`), any duplicate `staged` or `path` or pack `name`, any
     `absent` conflicts and `stagedBaseline.files` that do not name the same
     set, any pack whose names or file paths disagree with `inventory.packs`, and
     (no-shell path) an extra `*.staged` file not named in
     `stagedBaseline.files`, a pack's `files` or a pack's manifest
     means stop -- all of Round 1, including conflicts and packs -- and
     change nothing.** This is the single stop list for the staged baseline and the staged packs.
     Tell the user: "The staged baseline in `.groundwork/baseline/` or a staged pack in `.groundwork/packs/` is incomplete or does not match `.groundwork/inventory.json` (<the first entry that failed and why>). Re-run `npx @monte3l/groundwork@rc .` and then run `/customize` again." **Never fall back to `inventory.templateRoot` for a schema 5 or later inventory, packs included:** that fallback exists for a schema 1-4 inventory only, and only for the baseline additions (a schema 1-4 inventory's packs are read from their unsuffixed copy, see Step 0.4(c) and Round 1).
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
   The harness agent also reads `survey.harness.pluginLayout` (schema 6): a
   project with a `.claude-plugin/plugin.json` ships hooks, skills and agents
   at the repository root, which the harness grade below does not cover, so
   read those too. It starts from `inventory.harnessGrade` (the report's
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
