## What this is

**m3l-design** is the shared design system for everything Enrico Lionello
(`enri3l`) builds personally and everything published under the `monte3l`
GitHub org — apps, internal tools, documentation sites, landing pages, and
marketing surfaces alike. **`m3l-groundwork` is the first project this
system will actually be applied to.**

This document started as the brief for the system. The "— Decided" sections
are that original brief. The "— Built" sections and "Components" record what
v1 shipped.

**Status (2026-09-26): v1 signed off.** It covers the foundations (tokens), seven
components (Callout, CodeBlock, Badge, Button, Input, Card, Nav) and the
cover. See "v1 — complete" at the end for what is deliberately out of scope.

Reserved namespace/scope for whenever this becomes a real package or repo:
**`@monte3l/m3l-design`**. Distribution model (see "Governance" below) is
copy-based, not a live npm dependency — the scope is a source-of-truth
address, not a runtime install target.

---

## Personality

**Warm and approachable.** This is the one deliberate departure from the
closest technical precedent this brief leans on (Vercel's Geist, all austere
ink-on-white restraint) — m3l-design should feel like a considered, human
project, not a sterile one. Warmth here comes from four structural choices,
not from decoration:

- warm-biased neutrals (never a pure, cool grey)
- consistently rounded shapes (see "Shape language")
- a single deep, characterful accent color instead of a bright/loud one
- plain, direct copy

Structurally the palette is still **near-monochrome + one accent** (see
"Color system") — that's a color-architecture decision, independent of
personality, shared with systems like Geist. Warmth is expressed through
_how_ that structure is tuned, not by abandoning it.

**Explicitly avoided:** the AI-generated-design cluster this document's own
authoring guidance warns about — warm cream + serif + terracotta, a
purple-to-blue gradient hero, Inter/Space Grotesk as the reflexive "safe"
choice, emoji section markers, `rounded-lg` everywhere applied without
intent. m3l-design's warmth comes from a wine-purple accent and a
distinctness-first sans, not from that cluster's usual moves.

---

## Color system — Decided

