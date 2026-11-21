---
name: upgrade
description: >-
  Applies the upgrade plan that `npx @monte3l/groundwork@latest --upgrade .`
  staged under `.groundwork/upgrade/` to a project bootstrapped by
  m3l-groundwork: checks the plan is current, summarises it with the release
  notes, applies the untouched files in one confirmed batch, walks through
  each conflict with keep, take or a proposed merge, then has the CLI stamp
  the manifest and runs the project's checks. Never commits. Use for
  /upgrade, "take the new release", "upgrade m3l-groundwork", "apply the
  upgrade plan", or right after `groundwork --upgrade`.
---

# upgrade

`groundwork --upgrade` compared three things for every file the baseline
manages: the hash the manifest recorded, the file as it is now, and the file
the new release renders. It wrote the result to `.groundwork/upgrade/` and
changed nothing else. This skill applies that plan, one confirmed step at a
time, and then has the CLI record the new release with `--upgrade --stamp`.
The CLI does the bookkeeping; the skill moves staged bytes into place and
asks you about the rest.

| Class           | Meaning                                                | Action                    |
| --------------- | ------------------------------------------------------ | ------------------------- |
| `safe-update`   | Upstream changed it, you did not                       | Step 2 batch              |
| `add`           | New in this release, not in the project                | Step 2 batch              |
| `remove`        | Gone upstream, untouched by you                        | Step 2 batch (delete)     |
| `conflict-3way` | Both upstream and you changed it                       | Step 3, per file          |
| `conflict-2way` | Changed, but no rebuildable base (merged or untracked) | Step 3, per file          |
| `current`       | Already matches the new release                        | Report only               |
| `local-only`    | Only you changed it; upstream did not                  | Report only               |
| `user-deleted`  | You deleted it; upstream still ships it                | Report only               |
| `orphan-edited` | Gone upstream, but you changed or merged it            | Report only, never delete |
| `gone`          | Gone upstream and from the project                     | Report only               |

Two progress files live beside the plan, each written whole every time:

- `.groundwork/upgrade/applied.json` is a JSON array of paths the batch has
  copied or deleted.
- `.groundwork/upgrade/decisions.json` holds only conflict resolutions, as
  `[{"path": "<path>", "resolution": "keep|take|delegate"}]`, and never lists
  a safe-update, add or remove path (Step 3 owns it).

If either file does not parse or does not match its shape, stop and ask the
user, and never rewrite, repair or discard it. The shape is wrong when it
lists a path twice, lists a path that is not in the plan's `files`, lists a
path whose class does not match (`safe-update`, `add` or `remove` in
`applied.json`; `conflict-3way` or `conflict-2way` in `decisions.json`), or
holds a resolution outside `keep|take|delegate`.

## Step 0 — Preconditions

Refuse, stop and write nothing when any of these holds:

- The project is not a git repository (`git rev-parse --is-inside-work-tree`
  fails): this skill relies on git to show and undo its changes.
- `.groundwork/manifest.json`, `.groundwork/upgrade/plan.json` or
  `.groundwork/upgrade/upgrade-report.md` is missing, or the manifest or the
  plan cannot be parsed as JSON.
- The plan's `schemaVersion` is not `1`.
- The plan has `legacy` set to `true`: a legacy plan (a project with no
  manifest) is not supported yet.
- A `staged` value in the plan's `staged` list does not resolve inside
  `.groundwork/upgrade/staged/` (it is relative to `.groundwork/upgrade/`,
  must start with `staged/` and has no `..` segment), so every staged value
  must point inside `.groundwork/upgrade/staged/` before you copy from it.
- The plan is stale: its `fromCliVersion` is not the manifest's
  `cliVersion`, so the manifest moved on after the plan was written.

One exception to the stale check: take this shortcut only when
`fromCliVersion` differs from `toCliVersion` and the manifest's `cliVersion`
already equals `toCliVersion`, which means the plan is already stamped, so
say so and go straight to Step 4's checks. A plan whose `fromCliVersion` and
`toCliVersion` are equal is applied normally, since it can still hold
conflicts.

Every refusal tells the user what was wrong and to re-plan with:

```bash
npx @monte3l/groundwork@latest --upgrade .
```

Then check the working tree. Run `git status --porcelain --` with every path
in the plan's `files` list. If any of them has uncommitted changes, the
working tree is not clean: ask the user to commit or stash those changes,
then stop. An untracked conflict file (`??`) is refused the same way, because
git cannot restore it. Also run `git check-ignore` on the plan's paths: a
gitignored managed path never shows in `git status` and git cannot undo a
change to it, so ask first before touching one. A clean tree lets the user
review this run as one diff and undo it with git.

**Resuming.** If `applied.json` or `decisions.json` already exists, an
earlier session started applying this plan. The clean-tree check still runs
over every plan path that neither file lists, and only listed paths may be
dirty. Then confirm that each recorded entry is on disk: an applied
`safe-update` or `add` and a non-JSON `take` hold the staged bytes (check
with `cmp -s <staged copy> <path>`), an applied `remove` is absent, and a
`delegate`, a JSON `take`, or a JSON resolution that applied batch keys no
longer has its `currentSha256`. When one is not, ask the user with
AskUserQuestion before doing anything else, and do not stop: a `delegate`
whose merge came out equal to the current file trips this check too, so the
answer can be to go on. Continue from the first
path neither file lists and never ask again about a listed one, though a
batch path the user declined is offered again, since it was never recorded.

## The drift check

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

