---
paths:
  - "templates/packs/statusline/**"
---

# Pack rules: `statusline` (`templates/packs/statusline/**`)

> This file is the terse checklist that auto-loads when you edit the
> `statusline` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `statusLine` and `subagentStatusLine` renderers: three
scripts under `.claude/hooks/` and two top-level settings keys. Modes: fresh
and adopt. Budget: 3 hooks (every `.mjs` directly under `.claude/hooks/`
counts, including the import-only `statusline-layout.mjs`). It was split out
of `harness-extras` so a project with its own status line can take that
pack's hooks without a collision, and `statusline` was a retired pack name
until then.

- **It is the only pack that plants top-level settings keys** (`statusLine`,
  `subagentStatusLine`) through `wiring.settingsTopLevel`. Identical is a
  no-op, different is a hard collision, and an adopted project's own value
  is never overwritten.
- **The scripts read only the stdin payload, `.git/HEAD` through `node:fs`
  and memory figures.** Never spawn a git subprocess from one: they run on
  every prompt.
- **Newer payload fields render only when present.** An older Claude Code
  must degrade to fewer segments, never break. A row that overflows
  `COLUMNS` drops its lowest-priority segments rather than wrapping
  (`fitRow` in `statusline-layout.mjs`).
- **The pack needs nothing from the baseline.** The scripts import only
  `node:*` and each other, and `statusline-layout.mjs` inlines its palette
  rather than importing `bin/lib/term.mjs`. Keep it that way, or add a
  `requires.paths` entry.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Renderer behaviour    | `packages/cli/tests/templates/statusline-pack.test.ts`               |
| Installs and verifies | `packages/cli/tests/packs-statusline.e2e.test.ts`                    |
| Settings merge        | `merge-json.test.ts`, `merge-json.property.test.ts`, `packs.test.ts` |
| Budget                | `caps.test.ts`                                                       |

A change to this pack alone takes a changeset whose summary starts with
`pack(statusline):`.
