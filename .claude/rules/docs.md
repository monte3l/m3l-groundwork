---
paths:
  - "*.md"
  - ".changeset/**/*.md"
  - ".claude/**/*.md"
  - ".github/**/*.md"
  - "design/README.md"
  - "docs/**/*.md"
  - "evals/**/*.md"
  - "packages/**/*.md"
---

# Markdown content rules (this repo's own docs, not `templates/**`)

> This file is the terse checklist that auto-loads when you edit this
> repo's own markdown. `templates/**` is deliberately out of scope -- it
> ships into every bootstrapped project and must stay brand-neutral. See
> [`design/source/brand-book.md`](../../design/source/brand-book.md) for
> the full m3l-design voice, and the [Callout component's
> README](../../design/source/components/Callout/README.md) for the
> alert rules below.

- **Bold, not italics or underlines, for emphasis.** The brand book calls
  this out explicitly: italics/underlines "make text appear to run
  together." Use `**bold**`. `bin/build-docs.mjs --check` (the `docs`
  verify step) already fails the build on a stray `_x_`/`*x*` emphasis
  span in one of the ten rendered site pages -- this rule extends the
  same convention to the rest of the repo's markdown, where it's a
  checklist rather than an automated gate.
- **A GitHub alert (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`) for
  anything the reader must not miss**, never a bare bold lead-in or a
  plain blockquote for the same job. `bin/lib/markdown.mjs` renders
  `NOTE`/`TIP`/`IMPORTANT` as an info callout, `WARNING` as a warning
  callout, and `CAUTION` as a danger callout, each with its own glyph so
  the status survives even without colour. Match the severity to the
  content, per the Callout component's own definitions: `[!CAUTION]`
  ("`danger` -- data loss or anything irreversible"); `[!WARNING]`
  ("something that can go wrong"); `[!NOTE]`/`[!TIP]`/`[!IMPORTANT]` for
  context worth flagging but not risky. **Never stack more than two in a
  row**, and **never use `[!CAUTION]` for plain emphasis** -- both are
  the Callout README's own documented rule ("Don't stack more than two
  callouts in a row. Don't use `danger` for emphasis."), extended here to
  every alert level, not just `[!CAUTION]`.
- **Plain, direct copy.** The brand book's personality section names this
  as one of the four structural choices behind the system's voice --
  match it rather than defaulting to hedged or formal phrasing.
- **Tabular data belongs in a table**, not a prose list pretending to be
  one -- the renderer supports pipe tables for exactly this.