**Structure:** near-monochrome neutral scale + exactly one accent hue.
Semantic tokens should point at primitives, never at each other, per current
token-layering practice (Design Tokens Community Group / Contentful / Adam
Arant's token-naming writeups, 2025).

**Accent — light mode:**
`#692746` (PANTONE 19-2430 TCX "Purple Potion", RGB 105/39/70). Verified
against white/near-white ground: relative luminance ≈0.049, contrast ratio
≈**10.6:1** — clears WCAG 2.2 AAA (7:1), not just AA (4.5:1), for normal
text.

**Accent — dark mode (direction; the exact hex is under Built):** same hue
family (~332° hue, wine/magenta-red), lightness lifted to roughly **55–65%**
so it holds ≥4.5:1 (AA) against whatever dark surface color is chosen.
Don't just invert or lighten blindly — tune it against the actual dark
neutral once one exists, and re-check contrast, following this brief's
own instruction elsewhere never to invent a value without checking it.

**Neutrals:** warm-biased, not cool-biased — i.e. a slight hue lean toward
the accent's warmth rather than a pure grey scale. The exact stops are
under Built below. The _direction_ is decided: this system should
never ship a neutral that reads as an unconsidered default grey.

**Contrast bar:** WCAG 2.2 AA minimum everywhere (4.5:1 text, 3:1 large
text/UI components), matching the industry's current 2026 standard — WCAG
3.0 is still only a W3C Working Draft (targeting ~2029) and isn't a
practical target yet. Where the accent already clears AAA in light mode
(it does, at 10.6:1), keep that headroom rather than spending it.

## Color system — Built (signed off 2026-09-26)

- **Neutrals:** 15 stops, `color-neutral-0` … `color-neutral-1000`, one
  ramp shared by both themes. Hue is the accent's own OKLCH hue (353.7°) at
  very low chroma (0.003–0.013), so greys lean wine-warm, never cool.
- **Dark-mode accent:** `#d1789e` (`color-wine-400`; HSL 334° / 49% / 65%,
  OKLCH L 0.68). ≥4.66:1 on every dark surface, including hover.
- **Semantic names** follow `color-<role>-<variant>` (`color-surface-default`,
  `color-text-primary`, `color-accent-default/-hover/-active/-tint`, …) and
  alias primitives directly, re-mapped per theme.
- **Status colors — approved 2026-09-26:** info blue, success green,
  warning amber, danger red (OKLCH hue 27°, well clear of the accent's 354°).
  Their indicator/icon tokens are staggered in lightness so success vs danger
  still reads under red-green colour blindness. Status is never colour alone:
  callouts always carry an icon and a text label.
- Every text/surface and UI/surface pairing, per theme, is in
  **Contrast** (`foundations/contrast.md`). All pass WCAG 2.2 AA.
- Light-mode accent on `color-neutral-0` (`#fefcfd`, the warm page white) is
  10.39:1, not the 10.61:1 measured against pure white. Still AAA.

---

## Typography — Decided

**Pairing:** a technical sans for UI/body text + a monospace for code —
the full type scale is under Built below.

**Base sans: Atkinson Hyperlegible Next.** Chosen over the two obvious
alternatives for a specific, evidence-based reason (see "Why not a
'dyslexia font'" below): it optimizes for **character distinctiveness**
(Braille Institute's original design goal), which is exactly the property
that also helps a dyscalculia-affected reader tell digits like 1/l/I, 0/O,
and 6/8 apart. Free, hosted on Google Fonts.

**Base mono: Atkinson Hyperlegible Mono** (confirmed 2026-09-26, replacing
the provisional JetBrains Mono). It is the Braille Institute's mono version
of the base sans, built for the same character distinctness. The same
reasoning that picked the sans applies here, and the letterforms match.
Google Fonts, OFL, variable weight 200–800 plus italic. It ships no code
ligatures, which keeps every glyph distinct. The current build includes the
backtick an early release was missing (checked in the font's character map).
Known trade-off: `[]` and `{}` are less distinct than in JetBrains Mono.
Code blocks should rely on syntax colour and spacing there, not bracket
shape alone.

### Why not a "dyslexia font" — the actual research finding

A 2026 meta-analysis found dyslexia-specialized fonts have **no reliable
effect** on reading speed or accuracy. **OpenDyslexic specifically tested
slightly _worse_** than mainstream fonts in controlled studies — it should
not be used. **Lexend** is the one exception with real measured
reading-speed gains across large studies, and was seriously considered, but
Atkinson Hyperlegible's distinctness-first design was judged the better fit
here because it serves both dyslexia _and_ dyscalculia accessibility goals
at once, where Lexend's evidence is specifically about reading speed.

**The stronger, better-evidenced lever is typographic _treatment_, not
typeface choice** (British Dyslexia Association Style Guide; consistent
across the sources checked). Bake these in as tokens, not as one-off CSS:

- **Line-height ≥ 1.5** for body text; anything below 1.4 is called out as
  likely to cause reading difficulty.
- **Letter/word spacing:** the BDA guide asks for an inter-letter gap of
  ~35% of the _average letter width_ (not of the font size), and a word gap
  of at least 3.5× the letter gap. Measured on the real fonts, this gives
  +0.055em at weight 400, +0.08em at 600, +0.09em at 700, and word-spacing
  +0.015em at 400. Mono 400 already exceeds 35%, so it gets 0; mono 700
  gets +0.035em. Tokens: `text-letter-spacing-*`, `text-word-spacing`.
- **Measure (line length):** 60–70 characters for body text — this is
  also good general typographic practice, not just an accessibility add-on.
  Set it in **em, not ch**: Atkinson Next's `0` is wide (0.648em), so 1ch ≈
  1.3 average characters and `65ch` would give ~84. `measure-prose` = 32.5em
  (~65 characters), with a range of 30–35em.
- **Alignment:** left-aligned, never justified.
- **Emphasis:** bold instead of italics or underlines for emphasis in body
  text — italics/underlines "make text appear to run together."
- **Numerals:** tabular (fixed-width) lining figures as the default figure
  style, especially anywhere numbers appear in a column or are compared
  (tables, data, code) — directly addresses the dyscalculia digit-alignment
  problem name-checked in the original ask.
- **Body size floor:** nothing smaller than ~14–16px / 1–1.2em for running
  text.

## Typography — Built (signed off 2026-09-26)

- Scale (rem): display 3 · h1 2.25 · h2 1.75 · h3 1.375 · h4 1.125 ·
  body-lg 1.125 · body 1 · label 0.875 · caption 0.875 (the floor) ·
  code 0.9375 (mono). Weights: 400 body, 600 labels, 700 headings and
  emphasis.
- **Every** style: line-height 1.5, tracking for its weight, `fontStyle:
normal`, tabular lining figures (`tnum`, which Atkinson Next has but
  doesn't enable by default), no ligatures, left-aligned.
- Headings get more tracking only because they are bolder (the same 35% rule
  measured at 700). No separate heading treatment.

---

## Shape language — Decided

**Soft, consistently rounded.** A radius scale (`radius-xs` … `radius-xl`, `radius-full`)
applied consistently across buttons, cards, inputs, and containers — no
sharp-corner exceptions by default. This is one of the four structural
carriers of "warm & approachable" named above; don't let a later session
quietly reintroduce sharp corners "for a technical feel" without revisiting
this decision explicitly first.

---

## Motion — Decided

**Subtle and functional only.** Motion exists to communicate state changes
and feedback (hover, focus, transitions, loading) — fast, quiet, never
decorative or used for "delight" on its own. This was chosen deliberately
over a "more expressive on marketing pages" alternative, specifically
because it's the cheaper option to keep consistent across app UI, docs, and
marketing at once, and the easiest to make safe under
`prefers-reduced-motion` (which must always be respected — reduce to
near-instant or no motion when it's set, never just "shorter").

---

## Accessibility bar — Decided

**WCAG 2.2 AA**, everywhere, as the non-negotiable floor:

- ≥4.5:1 contrast for normal text, ≥3:1 for large text/UI components
  (borders, focus rings, icons), in **every** theme.
- Visible keyboard focus states on every interactive element.
- `prefers-reduced-motion` respected everywhere motion is used.
- The dyslexia/dyscalculia typographic treatment above, applied as tokens,
  not as an opt-in mode.
- Colors that must be told apart differ in lightness, not hue alone (a
  blue/orange pair reads correctly to more colorblind users than a
  red/green pair carrying the same meaning).

AAA is a bonus where it falls out naturally (as it already does for the
light-mode accent against white, at 10.6:1) but is not the target — pushing
every pairing to AAA would fight against having any real color range at all,
especially for marketing surfaces.

---

## Token architecture — Decided (with a practical caveat)

**Source-of-truth format: DTCG-standard JSON** (the W3C Design Tokens
Community Group format, which reached its first stable release,
version 2025.10, in October 2025 — backed by Adobe, Figma, Google,
Microsoft, Shopify, and Salesforce). This is genuinely tool-agnostic now:
Figma, Penpot, Style Dictionary and Tokens Studio all read/write this shape
without a bespoke export step per tool. It's also pure data with no runtime
dependency, which fits `m3l-groundwork`'s own zero-runtime-dependency ethos
this brief is deliberately borrowing.

**Layering:** three tiers, and don't skip the middle one —

1. **Primitive** — raw values with no context (`purple-70`, `space-4`).
2. **Semantic (alias)** — brand-agnostic, mode-agnostic _meaning_ names that
   point at primitives (`color-surface-primary`, `color-text-on-surface`).
   Semantic tokens must alias primitives directly, never chain through
   another semantic token — chained aliases are called out repeatedly across
   sources as the most expensive mistake to unwind later.
3. **Component** — the most specific layer, mapped to one UI element
   (a button's background, a card's border radius).

**Practical caveat, learned while setting this artifact up:** this Claude
Design artifact type's own `tokens.json` does **not** read the DTCG
name-to-value map shape directly — it reads a flat `{"tokens":[{"name",
"value","usage"}, …]}` list per category instead, and silently drops
anything shaped as a DTCG map. Whoever builds the actual tokens here needs
to keep the DTCG-shaped file as the portable source of truth (for Figma /
Style Dictionary / other consumers) and **transform it into this artifact's
list shape** when writing `project/tokens.json` inside this specific
artifact — they are not interchangeable, and only the DTCG one should be
treated as canonical when the two disagree.

## Token architecture — Built (2026-09-26)

- Canonical DTCG 2025.10 source: `dtcg/m3l.resolver.json`. Sets:
  primitives → semantic → components. Modifiers: `theme` (light/dark) and
  `motion` (default/reduced, where every duration is 0ms).
- `tokens.json` is the flattened copy this artifact reads. Names match the
  DTCG paths joined with `-` (`color.surface.default` →
  `color-surface-default`). The artifact can only alias colours, so
  non-colour component tokens (button radius, card padding, …) and the
  `shape-*` / `inset-*` role tokens live in the DTCG files only.
- Duration, easing, z-index and breakpoints are one tier: named by role, with
  no light/dark meaning to split.
- Categories: colour, type, spacing, radius, shadow/elevation, motion
  (duration, easing), breakpoints, z-index, border widths, and the text
  treatment (measure, word spacing, figures).

---

## Components

- Plain HTML + CSS in `components/bundle.css`: no runtime and no framework,
  so the files can be copied into a project the same way the rest of the
  system is. Every class is prefixed `m3l-`. Each component's README gives
  its markup, the tokens it uses and its contrast table.
- Put the type-style class on the element (`label`, `body`, `caption`,
  `code`, `heading-4` …). That class carries size, weight, line-height and
  tracking, and `bundle.css` adds tabular figures, no ligatures and word
  spacing. Never set a font size or letter spacing by hand.
- `bundle.css` references colour only through semantic `color-*` tokens,
  never a primitive. The component-tier colour tokens (`button-primary-bg`, …)
  are the same values under component names, for consumers who want that
  layer.
- Every interactive element gets the same focus ring: `color-focus-ring`,
  `focus-ring-width`, drawn at `focus-ring-offset` so it sits on the surface.
- Motion is colour and shadow transitions only (`duration-fast`,
  `easing-standard`). Under `prefers-reduced-motion` everything goes to
  `duration-instant` (0ms).
- Status is never colour alone: status components carry a word **and** a
  glyph whose shape differs per status (circle-i, circle-check, triangle,
  octagon).

## Iconography

- v1 has no icon set (out of scope; see "v1 — complete"). The four status
  glyphs in the Callout README are simple 20×20 outline shapes (stroke 2,
  `currentColor`), made only to carry status. If an icon set is adopted,
  replace them and keep one distinct shape per status.
- Icons are decorative (`aria-hidden="true"`) whenever a text label next to
  them says the same thing.

---

## Surfaces this system must cover

App UI, code documentation sites, landing/marketing pages — all from **one**
shared token set, not per-surface forks. Known failure modes to watch for
while building (from current design-systems practice, not this project
specifically):

- Semantic color tokens that look fine in light mode but don't survive a
  dark-mode flip because they were never re-checked per theme.
- Marketing pages wanting more expressive color range than the accent alone
  provides — resist adding a second "marketing accent"; if more range is
  genuinely needed, it should be a deliberate, documented addition to the
  semantic layer, not a one-off hex on a landing page.
- Documentation sites needing strong code-block and long-form-prose
  typography specifically — this is exactly what the typographic treatment
  rules above (measure, line-height, tabular figures) are for; don't treat
  docs as an afterthought to app UI.

---

## Governance — Decided

**Single spec, copied into each consuming project** — the model used by
Vercel's Geist (a single machine-readable `DESIGN.md`) and shadcn/ui ("own
the code": components are pulled in and versioned like any other file you
authored, not installed as a live dependency). This was chosen deliberately
over publishing `@monte3l/m3l-design` as an npm package that projects
import, because:

- it matches `m3l-groundwork`'s own documented philosophy of emitting a
  baseline into each project rather than centrally importing one;
- it avoids real release/versioning overhead for a solo maintainer across
  many repos;
- it lets an individual project deliberately diverge where it needs to,
  without that being a "drift bug."

The reserved scope `@monte3l/m3l-design` is a **source-of-truth address**
(where this artifact / its eventual companion repo lives), not a runtime
install target. A project consuming this system copies the relevant
tokens/components in, the same way `m3l-groundwork` itself emits a baseline
into bootstrapped projects rather than having them depend on it live.

---

## v1 — complete

m3l-design v1 was signed off on 2026-09-26. It covers the foundations
(DTCG source plus `tokens.json`), seven components and the cover. Nothing
in v1 is unfinished. The items below are the only known gaps, and they
fall into two different kinds.

**Deliberate v1 scope boundaries.** Add these when a project needs them;
none is urgent:

- No destructive (danger-filled) Button variant. It would need an
  `on-danger` text token.
- No Input hover border. There is no hover-border token.
- No syntax-highlighting tokens for CodeBlock.
- No chosen icon set. The status glyphs cover status only.

**One open token decision, carried forward:**

- In dark mode, `color-surface-sunken` has the same value as
  `color-surface-default` (both `neutral-1000`). Every current component
  works around this the same way, by borrowing `color-surface-hover`. The
  workaround is documented in the Badge, Button and Input READMEs. The token
  itself still needs a real dark value before any component needs a hover
  state and a sunken state that look different from each other.

---

## Sources consulted for this brief

Design Tokens Community Group / designtokens.org (2025.10 stable spec);
Contentful and Adam Arant's design-token-naming writeups (2025); British
Dyslexia Association Style Guide (2023); a 2026 meta-analysis on
dyslexia-friendly fonts and reading performance; PMC-indexed studies on
OpenDyslexic reading rate/accuracy; Vercel Geist's public design-language
documentation; shadcn/ui vs. Radix positioning (Vercel); WCAG 2.2/3.0 status
writeups current as of September 2026.
