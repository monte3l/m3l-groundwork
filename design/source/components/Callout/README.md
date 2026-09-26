# Callout

A boxed note inside docs prose that flags something the reader must not miss: a note, a success, a warning or a danger.

## Use it for

- One point per callout, a sentence or two. Longer content belongs in the page.
- `info` (title "Note") for context, `success` ("Done") for a confirmed outcome, `warning` for something that can go wrong, `danger` for data loss or anything irreversible.
- Leave off `data-status` for a neutral aside. A neutral callout has no status, so it takes no icon.

## Markup (the consumer provides)

```html
<aside
  class="m3l-callout"
  data-status="warning"
  role="note"
  aria-label="Warning"
>
  <svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true">…</svg>
  <div class="m3l-callout__content">
    <p class="m3l-callout__title label">Warning</p>
    <p class="m3l-callout__body body">Node 20 or later is required.</p>
  </div>
</aside>
```

- **Status is never colour alone.** A status callout always has a text title that names the status, plus the status glyph. Each status has a different glyph shape (circle-i, circle-check, triangle, octagon), so the shape tells them apart even without colour.
- Status glyphs (paste inline; `currentColor` strokes):
- info: `<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.5v.01"/></svg>`
- success: `<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.5 9 13l4.5-5.5"/></svg>`
- warning: `<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2Z"/><path d="M10 8v3.5M10 14.5v.01"/></svg>`
- danger: `<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2h6l5 5v6l-5 5H7l-5-5V7Z"/><path d="m7.5 7.5 5 5m0-5-5 5"/></svg>`
- Type comes from the type-style classes: `label` for the title, `body` for the text. Word spacing comes from `text-word-spacing`.

## Tokens

- Status fill `color-status-<s>-surface`, border `color-status-<s>-border`, icon `color-status-<s>-border`, title `color-status-<s>-text`, body `color-text-primary`.
- Neutral: `color-surface-subtle` fill, `color-border-default` border.
- Inline code inside the body uses `color-surface-hover` (see Code block).
- Shape `radius-lg`, padding `space-4`, gap `space-3`, width capped at `measure-prose-max`.
- Component-tier aliases: `callout-<s>-bg`, `-border`, `-fg`, `-icon` (the same values).

## Don't

- No coloured left-border-only variant. The border goes all the way round.
- Don't stack more than two callouts in a row. Don't use `danger` for emphasis.

## Contrast (WCAG 2.2 AA)

| Pair                                     | Tokens                                                          | Light |  Dark | Floor |
| ---------------------------------------- | --------------------------------------------------------------- | ----: | ----: | ----: |
| info title                               | `color-status-info-text` on `color-status-info-surface`         |  6.18 |  9.10 |   4.5 |
| info body                                | `color-text-primary` on `color-status-info-surface`             | 16.26 | 15.65 |   4.5 |
| info icon                                | `color-status-info-border` on `color-status-info-surface`       |  4.80 |  6.87 |     3 |
| info border vs page                      | `color-status-info-border` on `color-surface-default`           |  5.18 |  7.79 |     3 |
| info inline code (surface-hover fill)    | `color-text-primary` on `color-surface-hover`                   | 15.66 | 13.16 |   4.5 |
| success title                            | `color-status-success-text` on `color-status-success-surface`   |  5.92 |  9.34 |   4.5 |
| success body                             | `color-text-primary` on `color-status-success-surface`          | 16.38 | 15.49 |   4.5 |
| success icon                             | `color-status-success-border` on `color-status-success-surface` |  3.38 |  9.43 |     3 |
| success border vs page                   | `color-status-success-border` on `color-surface-default`        |  3.62 | 10.81 |     3 |
| success inline code (surface-hover fill) | `color-text-primary` on `color-surface-hover`                   | 15.66 | 13.16 |   4.5 |
| warning title                            | `color-status-warning-text` on `color-status-warning-surface`   |  6.32 |  8.93 |   4.5 |
| warning body                             | `color-text-primary` on `color-status-warning-surface`          | 16.17 | 15.75 |   4.5 |
| warning icon                             | `color-status-warning-border` on `color-status-warning-surface` |  3.37 | 10.94 |     3 |
| warning border vs page                   | `color-status-warning-border` on `color-surface-default`        |  3.66 | 12.34 |     3 |
| warning inline code (surface-hover fill) | `color-text-primary` on `color-surface-hover`                   | 15.66 | 13.16 |   4.5 |
| danger title                             | `color-status-danger-text` on `color-status-danger-surface`     |  6.52 |  8.79 |   4.5 |
| danger body                              | `color-text-primary` on `color-status-danger-surface`           | 16.07 | 15.86 |   4.5 |
| danger icon                              | `color-status-danger-border` on `color-status-danger-surface`   |  6.58 |  3.98 |     3 |
| danger border vs page                    | `color-status-danger-border` on `color-surface-default`         |  7.19 |  4.46 |     3 |
| danger inline code (surface-hover fill)  | `color-text-primary` on `color-surface-hover`                   | 15.66 | 13.16 |   4.5 |
| neutral title/body                       | `color-text-primary` on `color-surface-subtle`                  | 16.62 | 16.62 |   4.5 |
