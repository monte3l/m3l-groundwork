---
paths:
  - "templates/packs/statusline/**"
---

# Pack rules: `statusline` (`templates/packs/statusline/**`)

> This file is the terse checklist that auto-loads when you edit the
> `statusline` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `statusLine` renderer (two scripts under `.claude/hooks/`
and one top-level settings key) and the `subagent-rows` mod, a project-local
plugin at `.claude/skills/subagent-rows/` that replaces the deprecated
`subagentStatusLine` key. Modes: fresh and adopt. Budget: 2 hooks (every
`.mjs` directly under `.claude/hooks/` counts, including the import-only
`statusline-layout.mjs`) and 1 skill (the plugin directory occupies a
`.claude/skills/` entry). It was split out of `harness-extras` so a project
with its own status line can take that pack's hooks without a collision, and
`statusline` was a retired pack name until then.

- **It is the only pack that plants a top-level settings key** (`statusLine`)
  through `wiring.settingsTopLevel`. Identical is a no-op, different is a hard
  collision, and an adopted project's own value is never overwritten. Never
  plant `subagentStatusLine` again: Claude Code deprecated it (2.1.330 warns at
  startup; the changelog lists it as removed in 2.1.323).
- **The mod may import only files inside its own plugin directory** (plus
  `node:*` and the bare `claude-code` import). That is why
  `hooks/row-format.mjs` is a vendored copy of the helpers in
  `statusline-layout.mjs`; `statusline-pack.test.ts` keeps the two behaving
  identically. It needs Claude Code 2.1.326+ (the `AgentRow` render site),
  loads as `subagent-rows@skills-dir` only in a trusted folder, and its hook
  stays advisory: any error passes the event on with `next(e)`.
- **A plugin directory under `.claude/skills/` is not a skill.** Both graders
  skip a `.claude/skills/<x>/` that holds `.claude-plugin/plugin.json`
  (`rules.ts` and `harness-rules.mjs`, proved by `harness-parity.test.ts`).
  `caps.ts` still counts it as one skill.
- **The status-line script reads only the stdin payload, `.git/HEAD` through
  `node:fs` and memory figures.** Never spawn a git subprocess from one: they run on
  every prompt.
- **Newer payload fields render only when present.** An older Claude Code
  must degrade to fewer segments, never break. A row that overflows
  `COLUMNS` drops its lowest-priority segments rather than wrapping
  (`fitRow` in `statusline-layout.mjs`).
- **Colors are a role palette, and the m3l-design one is opt-in.**
  `statusline-layout.mjs` exports `PALETTES` and `resolvePalette(env)`;
  `row-format.mjs` carries a vendored copy. The default is the terminal's ANSI-16,
  byte-identical to before. `GROUNDWORK_STATUSLINE_THEME=m3l-design` switches to
  truecolor (light or dark from `COLORFGBG`), and `NO_COLOR` empties every role
  under either theme. The m3l hex values are inlined, since the pack imports
  nothing from the baseline, and `statusline-theme.test.ts` pins them to
  `bin/lib/term.mjs`'s palette. **Never plant the key**: the pack has no
  `env` wiring and the CLI never sets it. `/customize` asks once, defaults to no,
  and adds `env.GROUNDWORK_STATUSLINE_THEME` to `.claude/settings.json` only on a
  yes. The mod cannot read `process.env`: its hook module has no Node APIs
  (code.claude.com/docs/en/plugins/mods/api). `register()` instead calls the
  documented `$.settings.read({ key: "env" })` once, lazily, on the first row
  and never awaits it, so the first row uses the default palette and later rows
  use the theme. `themeEnvFrom` copies only the three theme keys out of the
  result, and any failure leaves the default palette (advisory, `next` runs
  once). The mod cannot see `COLORFGBG` or `NO_COLOR` from the shell, so it
  assumes a dark terminal unless `COLORFGBG` is in that same settings `env`
  block. That read is written to the documented API and tested through fakes;
  it has not been observed in a live session. `NO_COLOR` follows no-color.org
  (set and non-empty).
- **This repo's own copies of the four renderer files equal the pack's**, plus an
  SPDX header, so the root status line is the pack with the theme turned on
  (`.claude/settings.json` `env`). A test enforces it. The "Status line" docs
  page (`bin/docs-statusline-preview.mjs`) renders the pack's script, so a
  change to the palette roles shows up there too.
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

A change to this pack alone is released by its Conventional Commit type
(`fix(packs): ...` for a fix or a change to existing behaviour,
`feat(packs): ...` for new public surface),
because packs ship inside the CLI tarball and have no release of their own.
There is no changeset.
