# Step 3 — Conflicts: detail

> [!IMPORTANT]
> The conflict part of Step 3 from `SKILL.md`. Read this whole file before resolving any conflict, and re-read it after a compaction: a compacted session keeps only the start of `SKILL.md`.

## Step 3 — Conflicts

A conflict is a path the plan classed `conflict-3way` or `conflict-2way`.
Both you and upstream changed it, so nothing is written without an answer.

### Record every answer, and only once it is carried out

Conflict decisions live in `.groundwork/upgrade/decisions.json`, a JSON array
of `{"path": "<path>", "resolution": "keep|take|delegate"}` objects, one per
path. This shape is shared with the
`upgrade.conflicts` section of a headless answers file, so keep exactly these
two fields.

Record each answer after each write, rewriting the whole array so the file is
always valid JSON:

- Record `keep` immediately when nothing is written.
- Record `take` only after its write has finished.
- Never record `delegate` until the confirmed merge is written.
- For a JSON file with `jsonKeys`, record any resolution, `keep` included,
  only after its one write has finished.

```json
[
  { "path": "eslint.config.js", "resolution": "keep" },
  { "path": ".claude/settings.json", "resolution": "delegate" }
]
```

After a compaction or a resume, re-read `decisions.json` first. A path it
lists is decided: never re-ask it, and never apply it twice. Continue with
the first conflict it does not list.

### The drift check comes first

A clean git tree does not prove the plan still fits: a user may have
committed an edit after the plan was written. So before each write or delete
of a plan path, in the batch and in Step 3 alike, confirm the target still
matches the plan:

- For an `add`, the path must be absent and not a symlink,
  `[ ! -e <path> ] && [ ! -L <path> ]`.
- Before any write, every existing ancestor directory must be a real
  directory, `[ -d <dir> ] && [ ! -L <dir> ]`.
- Otherwise, before `shasum`, the target must be a regular file and not a
  symlink, `[ -f <path> ] && [ ! -L <path> ]`; then run
  `shasum -a 256 <path>` and compare the hash with the entry's
  `currentSha256`.

Anything else stops the run, and so does any mismatch: tell the user the
plan is out of date and to re-plan with the Step 0 command.

Take the staged copy only through the plan's `staged` entry for the path,
with its `sha256` verified, as `SKILL.md` describes.

### One question per conflict

Go through the conflicts in plan order. For each one, show the staged copy
against the current file, and say what that diff is: it shows both sides'
changes mixed together, yours and upstream's, and only the rebuilt base
separates them (see `delegate` below). Then ask with AskUserQuestion,
offering three answers:

- `keep` — leave the project's file exactly as it is (for a JSON file its
  batch keys are still applied; see below). Your version stays; the upstream
  change is not taken.
- `take` — replace the file with its verified staged copy (located through
  the plan's `staged` entry). Your changes to it are lost,
  so say which of them the staged copy drops before the user picks this.
- `delegate` — this skill proposes a merged file that keeps your changes and
  takes upstream's, shows it, and asks for confirmation before writing it.

### JSON files with `jsonKeys`

A JSON file is a file with an entry in `jsonKeys` (in practice
`package.json`, `tsconfig*.json` or `.claude/settings.json`). For a
conflicting one, never replace the whole file. Its key entries split in two:

- Keys classed `safe-update`, `add` or `remove`, which the batch left alone.
  Show those keys in the file's question and apply them unless the user
  declines them there. If the user declined the Step 2 batch, ask whether to
  include them. A `remove`-class key gets the same reference warning as a
  file removal.
- Keys classed `conflict-3way` or `conflict-2way`: `take` and `delegate` act
  only on these listed keys, and `keep` leaves them. `take` sets each one to
  the staged copy's value, and `delegate` proposes a value per key.

After the drift check, the skill applies both kinds together with the chosen
resolution in one write, editing only those keys and keeping the file's
formatting, and records one `decisions.json` entry for the file, not one per
key.

When such a file has no key conflicts, show its batch keys and confirm, apply
them in one write, record `keep` for it and tell the user the remaining
difference is outside the keys the baseline manages. If the user declines
them, record `keep` with nothing written; when there are no batch-class keys
either, skip the confirmation entirely and record `keep`.

To read a pointer, split it on `/` and decode each segment with `~1` to `/`
and `~0` to `~`, decoding `~1` first. An entry's value is the whole value at
that pointer in the staged copy, an `add` whose parent object is missing
creates it (if a parent that an `add` needs exists but is not an object, stop
and ask; never overwrite it), a `remove` key is deleted, and an `/x` entry is a pointer to a
top-level key whose value is `{}`, so it is an empty object.

### `delegate` on a JSON file

For a JSON file with `jsonKeys`, the merge is per conflict key: compare the
value at each conflict pointer in base, yours and new, and touch nothing
else; never write a whole-file text merge. A `conflict-2way` key, or any key
when the base cannot be rebuilt, compares yours and new only.

### `delegate` on `conflict-3way`: a real three-way merge

A three-way merge needs the base: the file as the old release emitted it.
The manifest stores only hashes, so rebuild the old release once per run,
the first time a `conflict-3way` is delegated. Create a fresh temporary
directory with `mktemp -d` outside the project, and rebuild into a path
inside it that does not exist yet, such as `<that dir>/base`:

```bash
npx --yes @monte3l/groundwork@<fromCliVersion> --fresh --skip-install --name <PROJECT_NAME> [--pack <name> ...] <path>
```

`<fromCliVersion>` comes from the plan. `<PROJECT_NAME>` is the manifest's
`tokens.PROJECT_NAME`, and one `--pack <name>` is added for each name in the
manifest's `packs`. Fresh mode runs `git init` in the new directory; if git
init fails after the files were written, the base is still usable as long as
the files exist. Reuse that directory for every later `conflict-3way` in the
run, and delete the temporary directory when Step 3 ends.

The rebuild renders the current year where the template has a year token. If
the manifest's `tokens.YEAR` differs, put it back only in the copyright and
year lines where the template's year was rendered, and never substitute any
other number.

Then merge three ways: the base, yours (the current file) and new (the
staged copy). A change only one side made is taken as is; a line both sides
changed differently is a real clash, so show both and propose one resolution
for it, saying which side it favours. The base does not replay any
`/customize` tailoring, so a difference that only tailoring explains belongs
to your side.

**When the base cannot be rebuilt**, because the session is offline, the old
version is unpublished, or the command fails without writing the files, fall
back to a two-way comparison of yours against new and tell the user plainly
that the base was unavailable and the merge is two-way. Do not retry the
rebuild for later conflicts in the same run.

### `delegate` on `conflict-2way`: always two-way

A `conflict-2way` path has no rebuildable base (the file was hand-merged
before, or upstream added a file the project already had), so its merge is
always two-way: compare yours against new, keep every line of yours that the
new release does not replace, and flag each place where the two disagree.

### Write only after confirmation

Show the full merged result, or a diff of it against the current file, and
confirm before writing it. If the user rejects the proposal, ask again with
`keep` or `take`, and record the final answer once it is carried out. Never
write a path outside the plan's `files` list, and never write the manifest or
record a hash: Step 4's stamp records what you wrote.

When every conflict is recorded, return to `SKILL.md` Step 3 for the
accepted removes and the report-only list.
