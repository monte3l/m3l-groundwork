# Update: the scoped `/customize update` procedure

> The whole procedure for `/customize update`, which `SKILL.md`'s router sends here. Read this whole file before acting, and re-read it after a compaction: a compacted session keeps only the start of `SKILL.md`.

Skill version: 1.6.0 <!-- x-release-please-version -->

`m3l-groundwork <dir> --update` staged an update of the project's baseline
into `.groundwork/update/` and changed nothing else: theirs (the new
release's version of a file) under `files/<path>.staged`, a clean or
conflicted merge under `merged/<path>.staged`, an old base recovered from
the template history under `base/<path>.staged`, each ledger pack's current
manifest under `packs/<name>/pack.json.staged`, the CLI's `/customize`
payload under `customize/<name>.staged`, the proposed lock `lock-next.json`
and, last, `plan.json`. This procedure applies that staging, and nothing
else. There is no interview: it skips the interview, the Step 0 reconcile,
Round 2 and Step 7's report entirely, and it never writes
`adoption-decisions.json` or `customization-report.md`.

`plan.files` holds one entry per file: its `path`, `source` (`core`,
`skill` or `pack:<name>`), `action`, `default` (`apply`, `ask` or `skip`),
`reason`, the three sides' hashes (`baseSha256`, `oursSha256`,
`theirsSha256`), `renamedTo` for a rename, `keyDiffs` for a JSON merge,
`conflicts` for a text conflict, and `staged` (`theirs`, `merged`, `base`:
paths relative to `.groundwork/update/`). The actions: `take`, `add`,
`merge`, `delete` and `rename` change a file; `conflict` and `review` need
the owner; `current`, `keep` and `skip` leave it alone.

1. **Locate the plan.** Require `.groundwork/update/plan.json`. When it is
   missing, tell the user to run `npx @monte3l/groundwork . --update` first,
   and stop.
2. **Gate before reading anything else.** Check `schemaVersion` first: this
   skill understands schemaVersion 1. If it is higher, the CLI that wrote it
   is newer than this plugin, so stop, change nothing and tell the user to
   update the plugin and run `/customize update` again. The plan's `kind`
   must be `m3l-groundwork/update-plan`; any other value, or a `plan.json`
   that is not valid JSON, stops the same way. Compare the Skill version line
   above with the plan's `cliVersion`: if the plan's `cliVersion` is newer
   than this skill, refuse and stop, telling the user to update the plugin
   (or to replace `.claude/skills/customize/` with the copy staged in
   `.groundwork/update/customize/`, dropping the `.staged` suffix) and run
   `/customize update` again. Then validate what the record step will
   rewrite, before asking anything: `.groundwork/installed-packs.json` (when
   it exists), `.groundwork/groundwork.lock.json` (when it exists) and
   `.groundwork/answers.json` (when it exists) must each be valid JSON, the
   ledger's and the lock's `schemaVersion` must be 1, and no key or ledger
   `name` may be `__proto__`, `constructor` or `prototype`. Otherwise show
   the file to the user and stop, with nothing written.