**Taking a staged copy.** Take the plan's `staged` entry whose `path`
matches, join its `staged` value to `.groundwork/upgrade/` (for example
`.groundwork/upgrade/staged/<path>.staged`), and stop if there is no entry.
Verify its `sha256` with `shasum -a 256` on the staged file before copying.

The only hashing the skill does is the read-only `shasum -a 256` of the
drift check, the staged sha256 check and the resume check of a `delegate` or
a JSON resolution.

## Step 1 — Summary

Show the plan as a count per class, using the table above, and name the
two versions: `fromCliVersion` to `toCliVersion`.

Then fetch the release notes between the two versions from GitHub Releases
of `monte3l/m3l-groundwork`, when `gh` is installed and signed in:

```bash
gh release list --repo monte3l/m3l-groundwork --limit 50
gh release view "@monte3l/groundwork@<version>" --repo monte3l/m3l-groundwork
```

Quote the notes of every release after `fromCliVersion` up to and including
`toCliVersion`. If `gh` is not available, the session is offline, or a
release cannot be found, say so plainly and point at the project's GitHub
Releases page. Never invent, summarise from memory or fabricate CHANGELOG
content: quote what you fetched, or say there is nothing to quote.

## Step 2 — The batch

Ask one batch decision with AskUserQuestion, listing every `safe-update`,
`add` and `remove` path. Offer: apply all of them, choose per file, or skip
the batch. In the batch, run the drift check before each copy. For each
accepted `safe-update` or `add`, copy its staged copy to `<path>`, creating
parent directories for an `add`. The batch's `remove` deletions run after
Step 3, not now.

Record a path in `applied.json` only after its write or delete has finished.
A declined path is not recorded anywhere and stays as it is.

**JSON files are handled key by key.** A JSON file here is a file with an
entry in `jsonKeys` (in practice `package.json`, `tsconfig*.json` or
`.claude/settings.json`), one entry per JSON Pointer. A file's own class
wins: when the file itself is `safe-update` or `add`, the batch copies the
whole staged file. The batch does not apply the keys of a conflicting JSON
file, and records nothing for it: Step 3 applies those keys with the file's
resolution.

Never edit or delete a path that is not in plan.json's files list.

## Step 3 — Conflicts

> [!IMPORTANT]
> Read [`step-3-conflicts.md`](step-3-conflicts.md) in full before acting on
> this step, and again after any compaction or resume. It holds the conflict
> procedure, and a compacted session keeps only the start of this file.

In outline: one question per `conflict-3way` or `conflict-2way` path, with
`keep`, `take` or `delegate` (a proposed merge, shown before writing), each
answer recorded in `decisions.json` once it is carried out.

Then carry out the accepted `remove` deletions. Before each one, run the
drift check, search `.claude/settings.json` and `package.json` for the path,
and warn the user if it is still referenced there; delete it only once they
confirm, then record it in `applied.json`.

Then list the report-only classes, each path with one line on why it needs
no action: `current`, `local-only`, `user-deleted`, `orphan-edited` and
`gone`. Never delete an `orphan-edited` file: you changed or merged it, so
it is yours now even though upstream dropped it. A `user-deleted` file stays
deleted.

## Step 4 — Stamp and verify

Record the result in the manifest with the plan's own release. The CLI
re-hashes the plan's paths and writes the new manifest, and nothing else:

```bash
npx --yes @monte3l/groundwork@<toCliVersion> --upgrade --stamp .
```

If `npx` cannot fetch that release (offline, unpublished, or a local build
of the CLI), stop and tell the user the files are applied but NOT stamped;
never swap in another version, because a different release stamps
differently. If the stamp refuses, the applied files stay as they are: show
its message and stop, and do not fix the manifest by hand. Re-running
`--upgrade` then shows a file as `current` only when its bytes now equal the
new release's, and kept or merged files show as conflicts again. Otherwise:

1. If `package.json` changed in this run, run `pnpm install`.
2. Run `pnpm verify` if the project defines it.
3. Run the project's harness and toolchain checks if present:
   `pnpm check:harness` and `pnpm check:toolchain`, or
   `node bin/check-harness.mjs` and `node bin/check-toolchain.mjs`.

Report each result. A failure is the user's to decide on: show it and stop,
never revert files on your own.

Finish with a summary of what was applied, kept, merged and deleted, and
suggest a commit message, for example
`chore: upgrade m3l-groundwork baseline to <toCliVersion>`. Never commit,
push or open a pull request; the user reviews the diff and does that.

## Hard rules

- **Network only through `npx` and `gh`** (plus the `pnpm install` of Step
  4). No other fetch, no web search.
- **No git writes.** Read-only git commands only: no commit, add, stash,
  checkout, restore, reset or push.
- **Never edit or delete a path outside the plan.** The skill only writes
  `safe-update`, `add`, `remove`, `conflict-3way` and `conflict-2way` paths,
  never a `current`, `local-only`, `user-deleted`, `orphan-edited` or `gone`
  one, plus the temporary directory of a Step 3 rebuild,
  `.groundwork/upgrade/decisions.json` and `.groundwork/upgrade/applied.json`. Step 4's `pnpm install` and
  `pnpm verify` may also write the lockfile, `node_modules` and build
  output.
- **The CLI owns the manifest and its hashes.** Never record a hash and never
  write manifest.json, because the CLI records hashes when it stamps; the
  read-only `shasum -a 256` checks are allowed.
- **Stop and ask on anything unexpected:** a drift mismatch, a staged copy
  that is missing, a path that is now a symlink or a directory, a class this
  file does not list, or a command that fails. Never guess past a surprise.
