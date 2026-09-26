# Badge

A short, one- or two-word label next to a version, page title or API name: a version number, "New", or a status such as Beta, Stable, Deprecated or Removed.

## Use it for

- `data-tone` absent: neutral facts (a version, a count). `accent`: "New". `info` / `success` / `warning` / `danger`: lifecycle status.
- Badges are not buttons and not links. Use a Button for anything clickable.

## Markup (the consumer provides)

```html
<span class="m3l-badge label">v2.4.0</span>
<span class="m3l-badge label" data-tone="warning"
  ><svg class="m3l-icon" …>…</svg>Deprecated</span
>
```

- **Status is never colour alone.** A status badge always pairs its word with the status glyph (the same glyphs as Callout, drawn at 1em), and it has a 3:1 border.
- Type: the `label` style (14px, the floor, weight 600, 0.08em tracking). Tabular figures keep version numbers aligned.

## Tokens

- Neutral: `color-surface-hover` fill (interim, see Flags) with `color-text-secondary` text.
- Accent: `color-accent-tint` fill, `color-accent-text` text, `color-accent-tint-border` border.
- Status: `color-status-<s>-surface` fill, `color-status-<s>-text` text, `color-status-<s>-border` border and icon.
- Shape `radius-sm`, padding `0 space-2`, gap `space-1`.
- Component-tier alias: `badge-neutral-bg` / `-fg`. `badge-neutral-bg` still points at `color-surface-sunken`, which vanishes in dark (see Flags).

## Flags

- `color-surface-sunken` equals `color-surface-default` in dark (both `neutral-1000`). A sunken fill therefore disappears on the page. Neutral badges and inline code use `color-surface-hover` until a token decision is made.

## Contrast (WCAG 2.2 AA)

| Pair                   | Tokens                                                          | Light |  Dark | Floor |
| ---------------------- | --------------------------------------------------------------- | ----: | ----: | ----: |
| neutral                | `color-text-secondary` on `color-surface-hover`                 |  7.15 |  8.39 |   4.5 |
| accent                 | `color-accent-text` on `color-accent-tint`                      |  9.53 |  5.87 |   4.5 |
| info label             | `color-status-info-text` on `color-status-info-surface`         |  6.18 |  9.10 |   4.5 |
| info icon              | `color-status-info-border` on `color-status-info-surface`       |  4.80 |  6.87 |     3 |
| info border vs page    | `color-status-info-border` on `color-surface-default`           |  5.18 |  7.79 |     3 |
| info border vs card    | `color-status-info-border` on `color-surface-raised`            |  5.18 |  6.61 |     3 |
| success label          | `color-status-success-text` on `color-status-success-surface`   |  5.92 |  9.34 |   4.5 |
| success icon           | `color-status-success-border` on `color-status-success-surface` |  3.38 |  9.43 |     3 |
| success border vs page | `color-status-success-border` on `color-surface-default`        |  3.62 | 10.81 |     3 |
| success border vs card | `color-status-success-border` on `color-surface-raised`         |  3.62 |  9.16 |     3 |
| warning label          | `color-status-warning-text` on `color-status-warning-surface`   |  6.32 |  8.93 |   4.5 |
| warning icon           | `color-status-warning-border` on `color-status-warning-surface` |  3.37 | 10.94 |     3 |
| warning border vs page | `color-status-warning-border` on `color-surface-default`        |  3.66 | 12.34 |     3 |
| warning border vs card | `color-status-warning-border` on `color-surface-raised`         |  3.66 | 10.46 |     3 |
| danger label           | `color-status-danger-text` on `color-status-danger-surface`     |  6.52 |  8.79 |   4.5 |
| danger icon            | `color-status-danger-border` on `color-status-danger-surface`   |  6.58 |  3.98 |     3 |
| danger border vs page  | `color-status-danger-border` on `color-surface-default`         |  7.19 |  4.46 |     3 |
| danger border vs card  | `color-status-danger-border` on `color-surface-raised`          |  7.19 |  3.78 |     3 |