3. **Verify before trusting any staged byte.** Hash every file the plan's
   `staged.files` list names with `shasum -a 256` (or the `node -e` SHA-256
   one-liner from the reconcile step file) and compare each against its
   `sha256` there; that includes `lock-next.json`, every pack manifest and
   every `customize/` file. A mismatch or a missing file stops the run and
   changes nothing: tell the user to re-run
   `npx @monte3l/groundwork . --update`. An extra `*.staged` file that the
   list does not name stops the run the same way, wherever it sits in the
   staging directory. If there is no shell to run a command in, say the check could not
   run and stop: nothing is applied, and the staging is kept. Do not offer,
   suggest or accept continuing without the hash check. When the check
   could not run, do not state or imply that any staged file, the lock's
   hash or the working tree was checked or matches; you may relay what
   `plan.json` says, only as the plan's own statement. Never call any
   file's hashes matching; for the skill copy give only `skill.status`.
   To continue, say to run `/customize update` again with a shell:
   re-running `--update` only re-stages and applies nothing. Run the
   prototype-key check on each `packs/<name>/pack.json.staged`: if a key of
   its `wiring.settings`, `wiring.settingsTopLevel` or
   `wiring.packageScripts` is `__proto__`, `constructor` or `prototype`,
   stop and change nothing. The plan's `targetDir` must resolve to the
   current project (the same directory, not a parent, a sibling or an older
   checkout); otherwise stop. The plan's `base.lockSha256` must equal the
   SHA-256 of the current `.groundwork/groundwork.lock.json` (`null` means
   there was no lock, and there must still be none); otherwise the lock
   changed since staging, so stop and tell the user to re-run `--update`.
   Then re-hash each target path: when a file's current hash is no longer
   the entry's `oursSha256` (`null` meaning absent), the project changed it
   since staging, so promote that entry to `review` with that reason. For a
   rename, its `renamedTo` path must also still be absent, or the entry
   becomes `review` too, with that reason. Use the bytes you read here for
   the apply, never a second read.
4. **Show the plan, verbatim and without paraphrasing:** `plan.base`
   (`version`, `source`), `cliVersion`, `origin`, `summary`, every entry of
   `plan.files` whose action is not `current` (its path, action, default and
   reason, plus any `keyDiffs` and `conflicts`), `plan.packs` (each pack's
   `outdated` flag and its wiring `added`, `removed` and `changed`, with
   each removed item's `removable` flag, each changed item's `applies` flag
   and, when a flag is false, its `reason`), `plan.migrations` (each entry's
   `id`, the `since` version, and its `renames` (`from`, `to`) and
   `removedWiring` (`pack`, `item`)), `plan.skill.status` and every
   `plan.undetermined` note. When the user needs to compare a file, read both the project file
   and the staged one.
5. **Check it is safe to apply.** The project must be a git worktree:
   `git rev-parse --is-inside-work-tree` must print `true`, or stop. Run
   `git status --porcelain -z --` over the touched paths: every path an
   entry would write, delete or rename, both ends of a rename (its path and
   its `renamedTo`), each `.claude/skills/customize/<name>` payload file
   step 8 would refresh, and the wiring files a pack update edits. If it prints anything, list them and
   stop: the user commits or stashes those first. Unrelated dirty files are
   fine and do not block the update.
6. **Confirm.** Ask one bulk question first: apply the defaults (every entry
   whose `default` is `apply`), choose one by one, or skip them all. Then ask
   one `AskUserQuestion` per remaining `conflict`, `review` or `rename`
   entry, and per entry whose `default` is `ask`, with the options keep
   yours, take groundwork's, resolve with me and skip. Keep yours leaves the
   project file as it is (for a rename, moves it to `renamedTo` unchanged).
   Take groundwork's writes theirs; for a `review` entry whose
   `theirsSha256` is `null` (the release dropped the file), it deletes the
   file. Resolve with me merges the two with the
   user, starting from `merged/<path>.staged` when it is staged. A dismissed
   question is skip: nothing changes for that entry. Ask per pack too, here
   and only here, once per item: apply its wiring `added` items; apply each
   `changed` item that `plan.packs[].wiring.changed[].applies` marks true;
   drop each removed item that `plan.packs[].wiring.removed[].removable`
   marks true, only when the user confirms that removal. An item whose flag
   is false is not offered: it stays as the project has it, and the report
   gives its `reason`. Nothing is written to a project
   file before this. A text conflict is staged with `<<<<<<<`, `|||||||`,
   `=======` and `>>>>>>>` markers: never write a file that still contains
   conflict markers, whatever the user chose.
7. **Branch before you apply.** Create the branch
   `groundwork/update-<base>-to-<cli>` (`plan.base.version` and
   `plan.cliVersion`) with `git switch -c`, before the first apply. If the
   branch already exists, stop and ask.
