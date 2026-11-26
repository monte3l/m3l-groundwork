# Pack install: staged-pack install procedure

> Installs one approved pack from its staged copy (adopt Round 1: `.groundwork/packs/<name>/`; `/customize add-pack`: `.groundwork/add-pack/<name>/`). Read this whole file before installing a pack, and re-read it after a compaction.

**Where the staged copy lives.** Two paths follow this file, and both use the
same `.staged` convention (`pack.json.staged`, `files/<path>.staged`) and the
same SHA-256 hashes:

- **Adopt Round 1** reads `.groundwork/packs/<name>/` and checks it against
  the inventory (`inventory.stagedPacks`), as the text below says.
- **`/customize add-pack`** reads `.groundwork/add-pack/<name>/` and checks it
  against that directory's `plan.json` (`plan.staged`). Read the procedure
  below with that staging root in place of `.groundwork/packs/<name>/`; "the
  bytes Step 0.1 read" are the bytes add-pack.md's verification step read,
  "Step 0.2's deep read" is your own read of the project's gate and settings,
  "Step 7" is add-pack.md's final report, and `round1.dropped` is the ledger
  entry's `dropped` list (see the last step). Its plan never targets a schema
  1-4 layout, so the unsuffixed fallback below does not apply. The `modes`
  check below tests `plan.requiredMode` (`"fresh"` for a project the CLI
  bootstrapped, `"adopt"` for an adopted one) in place of `"adopt"`.

**Project shape.** For a project the CLI itself bootstrapped (it has
`bin/verify.mjs` and `bin/lib/verify-steps.packs.json`), the wiring lands in
three JSON files, applying the CLI's own merge semantics by hand. In
`.claude/settings.json`, the pack's `hooks` are merged entry by entry,
add-only. Each `settingsTopLevel` key is planted only when the key is absent
or identical; otherwise ask. In `package.json`, `scripts` are add-only, and a
different existing script under the same name is a collision to ask about.
In `bin/lib/verify-steps.packs.json`, each of the pack's `verifySteps` is
appended by `id`, and the same `id` with different content is a collision.
For any other project, translate the wiring by hand against the project's
real gate, as the procedure below says.

Before installing, check the
pack's own `modes`: a pack whose `modes` doesn't include `"adopt"` (today,
`publishing` — its release flow encodes decisions too project-specific to
apply blind — and `licensing`, whose one-time SPDX header backfill fails an
established project's `pnpm verify`) is never auto-installed here even if staged and approved;
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
hook fragment merges the same way the baseline's own hook entries would, and when the project already registers the same hook `command` (a pack installed before it gained a key such as `onFailure`), add only the keys the fragment has and the existing registration lacks, keep every field the project already sets, and ask before changing a key both define with a different value (the CLI's `mergeSettingsHooks` never overwrites one);
`wiring.settingsTopLevel` is a set of top-level keys (e.g. `statusLine`)
planted whole, and only when the project doesn't already define that key —
when it does, show the existing value and ask, since the CLI's own
`mergeSettingsTopLevel` treats a differing value as a hard error and this
hand-applied path must not be laxer than the automated one (also check
`.claude/settings.local.json` and the user's `~/.claude/settings.json`,
either of which can shadow a project `statusLine`). For `statusline`
specifically, a `statusLine` collision is never a reason to fail the whole
pack install: skip that key and the two scripts that render it
(`statusline.mjs`, `statusline-layout.mjs`), install only the
`subagent-rows` plugin under `.claude/skills/subagent-rows/` (an existing
file there is a file collision as usual), and state the skip plainly in
Step 7. A project that still carries a `subagentStatusLine` key keeps it
untouched: tell the owner it is deprecated and can be removed (the mod's
row text overrides it), and never remove it without asking. The pack is separate from `harness-extras` for exactly this reason,
so a skipped status line never costs the compaction-handoff hooks or
`guard-readonly-bash`. For `harness-extras`, `guard-readonly-bash.mjs` imports
`bin/lib/agent-roster.mjs`: when the project keeps no agents and that file is
not being installed, skip that one hook too (the pack's `adoptNotes` allow
it), record it in `round1.dropped` and say in Step 7 that it was skipped and
why;
`wiring.verifySteps` becomes a step in whatever this project's real gate
runner is (a `package.json` script plus a line in its `lefthook.yml`/
`.husky/pre-push`/CI workflow, written by hand to match its actual shape)
— or, if the project has no such gate runner at all, install the pack's
other artifacts and state plainly in Step 7 that the gate was not wired,
rather than inventing a runner the project never asked for.

## Record the pack

The final step, once the pack's files and wiring are in place: record it in
`.groundwork/installed-packs.json`, the installed-packs ledger. Only
`/customize` writes it; the CLI only reads it. Read the existing ledger first.
When it is absent, start from `{ "schemaVersion": 1, "packs": [] }`. If it is
invalid JSON, has an unknown or higher `schemaVersion` than 1, or holds an
entry whose `name` is `__proto__`, `constructor` or `prototype`, stop, show it
to the user and never overwrite it; the pack stays installed, unrecorded, and
the report says so. (add-pack.md runs the same check before its first
question, so on that path it stops before anything is installed.) When the
ledger is valid, add this pack's entry, or replace the entry of the same name
(a reinstall), and keep the other entries semantically unchanged (the ledger
is re-serialised, so their formatting may change). The entry's shape:

```json
{
  "name": "quality",
  "installedAt": "2026-01-01T00:00:00.000Z",
  "via": "add-pack",
  "cliVersion": "1.0.0",
  "manifestSha256": "<sha256 of pack.json.staged>",
  "files": [{ "path": "bin/check-file-budget.mjs", "sha256": "<sha256>" }],
  "wiring": {
    "applied": ["verifySteps:file-budget"],
    "skipped": [{ "item": "settingsTopLevel:statusLine", "reason": "..." }]
  },
  "dropped": [{ "path": "...", "reason": "..." }]
}
```

`name` is the pack's name and `installedAt` the current time as an ISO 8601
string. `via` is `"add-pack"` (followed from add-pack.md) or
`"adopt-round-1"` (followed from adopt Round 1); `"fresh"` names a pack the
CLI installed at bootstrap with `--pack`; the CLI writes its ledger entry
itself, so this skill never writes that value. `"update"` is reserved for `/customize update`. `cliVersion` is `plan.cliVersion` for
add-pack or `inventory.cliVersion` for adopt. `manifestSha256` is the SHA-256
of the verified `pack.json.staged` bytes. `files` lists every file the pack
installed by its project path, and each `sha256` is the SHA-256 of the
installed bytes (after token substitution); `sha256` is `null` for a file the
user kept theirs on. `wiring` lists each wiring item as `applied` or
`skipped` with its reason, and `dropped` lists each file or hook left out
with its reason.
