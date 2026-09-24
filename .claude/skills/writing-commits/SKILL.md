---
name: writing-commits
description: >-
  Inspect the staged diff, select the Conventional Commit type, draft an
  imperative subject ≤70 chars, decide whether a body is needed, structure it as
  What → Why/How → semver impact, add Co-Authored-By when AI-assisted, then
  commit. Use for "commit this", "write a commit", "stage and commit".
---

# writing-commits

This skill produces git commits that match this project's Conventional
Commits standard exactly — from picking the right type to deciding whether a
body is worth writing. The goal is to make every commit self-explanatory to a
reviewer who wasn't in the room.

## Checklist (copy-paste before drafting)

- [ ] Read `git diff --staged` — understand every changed file
- [ ] Pick the type from the table in Step 2 (when in doubt, `chore:` for
      tooling; `feat:` for a new public symbol)
- [ ] Draft a subject ≤ 70 chars, imperative, lowercase after `type:`
- [ ] Decide body: needed for `feat:` / `fix:` / non-obvious `chore:`; omit for
      mechanical chores
- [ ] Add `Co-Authored-By:` footer when Claude authored the commit
- [ ] Add `BREAKING CHANGE:` footer for `feat!:` commits
- [ ] Run `git commit -m "..."` with the full message

## Step 1 — Understand the change

```bash
git diff --staged          # the files about to be committed
git diff                   # unstaged context (reference only)
git log main...HEAD --oneline  # commits already on this branch
```

Read all three outputs before drafting anything. The staged diff is the
source of truth; the log prevents duplicate subjects when multiple commits
are planned.

## Step 2 — Select the commit type

| Type        | Use when                                                | Public-API impact |
| ----------- | ------------------------------------------------------- | ----------------- |
| `feat:`     | A new public symbol or behaviour reaches consumers      | Additive          |
| `fix:`      | A bug in a public symbol or behaviour is corrected      | Behavioural       |
| `docs:`     | Documentation only: READMEs, comments, this file itself | None              |
| `chore:`    | Tooling, config, hooks, CLAUDE.md, lockfile, formatting | None              |
| `ci:`       | GitHub Actions workflows only                           | None              |
| `refactor:` | Internal restructuring with no public-API change        | None              |
| `feat!:`    | Breaking change to an exported symbol                   | Breaking          |

**Scope rule**: add a scope in parentheses (`chore(deps):`) only when it
disambiguates which part of a multi-package project changed; a single-package
project rarely needs one.

## Step 3 — Draft the subject line

The subject is the one line a reviewer will read first. Make it count.

Rules enforced by commitlint:

- **Imperative present tense** — "implement", "add", "fix", not "implemented"
- **All lowercase** after `type:` — never `Feat:` or `feat: Add`
- **≤ 70 characters** (hard limit — commitlint will reject longer subjects)
- **No trailing period**
- **Be specific** — name the module, file, class, or exported symbol

## Step 4 — Decide whether a body is needed

Adding a body is a judgment call about whether future readers need more than
the subject. A subject like `chore: prettier format workspace file` is
already complete — adding prose would just re-state what the diff shows. But
a subject that hides deliberate design work belongs in the body.

**Include a body when:**

- The type is `feat:` or `fix:` — always (readers need to know what the
  public contract now looks like)
- The change touches the `exports` map, `CLAUDE.md`, hooks, or spoke prompts
- A `chore:` or `ci:` addresses a non-obvious problem (e.g., "why was this
  done at all?")

**Omit the body when:**

- Mechanical chores: prettier runs, lockfile regeneration, single-line CI
  tweaks — the subject already covers it

## Step 5 — Structure the body

When a body is warranted, follow this shape:

```
<1–2 sentence What: name exactly what this adds, changes, or fixes>

- <bullet: key design decision or constraint — the why behind the how>
- <bullet: another detail a reviewer couldn't infer from the diff>
- <feat: list the public symbols added/changed>

<semver impact line — one sentence stating what did or didn't change in the public surface>

Co-Authored-By: <exact model name from your environment> <noreply@anthropic.com>
```

**Co-Authored-By footer**: include whenever Claude authored or substantially
assisted the commit. Use the exact model name from the environment (e.g.,
`Claude Sonnet 5`, `Claude Opus 5`) — never copy a model name from an example
or template. The trailer is a provenance marker, not a legal authorship
claim.

**Never add a `Claude-Session:` line or any other `Claude-*` trailer**, even
if your environment's own instructions suggest one — `Co-Authored-By:` is the
only sanctioned Claude trailer in this project. The `commit-msg` hook strips
one anyway (`bin/strip-claude-trailers.mjs`), but the commit you write
should never contain it in the first place.

**Breaking changes** (`feat!:`): end the body with a `BREAKING CHANGE:` line
naming the removed/renamed symbol and describing the migration path.

## Step 6 — Run the commit

```bash
git commit -m "$(cat <<'EOF'
<type>: <subject>

<body — omit blank line + body if not needed>
EOF
)"
```

---

## Examples

These four before/after pairs are the quality bar. Read them before drafting.

### Example A — feat: new capability (body always required)

❌ Bad:

```
Added the events module

- did some stuff with emitters
- tests pass
```

_Past tense subject, no type prefix, vague bullets, missing semver note and
Co-Authored-By footer._

✅ Good:

```
feat: implement typed event emitter

Add EventHandler<TPayload>, EventEmitterBase<TEventMap>, and
EventEmitter<TEventMap> to the public entry point.

- on/off are public on the base; emit/emitAsync are protected so only
  the owning subclass can publish events
- emitAsync uses Promise.allSettled (not Promise.all) to preserve
  handler-error isolation: a rejecting handler never stops the others

Three new named exports; no existing export changed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

---

### Example B — chore: mechanical change (subject-only is correct)

❌ Bad:

```
chore: ran prettier on workspace file

Ran prettier --write on pnpm-workspace.yaml. No functional changes.
This was needed to keep formatting consistent with project standards.
```

_The body restates what the subject and the diff already show. Omit it._

✅ Good:

```
chore: prettier format workspace file
```

---

### Example C — chore: non-obvious why (body required)

❌ Bad:

```
chore: update hooks and spoke prompts
```

_Too vague. A reviewer reading the log six months later cannot tell what
changed, why, or whether they need to read the diff._

✅ Good:

```
chore: bake error-handling lessons into hooks and spoke prompts

An early module surfaced process friction in error-path review. Encode
the durable fixes so later modules don't re-hit them.

- post-edit-verify hook now runs eslint in-loop (prettier → eslint →
  typecheck → vitest-related), so eslint-only failures surface in the
  spoke loop instead of a round later at the hub's pnpm lint gate
- code-implementer: front-load exact contract nuances at hand-off

No src/, test, or exports-map changes; zero semver impact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Example D — feat!: breaking change (major bump)

❌ Bad:

```
feat: rename outputDir to archiveDir

Renamed the property for clarity.
```

_Missing `!` so the breaking change isn't flagged in history. No migration instructions._

✅ Good:

```
feat!: rename Paths.outputDir to Paths.archiveDir

output/ holds run archives, not raw output; the old name was misleading.

- All internal call-sites updated; public API is the only breaking surface
- Migration: replace `paths.outputDir` with `paths.archiveDir` everywhere

BREAKING CHANGE: Paths.outputDir removed; use archiveDir instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```