8. **Apply.** For each confirmed entry: `take`, `add` and a take
   groundwork's choice write the verified `files/<path>.staged` bytes to
   `path` (the `.staged` suffix stripped); a clean `merge` writes
   `merged/<path>.staged`; `delete` removes the file; `rename` moves the file
   to `renamedTo`, writing theirs there unless the user kept yours; a
   `review` entry whose `theirsSha256` is `null` and that the user took
   groundwork's on is deleted. Then
   update each outdated pack by reading and following
   [`pack-install.md`](pack-install.md) in full, its "Update an installed
   pack" section, with the staging root `.groundwork/update/packs/<name>/`,
   applying the wiring answers step 6 collected without asking again.
   `plan.migrations` needs nothing more: its renames are already `rename`
   entries in `plan.files`, and its `removedWiring` items are removals in
   the pack's wiring diff. Refresh `.claude/skills/customize/` last, and
   only when the project already keeps a copy there (`plan.skill.status`
   `current` or `stale`; write nothing when it is `absent`, and leave an
   `unusable` one alone and say why): write each
   `customize/<name>.staged` to `.claude/skills/customize/<name>`, touching
   the payload names only, never another file in that directory, with
   `SKILL.md` written last.
9. **Offer the setup steps, then run the gate.** Print each updated pack's
   `setupSteps` (from its `pack.json.staged`) and offer to run them; never
   run them unasked. Run the project's gate: `pnpm verify` for a project the
   CLI bootstrapped, or the project's own equivalent for an adopted one.
   Report the result honestly: a failure is reported with its output, not
   hidden or retried until it passes.
10. **Record.** Rewrite `.groundwork/groundwork.lock.json` from
    `lock-next.json`, patched with the user's choices: `lock-next.json`
    assumes every default was accepted, so for an `apply` entry the user
    skipped, restore the previous lock's record of that path; for an entry
    the user applied or resolved, record its path with `baseSha256` set to
    `theirsSha256` and `status` `installed`; for keep yours, record
    `theirsSha256` with `status` `kept`. For a rename, drop the old path's
    record and record `renamedTo` with the `sha256` of its `staged.theirs`,
    as `staged.files` lists it; for an `apply`-default rename the user skipped, remove
    the `renamedTo` record and restore the old path's previous record; for
    keep yours on a rename, the record is under the `renamedTo` path, where
    the file now sits. A `review` entry whose `theirsSha256` is `null` and
    that the user took groundwork's on is a delete: drop its lock entry, and
    never write a `baseSha256` of `null`. Set `updatedAt` to the current
    time. Then move the base snapshot forward: copy `files/<path>.staged` to
    `.groundwork/base/<path>.base` (at `renamedTo` for a rename) for every
    entry whose theirs is staged, except one the user skipped, whose old base
    stays; for a `current` entry, copy the unchanged project file there.
    Delete a `.base` copy only for deleted paths and the old path of every
    rename. Write each updated pack's ledger entry per pack-install.md's
    **Record the pack** step, with `via: "update"` and `cliVersion` from
    `plan.cliVersion`. Finally, delete `.groundwork/update/`.
11. **Report, briefly,** and offer a commit: what was applied, kept, skipped
    and resolved, each pack's wiring applied and skipped, the gate's result,
    the `setupSteps` still to run, and that a Claude Code restart may be
    needed before new hooks take effect. Offer to stage the update with
    `git add -- <touched>` only: the full set step 5 listed (every written,
    deleted or renamed path, both ends of a rename including its
    `renamedTo`, the `.claude/skills/customize/` payload files and the
    wiring files), plus the lock, the ledger and `.groundwork/base/`, and to commit it as
    `chore(groundwork): update baseline <a> -> <b>`. This skill does not
    commit unless the user accepts that offer, and it must never make a
    commit unasked. Never push.
