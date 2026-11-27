# Add a pack: the scoped `/customize add-pack` procedure

> The whole procedure for `/customize add-pack <name> [<name>...]`, which `SKILL.md`'s router sends here. Read this whole file before acting, and re-read it after a compaction: a compacted session keeps only the start of `SKILL.md`.

`m3l-groundwork <dir> --add-pack <name>` staged each pack into
`.groundwork/add-pack/<name>/` (inert `pack.json.staged` and
`files/<path>.staged`, then `plan.json` last) and installed nothing. This
procedure installs those staged packs into a project that is already set up,
and nothing else. It skips the interview, the Step 0 reconcile, Round 2 and
Step 7's report entirely. It never writes `adoption-decisions.json` or
`customization-report.md`, and it never touches another pack's staging: only
the packs named in this run are read, installed or deleted.

1. **Parse the pack names** after `add-pack`, sorted and de-duplicated. Pack
   names must match `^[a-z][a-z0-9-]*$`; refuse any other name and say why.
   If no names are given, ask which of the packs staged under
   `.groundwork/add-pack/` to install, listing them (each directory there
   that has a `plan.json`). For each pack, require
   `.groundwork/add-pack/<name>/plan.json`. When it is missing, tell the user
   to run `npx @monte3l/groundwork . --add-pack <name>` first and stop for
   that pack; the other packs carry on.
2. **Gate on the plan's version.** Check `plan.schemaVersion` before reading
   anything else: this skill understands schema 1. If it is higher, the CLI
   that wrote it is newer than this plugin, so stop, change nothing and tell
   the user to update the plugin and run `/customize add-pack <name>` again.
   `plan.kind` must be `m3l-groundwork/add-pack-plan`; any other value (or a
   `plan.json` that is not valid JSON) stops that pack the same way. Then
   check the ledger: read `.groundwork/installed-packs.json` (when it exists)
   before the per-pack question, and if it is invalid JSON, has an unknown or
   higher `schemaVersion` than 1, or holds an entry whose `name` is
   `__proto__`, `constructor` or `prototype`, show it to the user and stop
   before asking anything, with nothing written; the Record step could
   never update it, so no pack is installed this run. (The CLI's own
   `--add-pack` run already refuses such a ledger before staging, so this is
   a backstop for a ledger edited since.)
3. **Verify before reading anything else.** Hash every staged file with
   `shasum -a 256` (or the `node -e` SHA-256 one-liner from the reconcile
   step file) and compare each against its `sha256` in `plan.staged` (the files
   under `plan.staged.files` and the manifest under `plan.staged.manifest`).
   That includes `pack.json.staged` itself, against its hash in
   `plan.staged`. A mismatch, a missing file, or an extra `*.staged` file
   that `plan.staged` does not list stops that pack and changes nothing:
   tell the user to re-run `npx @monte3l/groundwork . --add-pack <name>`. If
   no command can run at all, say the check could not run and stop: nothing
   is installed, and the staging is kept in `add-pack/<name>/`. Do not offer,
   suggest or accept continuing without the hash check; tell the user to
   re-run `/customize add-pack <name>` in a session where a command can run.
   Then run the prototype-key check on the wiring in
   `pack.json.staged` (the CLI's `loadPack` already refused a pack with such a
   key before staging it, and the hash check above binds those bytes, so this
   repeat only guards against a file edited since): if a key of its `wiring.settings`,
   `wiring.settingsTopLevel` or `wiring.packageScripts` is `__proto__`,
   `constructor` or `prototype`, stop and change nothing. Check that
   `plan.targetDir` resolves to the current project (the same directory, not
   a parent, a sibling or an older checkout); otherwise stop. Then check
   that `plan.installation.status` is still right by looking at the project
   itself, since a pack may have been installed meanwhile: when the project
   now has the pack's files or wiring and the plan says otherwise, show the
   difference and treat the install as a reinstall. Re-compare every target
   path of the pack against the staged bytes and the plan, at install time:
   a project file may have been created or changed since `--add-pack` staged
   the pack. Any file whose current state differs from what
   `plan.fileConflicts` recorded (a file recorded `absent` that now exists,
   or one recorded `identical` whose bytes no longer match the staged file)
   is treated as a divergent file and asked about in the per-file question
   of step 5. Never install over a changed file without that per-file
   decision. Use the bytes you read here for the install, never a second
   read of the staged copy.
4. **Show the plan, verbatim and without paraphrasing:** the pack's
   `adoptNotes` (`plan.pack.adoptNotes`), the `divergent` entries of
   `plan.fileConflicts` plus any file step 3 found changed,
   `plan.wiringObservations`, `plan.requires` (any missing paths the pack
   needs), and `plan.caps`, where an over-cap (`plan.caps.overCap`) is a
   WARNING to state plainly, never a blocker. Also show the proposed
   `plan.tokens` and any `plan.undetermined` notes. `plan.fileConflicts`
   holds one entry per target file, each with its `relPath`, a `status` of
   `absent`, `identical` or `divergent` and, for a divergent JSON file, the
   differing keys (`keyDiffs`); it holds no file contents. When the user
   needs to compare a file, read both the project file and the staged file.
5. **Confirm, one `AskUserQuestion` per pack:** install or skip. The same
   question carries the token values to use (the proposed ones as the
   default) and, for each divergent file, a keep theirs / take groundwork's /
   merge decision. A dismissed question is "skip": nothing installed for that
   pack. Nothing is written to a project file before this.
6. **Install each confirmed pack** by reading and following
   [`pack-install.md`](pack-install.md) in full, with the staging root
   `.groundwork/add-pack/<name>/`, the confirmed tokens and per-file
   decisions, and the bytes you read in step 3.
7. **Print the pack's `setupSteps`** and offer to run them (they are in
   `plan.pack.setupSteps`). Run only the ones the user accepts, and never run
   them unasked.
8. **Run the project's gate:** `pnpm verify` for a project the CLI
   bootstrapped, or the project's own equivalent for an adopted one. Report
   the result honestly: a failure is reported with its output, not hidden or
   retried until it passes.
9. **Write the ledger entry** for each installed pack, per pack-install.md's
   **Record the pack** step, with `via: "add-pack"` and `cliVersion` from
   `plan.cliVersion`.
10. **Clean up.** Delete only `.groundwork/add-pack/<name>/` for each
    installed pack, and `.groundwork/add-pack/` itself if it is now empty. A
    skipped pack keeps its staging, so it can be installed later.
11. **Report, briefly:** what was installed (its files, the wiring applied
    and skipped, anything dropped and why), what was skipped, the
    `setupSteps` still to run, and that a Claude Code restart may be needed
    before new hooks take effect (settings edits normally reload without
    one).
