# Contrast

Every text/surface and UI/surface pairing in `tokens.json`, checked per theme against the WCAG 2.2 AA floor: **4.5:1** for text, **3:1** for UI boundaries, focus rings and icons. The numbers are computed from the published token values by a script, not asserted. There are no failures.

## Method

Relative luminance per WCAG 2.2: each sRGB channel c (0–1) is linearised as `c/12.92` if c ≤ 0.04045, else `((c+0.055)/1.055)^2.4`; then L = 0.2126 R + 0.7152 G + 0.0722 B. Contrast = (L_lighter + 0.05) / (L_darker + 0.05).

Worked examples:

- Light accent text on page: L(#692746) = 0.0490, L(#fefcfd) = 0.9778 → (0.9778 + 0.05) / (0.0490 + 0.05) = **10.39:1**
- Dark accent text on hover surface (the tightest dark accent pair): L(#d1789e) = 0.2946, L(#30292c) = 0.0240 → (0.2946 + 0.05) / (0.0240 + 0.05) = **4.66:1**
- Light tertiary text on hover surface (the tightest light text pair): L(#6f6669) = 0.1390, L(#f4eef0) = 0.8667 → (0.8667 + 0.05) / (0.1390 + 0.05) = **4.85:1**
- Light control border on sunken surface: L(#898084) = 0.2242, L(#f4eef0) = 0.8667 → (0.8667 + 0.05) / (0.2242 + 0.05) = **3.34:1**

`color-text-disabled` is deliberately left out. Inactive controls are exempt under WCAG 1.4.3, and the token is not contrast-safe, so it must never carry readable content.

The focus ring is drawn at a 2px offset (`focus-ring-offset`), so it always sits on the surface. That is why it is checked against surfaces rather than against the control it surrounds.

## Light theme

| Foreground                    | Background                     | Hex                | Ratio | Floor |
| ----------------------------- | ------------------------------ | ------------------ | ----: | ----: |
| `color-text-primary`          | `color-surface-default`        | #1a1617 on #fefcfd | 17.55 |   4.5 |
| `color-text-primary`          | `color-surface-subtle`         | #1a1617 on #faf5f7 | 16.62 |   4.5 |
| `color-text-primary`          | `color-surface-sunken`         | #1a1617 on #f4eef0 | 15.66 |   4.5 |
| `color-text-primary`          | `color-surface-raised`         | #1a1617 on #fefcfd | 17.55 |   4.5 |
| `color-text-primary`          | `color-surface-hover`          | #1a1617 on #f4eef0 | 15.66 |   4.5 |
| `color-text-primary`          | `color-surface-selected`       | #1a1617 on #feeff4 | 16.11 |   4.5 |
| `color-text-primary`          | `color-surface-code`           | #1a1617 on #faf5f7 | 16.62 |   4.5 |
| `color-text-primary`          | `color-accent-tint`            | #1a1617 on #feeff4 | 16.11 |   4.5 |
| `color-text-secondary`        | `color-surface-default`        | #554d50 on #fefcfd |  8.02 |   4.5 |
| `color-text-secondary`        | `color-surface-subtle`         | #554d50 on #faf5f7 |  7.59 |   4.5 |
| `color-text-secondary`        | `color-surface-sunken`         | #554d50 on #f4eef0 |  7.15 |   4.5 |
| `color-text-secondary`        | `color-surface-raised`         | #554d50 on #fefcfd |  8.02 |   4.5 |
| `color-text-secondary`        | `color-surface-hover`          | #554d50 on #f4eef0 |  7.15 |   4.5 |
| `color-text-secondary`        | `color-surface-selected`       | #554d50 on #feeff4 |  7.36 |   4.5 |
| `color-text-secondary`        | `color-surface-code`           | #554d50 on #faf5f7 |  7.59 |   4.5 |
| `color-text-secondary`        | `color-accent-tint`            | #554d50 on #feeff4 |  7.36 |   4.5 |
| `color-text-tertiary`         | `color-surface-default`        | #6f6669 on #fefcfd |  5.44 |   4.5 |
| `color-text-tertiary`         | `color-surface-subtle`         | #6f6669 on #faf5f7 |  5.15 |   4.5 |
| `color-text-tertiary`         | `color-surface-sunken`         | #6f6669 on #f4eef0 |  4.85 |   4.5 |
| `color-text-tertiary`         | `color-surface-raised`         | #6f6669 on #fefcfd |  5.44 |   4.5 |
| `color-text-tertiary`         | `color-surface-hover`          | #6f6669 on #f4eef0 |  4.85 |   4.5 |
| `color-text-tertiary`         | `color-surface-selected`       | #6f6669 on #feeff4 |  4.99 |   4.5 |
| `color-text-tertiary`         | `color-surface-code`           | #6f6669 on #faf5f7 |  5.15 |   4.5 |
| `color-text-tertiary`         | `color-accent-tint`            | #6f6669 on #feeff4 |  4.99 |   4.5 |
| `color-accent-text`           | `color-surface-default`        | #692746 on #fefcfd | 10.39 |   4.5 |
| `color-accent-text`           | `color-surface-subtle`         | #692746 on #faf5f7 |  9.84 |   4.5 |
| `color-accent-text`           | `color-surface-sunken`         | #692746 on #f4eef0 |  9.26 |   4.5 |
| `color-accent-text`           | `color-surface-raised`         | #692746 on #fefcfd | 10.39 |   4.5 |
| `color-accent-text`           | `color-surface-hover`          | #692746 on #f4eef0 |  9.26 |   4.5 |
| `color-accent-text`           | `color-surface-selected`       | #692746 on #feeff4 |  9.53 |   4.5 |
| `color-accent-text`           | `color-surface-code`           | #692746 on #faf5f7 |  9.84 |   4.5 |
| `color-accent-text`           | `color-accent-tint`            | #692746 on #feeff4 |  9.53 |   4.5 |
| `color-text-on-accent`        | `color-accent-default`         | #fefcfd on #692746 | 10.39 |   4.5 |
| `color-text-on-accent`        | `color-accent-hover`           | #fefcfd on #4f1a33 | 13.45 |   4.5 |
| `color-text-on-accent`        | `color-accent-active`          | #fefcfd on #381224 | 16.06 |   4.5 |
| `color-status-info-text`      | `color-surface-default`        | #065da0 on #fefcfd |  6.67 |   4.5 |
| `color-status-info-text`      | `color-surface-subtle`         | #065da0 on #faf5f7 |  6.32 |   4.5 |
| `color-status-info-text`      | `color-surface-sunken`         | #065da0 on #f4eef0 |  5.95 |   4.5 |
| `color-status-info-text`      | `color-surface-raised`         | #065da0 on #fefcfd |  6.67 |   4.5 |
| `color-status-info-text`      | `color-surface-hover`          | #065da0 on #f4eef0 |  5.95 |   4.5 |
| `color-status-info-text`      | `color-status-info-surface`    | #065da0 on #ebf5ff |  6.18 |   4.5 |
| `color-text-primary`          | `color-status-info-surface`    | #1a1617 on #ebf5ff | 16.26 |   4.5 |
| `color-text-secondary`        | `color-status-info-surface`    | #554d50 on #ebf5ff |  7.43 |   4.5 |
| `color-status-info-border`    | `color-surface-default`        | #166eb9 on #fefcfd |  5.18 |     3 |
| `color-status-info-border`    | `color-surface-subtle`         | #166eb9 on #faf5f7 |  4.91 |     3 |
| `color-status-info-border`    | `color-surface-sunken`         | #166eb9 on #f4eef0 |  4.62 |     3 |
| `color-status-info-border`    | `color-surface-raised`         | #166eb9 on #fefcfd |  5.18 |     3 |
| `color-status-info-border`    | `color-surface-hover`          | #166eb9 on #f4eef0 |  4.62 |     3 |
| `color-status-info-border`    | `color-status-info-surface`    | #166eb9 on #ebf5ff |  4.80 |     3 |
| `color-status-success-text`   | `color-surface-default`        | #086d31 on #fefcfd |  6.34 |   4.5 |
| `color-status-success-text`   | `color-surface-subtle`         | #086d31 on #faf5f7 |  6.00 |   4.5 |
| `color-status-success-text`   | `color-surface-sunken`         | #086d31 on #f4eef0 |  5.66 |   4.5 |
| `color-status-success-text`   | `color-surface-raised`         | #086d31 on #fefcfd |  6.34 |   4.5 |
| `color-status-success-text`   | `color-surface-hover`          | #086d31 on #f4eef0 |  5.66 |   4.5 |
| `color-status-success-text`   | `color-status-success-surface` | #086d31 on #e8f9eb |  5.92 |   4.5 |
| `color-text-primary`          | `color-status-success-surface` | #1a1617 on #e8f9eb | 16.38 |   4.5 |
| `color-text-secondary`        | `color-status-success-surface` | #554d50 on #e8f9eb |  7.48 |   4.5 |
| `color-status-success-border` | `color-surface-default`        | #25984d on #fefcfd |  3.62 |     3 |
| `color-status-success-border` | `color-surface-subtle`         | #25984d on #faf5f7 |  3.43 |     3 |
| `color-status-success-border` | `color-surface-sunken`         | #25984d on #f4eef0 |  3.23 |     3 |
| `color-status-success-border` | `color-surface-raised`         | #25984d on #fefcfd |  3.62 |     3 |
| `color-status-success-border` | `color-surface-hover`          | #25984d on #f4eef0 |  3.23 |     3 |
| `color-status-success-border` | `color-status-success-surface` | #25984d on #e8f9eb |  3.38 |     3 |
| `color-status-warning-text`   | `color-surface-default`        | #7d4f0a on #fefcfd |  6.86 |   4.5 |
| `color-status-warning-text`   | `color-surface-subtle`         | #7d4f0a on #faf5f7 |  6.50 |   4.5 |
| `color-status-warning-text`   | `color-surface-sunken`         | #7d4f0a on #f4eef0 |  6.12 |   4.5 |
| `color-status-warning-text`   | `color-surface-raised`         | #7d4f0a on #fefcfd |  6.86 |   4.5 |
| `color-status-warning-text`   | `color-surface-hover`          | #7d4f0a on #f4eef0 |  6.12 |   4.5 |
| `color-status-warning-text`   | `color-status-warning-surface` | #7d4f0a on #fff1e2 |  6.32 |   4.5 |
| `color-text-primary`          | `color-status-warning-surface` | #1a1617 on #fff1e2 | 16.17 |   4.5 |
| `color-text-secondary`        | `color-status-warning-surface` | #554d50 on #fff1e2 |  7.38 |   4.5 |
| `color-status-warning-border` | `color-surface-default`        | #b77610 on #fefcfd |  3.66 |     3 |
| `color-status-warning-border` | `color-surface-subtle`         | #b77610 on #faf5f7 |  3.47 |     3 |
| `color-status-warning-border` | `color-surface-sunken`         | #b77610 on #f4eef0 |  3.27 |     3 |
| `color-status-warning-border` | `color-surface-raised`         | #b77610 on #fefcfd |  3.66 |     3 |
| `color-status-warning-border` | `color-surface-hover`          | #b77610 on #f4eef0 |  3.27 |     3 |
| `color-status-warning-border` | `color-status-warning-surface` | #b77610 on #fff1e2 |  3.37 |     3 |
| `color-status-danger-text`    | `color-surface-default`        | #963730 on #fefcfd |  7.12 |   4.5 |
| `color-status-danger-text`    | `color-surface-subtle`         | #963730 on #faf5f7 |  6.75 |   4.5 |
| `color-status-danger-text`    | `color-surface-sunken`         | #963730 on #f4eef0 |  6.35 |   4.5 |
| `color-status-danger-text`    | `color-surface-raised`         | #963730 on #fefcfd |  7.12 |   4.5 |
| `color-status-danger-text`    | `color-surface-hover`          | #963730 on #f4eef0 |  6.35 |   4.5 |
| `color-status-danger-text`    | `color-status-danger-surface`  | #963730 on #ffefed |  6.52 |   4.5 |
| `color-text-primary`          | `color-status-danger-surface`  | #1a1617 on #ffefed | 16.07 |   4.5 |
| `color-text-secondary`        | `color-status-danger-surface`  | #554d50 on #ffefed |  7.34 |   4.5 |
| `color-status-danger-border`  | `color-surface-default`        | #9e2d28 on #fefcfd |  7.19 |     3 |
| `color-status-danger-border`  | `color-surface-subtle`         | #9e2d28 on #faf5f7 |  6.81 |     3 |
| `color-status-danger-border`  | `color-surface-sunken`         | #9e2d28 on #f4eef0 |  6.41 |     3 |
| `color-status-danger-border`  | `color-surface-raised`         | #9e2d28 on #fefcfd |  7.19 |     3 |
| `color-status-danger-border`  | `color-surface-hover`          | #9e2d28 on #f4eef0 |  6.41 |     3 |
| `color-status-danger-border`  | `color-status-danger-surface`  | #9e2d28 on #ffefed |  6.58 |     3 |
| `color-border-control`        | `color-surface-default`        | #898084 on #fefcfd |  3.75 |     3 |
| `color-border-control`        | `color-surface-subtle`         | #898084 on #faf5f7 |  3.55 |     3 |
| `color-border-control`        | `color-surface-sunken`         | #898084 on #f4eef0 |  3.34 |     3 |
| `color-border-control`        | `color-surface-raised`         | #898084 on #fefcfd |  3.75 |     3 |
| `color-border-control`        | `color-surface-hover`          | #898084 on #f4eef0 |  3.34 |     3 |
| `color-border-control`        | `color-surface-selected`       | #898084 on #feeff4 |  3.44 |     3 |
| `color-focus-ring`            | `color-surface-default`        | #692746 on #fefcfd | 10.39 |     3 |
| `color-focus-ring`            | `color-surface-subtle`         | #692746 on #faf5f7 |  9.84 |     3 |
| `color-focus-ring`            | `color-surface-sunken`         | #692746 on #f4eef0 |  9.26 |     3 |
| `color-focus-ring`            | `color-surface-raised`         | #692746 on #fefcfd | 10.39 |     3 |
| `color-focus-ring`            | `color-surface-hover`          | #692746 on #f4eef0 |  9.26 |     3 |
| `color-focus-ring`            | `color-surface-selected`       | #692746 on #feeff4 |  9.53 |     3 |
| `color-accent-default`        | `color-surface-default`        | #692746 on #fefcfd | 10.39 |     3 |
| `color-accent-default`        | `color-surface-subtle`         | #692746 on #faf5f7 |  9.84 |     3 |
| `color-accent-default`        | `color-surface-sunken`         | #692746 on #f4eef0 |  9.26 |     3 |
| `color-accent-default`        | `color-surface-raised`         | #692746 on #fefcfd | 10.39 |     3 |
| `color-accent-default`        | `color-surface-hover`          | #692746 on #f4eef0 |  9.26 |     3 |
| `color-accent-default`        | `color-surface-selected`       | #692746 on #feeff4 |  9.53 |     3 |
| `button-primary-fg`           | `button-primary-bg`            | #fefcfd on #692746 | 10.39 |   4.5 |
| `button-primary-fg`           | `button-primary-bg-hover`      | #fefcfd on #4f1a33 | 13.45 |   4.5 |
| `button-primary-fg`           | `button-primary-bg-active`     | #fefcfd on #381224 | 16.06 |   4.5 |
| `button-secondary-fg`         | `button-secondary-bg`          | #1a1617 on #fefcfd | 17.55 |   4.5 |
| `button-secondary-fg`         | `button-secondary-bg-hover`    | #1a1617 on #f4eef0 | 15.66 |   4.5 |
| `button-secondary-border`     | `button-secondary-bg`          | #898084 on #fefcfd |  3.75 |     3 |
| `button-secondary-border`     | `button-secondary-bg-hover`    | #898084 on #f4eef0 |  3.34 |     3 |
| `input-fg`                    | `input-bg`                     | #1a1617 on #fefcfd | 17.55 |   4.5 |
| `input-placeholder`           | `input-bg`                     | #6f6669 on #fefcfd |  5.44 |   4.5 |
| `input-border`                | `input-bg`                     | #898084 on #fefcfd |  3.75 |     3 |
| `input-border-focus`          | `input-bg`                     | #692746 on #fefcfd | 10.39 |     3 |
| `code-block-fg`               | `code-block-bg`                | #1a1617 on #faf5f7 | 16.62 |   4.5 |
| `link-fg`                     | `card-bg`                      | #692746 on #fefcfd | 10.39 |   4.5 |
| `link-fg-hover`               | `card-bg`                      | #4f1a33 on #fefcfd | 13.45 |   4.5 |
| `link-fg`                     | `color-surface-default`        | #692746 on #fefcfd | 10.39 |   4.5 |
| `link-fg-hover`               | `color-surface-default`        | #4f1a33 on #fefcfd | 13.45 |   4.5 |
| `nav-item-fg-active`          | `nav-item-bg-active`           | #692746 on #feeff4 |  9.53 |   4.5 |
| `nav-item-fg-active`          | `nav-item-bg-hover`            | #692746 on #f4eef0 |  9.26 |   4.5 |
| `badge-neutral-fg`            | `badge-neutral-bg`             | #554d50 on #f4eef0 |  7.15 |   4.5 |
| `callout-info-icon`           | `callout-info-bg`              | #166eb9 on #ebf5ff |  4.80 |     3 |
| `callout-info-fg`             | `callout-info-bg`              | #065da0 on #ebf5ff |  6.18 |   4.5 |
| `callout-info-border`         | `callout-info-bg`              | #166eb9 on #ebf5ff |  4.80 |     3 |
| `callout-success-icon`        | `callout-success-bg`           | #25984d on #e8f9eb |  3.38 |     3 |
| `callout-success-fg`          | `callout-success-bg`           | #086d31 on #e8f9eb |  5.92 |   4.5 |
| `callout-success-border`      | `callout-success-bg`           | #25984d on #e8f9eb |  3.38 |     3 |
| `callout-warning-icon`        | `callout-warning-bg`           | #b77610 on #fff1e2 |  3.37 |     3 |
| `callout-warning-fg`          | `callout-warning-bg`           | #7d4f0a on #fff1e2 |  6.32 |   4.5 |
| `callout-warning-border`      | `callout-warning-bg`           | #b77610 on #fff1e2 |  3.37 |     3 |
| `callout-danger-icon`         | `callout-danger-bg`            | #9e2d28 on #ffefed |  6.58 |     3 |
| `callout-danger-fg`           | `callout-danger-bg`            | #963730 on #ffefed |  6.52 |   4.5 |
| `callout-danger-border`       | `callout-danger-bg`            | #9e2d28 on #ffefed |  6.58 |     3 |

## Dark theme

| Foreground                    | Background                     | Hex                | Ratio | Floor |
| ----------------------------- | ------------------------------ | ------------------ | ----: | ----: |
| `color-text-primary`          | `color-surface-default`        | #faf5f7 on #120e10 | 17.76 |   4.5 |
| `color-text-primary`          | `color-surface-subtle`         | #faf5f7 on #1a1617 | 16.62 |   4.5 |
| `color-text-primary`          | `color-surface-sunken`         | #faf5f7 on #120e10 | 17.76 |   4.5 |
| `color-text-primary`          | `color-surface-raised`         | #faf5f7 on #241f21 | 15.06 |   4.5 |
| `color-text-primary`          | `color-surface-hover`          | #faf5f7 on #30292c | 13.16 |   4.5 |
| `color-text-primary`          | `color-surface-selected`       | #faf5f7 on #280f1a | 16.59 |   4.5 |
| `color-text-primary`          | `color-surface-code`           | #faf5f7 on #1a1617 | 16.62 |   4.5 |
| `color-text-primary`          | `color-accent-tint`            | #faf5f7 on #280f1a | 16.59 |   4.5 |
| `color-text-secondary`        | `color-surface-default`        | #cdc5c8 on #120e10 | 11.33 |   4.5 |
| `color-text-secondary`        | `color-surface-subtle`         | #cdc5c8 on #1a1617 | 10.60 |   4.5 |
| `color-text-secondary`        | `color-surface-sunken`         | #cdc5c8 on #120e10 | 11.33 |   4.5 |
| `color-text-secondary`        | `color-surface-raised`         | #cdc5c8 on #241f21 |  9.60 |   4.5 |
| `color-text-secondary`        | `color-surface-hover`          | #cdc5c8 on #30292c |  8.39 |   4.5 |
| `color-text-secondary`        | `color-surface-selected`       | #cdc5c8 on #280f1a | 10.58 |   4.5 |
| `color-text-secondary`        | `color-surface-code`           | #cdc5c8 on #1a1617 | 10.60 |   4.5 |
| `color-text-secondary`        | `color-accent-tint`            | #cdc5c8 on #280f1a | 10.58 |   4.5 |
| `color-text-tertiary`         | `color-surface-default`        | #aba2a5 on #120e10 |  7.70 |   4.5 |
| `color-text-tertiary`         | `color-surface-subtle`         | #aba2a5 on #1a1617 |  7.21 |   4.5 |
| `color-text-tertiary`         | `color-surface-sunken`         | #aba2a5 on #120e10 |  7.70 |   4.5 |
| `color-text-tertiary`         | `color-surface-raised`         | #aba2a5 on #241f21 |  6.53 |   4.5 |
| `color-text-tertiary`         | `color-surface-hover`          | #aba2a5 on #30292c |  5.71 |   4.5 |
| `color-text-tertiary`         | `color-surface-selected`       | #aba2a5 on #280f1a |  7.19 |   4.5 |
| `color-text-tertiary`         | `color-surface-code`           | #aba2a5 on #1a1617 |  7.21 |   4.5 |
| `color-text-tertiary`         | `color-accent-tint`            | #aba2a5 on #280f1a |  7.19 |   4.5 |
| `color-accent-text`           | `color-surface-default`        | #d1789e on #120e10 |  6.29 |   4.5 |
| `color-accent-text`           | `color-surface-subtle`         | #d1789e on #1a1617 |  5.88 |   4.5 |
| `color-accent-text`           | `color-surface-sunken`         | #d1789e on #120e10 |  6.29 |   4.5 |
| `color-accent-text`           | `color-surface-raised`         | #d1789e on #241f21 |  5.33 |   4.5 |
| `color-accent-text`           | `color-surface-hover`          | #d1789e on #30292c |  4.66 |   4.5 |
| `color-accent-text`           | `color-surface-selected`       | #d1789e on #280f1a |  5.87 |   4.5 |
| `color-accent-text`           | `color-surface-code`           | #d1789e on #1a1617 |  5.88 |   4.5 |
| `color-accent-text`           | `color-accent-tint`            | #d1789e on #280f1a |  5.87 |   4.5 |
| `color-text-on-accent`        | `color-accent-default`         | #120e10 on #d1789e |  6.29 |   4.5 |
| `color-text-on-accent`        | `color-accent-hover`           | #120e10 on #e799b9 |  8.81 |   4.5 |
| `color-text-on-accent`        | `color-accent-active`          | #120e10 on #f4c0d4 | 12.17 |   4.5 |
| `color-status-info-text`      | `color-surface-default`        | #8ac3fe on #120e10 | 10.33 |   4.5 |
| `color-status-info-text`      | `color-surface-subtle`         | #8ac3fe on #1a1617 |  9.66 |   4.5 |
| `color-status-info-text`      | `color-surface-sunken`         | #8ac3fe on #120e10 | 10.33 |   4.5 |
| `color-status-info-text`      | `color-surface-raised`         | #8ac3fe on #241f21 |  8.75 |   4.5 |
| `color-status-info-text`      | `color-surface-hover`          | #8ac3fe on #30292c |  7.65 |   4.5 |
| `color-status-info-text`      | `color-status-info-surface`    | #8ac3fe on #0d1e2f |  9.10 |   4.5 |
| `color-text-primary`          | `color-status-info-surface`    | #faf5f7 on #0d1e2f | 15.65 |   4.5 |
| `color-text-secondary`        | `color-status-info-surface`    | #cdc5c8 on #0d1e2f |  9.98 |   4.5 |
| `color-status-info-border`    | `color-surface-default`        | #60aaf3 on #120e10 |  7.79 |     3 |
| `color-status-info-border`    | `color-surface-subtle`         | #60aaf3 on #1a1617 |  7.29 |     3 |
| `color-status-info-border`    | `color-surface-sunken`         | #60aaf3 on #120e10 |  7.79 |     3 |
| `color-status-info-border`    | `color-surface-raised`         | #60aaf3 on #241f21 |  6.61 |     3 |
| `color-status-info-border`    | `color-surface-hover`          | #60aaf3 on #30292c |  5.77 |     3 |
| `color-status-info-border`    | `color-status-info-surface`    | #60aaf3 on #0d1e2f |  6.87 |     3 |
| `color-status-success-text`   | `color-surface-default`        | #89d298 on #120e10 | 10.71 |   4.5 |
| `color-status-success-text`   | `color-surface-subtle`         | #89d298 on #1a1617 | 10.02 |   4.5 |
| `color-status-success-text`   | `color-surface-sunken`         | #89d298 on #120e10 | 10.71 |   4.5 |
| `color-status-success-text`   | `color-surface-raised`         | #89d298 on #241f21 |  9.08 |   4.5 |
| `color-status-success-text`   | `color-surface-hover`          | #89d298 on #30292c |  7.93 |   4.5 |
| `color-status-success-text`   | `color-status-success-surface` | #89d298 on #0e2213 |  9.34 |   4.5 |
| `color-text-primary`          | `color-status-success-surface` | #faf5f7 on #0e2213 | 15.49 |   4.5 |
| `color-text-secondary`        | `color-status-success-surface` | #cdc5c8 on #0e2213 |  9.88 |   4.5 |
| `color-status-success-border` | `color-surface-default`        | #6ed889 on #120e10 | 10.81 |     3 |
| `color-status-success-border` | `color-surface-subtle`         | #6ed889 on #1a1617 | 10.12 |     3 |
| `color-status-success-border` | `color-surface-sunken`         | #6ed889 on #120e10 | 10.81 |     3 |
| `color-status-success-border` | `color-surface-raised`         | #6ed889 on #241f21 |  9.16 |     3 |
| `color-status-success-border` | `color-surface-hover`          | #6ed889 on #30292c |  8.01 |     3 |
| `color-status-success-border` | `color-status-success-surface` | #6ed889 on #0e2213 |  9.43 |     3 |
| `color-status-warning-text`   | `color-surface-default`        | #ebb16c on #120e10 | 10.07 |   4.5 |
| `color-status-warning-text`   | `color-surface-subtle`         | #ebb16c on #1a1617 |  9.43 |   4.5 |
| `color-status-warning-text`   | `color-surface-sunken`         | #ebb16c on #120e10 | 10.07 |   4.5 |
| `color-status-warning-text`   | `color-surface-raised`         | #ebb16c on #241f21 |  8.54 |   4.5 |
| `color-status-warning-text`   | `color-surface-hover`          | #ebb16c on #30292c |  7.46 |   4.5 |
| `color-status-warning-text`   | `color-status-warning-surface` | #ebb16c on #291906 |  8.93 |   4.5 |
| `color-text-primary`          | `color-status-warning-surface` | #faf5f7 on #291906 | 15.75 |   4.5 |
| `color-text-secondary`        | `color-status-warning-surface` | #cdc5c8 on #291906 | 10.05 |   4.5 |
| `color-status-warning-border` | `color-surface-default`        | #fec582 on #120e10 | 12.34 |     3 |
| `color-status-warning-border` | `color-surface-subtle`         | #fec582 on #1a1617 | 11.55 |     3 |
| `color-status-warning-border` | `color-surface-sunken`         | #fec582 on #120e10 | 12.34 |     3 |
| `color-status-warning-border` | `color-surface-raised`         | #fec582 on #241f21 | 10.46 |     3 |
| `color-status-warning-border` | `color-surface-hover`          | #fec582 on #30292c |  9.14 |     3 |
| `color-status-warning-border` | `color-status-warning-surface` | #fec582 on #291906 | 10.94 |     3 |
| `color-status-danger-text`    | `color-surface-default`        | #fda297 on #120e10 |  9.85 |   4.5 |
| `color-status-danger-text`    | `color-surface-subtle`         | #fda297 on #1a1617 |  9.22 |   4.5 |
| `color-status-danger-text`    | `color-surface-sunken`         | #fda297 on #120e10 |  9.85 |   4.5 |
| `color-status-danger-text`    | `color-surface-raised`         | #fda297 on #241f21 |  8.35 |   4.5 |
| `color-status-danger-text`    | `color-surface-hover`          | #fda297 on #30292c |  7.30 |   4.5 |
| `color-status-danger-text`    | `color-status-danger-surface`  | #fda297 on #2d1512 |  8.79 |   4.5 |
| `color-text-primary`          | `color-status-danger-surface`  | #faf5f7 on #2d1512 | 15.86 |   4.5 |
| `color-text-secondary`        | `color-status-danger-surface`  | #cdc5c8 on #2d1512 | 10.11 |   4.5 |
| `color-status-danger-border`  | `color-surface-default`        | #d24d45 on #120e10 |  4.46 |     3 |
| `color-status-danger-border`  | `color-surface-subtle`         | #d24d45 on #1a1617 |  4.17 |     3 |
| `color-status-danger-border`  | `color-surface-sunken`         | #d24d45 on #120e10 |  4.46 |     3 |
| `color-status-danger-border`  | `color-surface-raised`         | #d24d45 on #241f21 |  3.78 |     3 |
| `color-status-danger-border`  | `color-surface-hover`          | #d24d45 on #30292c |  3.30 |     3 |
| `color-status-danger-border`  | `color-status-danger-surface`  | #d24d45 on #2d1512 |  3.98 |     3 |
| `color-border-control`        | `color-surface-default`        | #898084 on #120e10 |  5.00 |     3 |
| `color-border-control`        | `color-surface-subtle`         | #898084 on #1a1617 |  4.68 |     3 |
| `color-border-control`        | `color-surface-sunken`         | #898084 on #120e10 |  5.00 |     3 |
| `color-border-control`        | `color-surface-raised`         | #898084 on #241f21 |  4.24 |     3 |
| `color-border-control`        | `color-surface-hover`          | #898084 on #30292c |  3.71 |     3 |
| `color-border-control`        | `color-surface-selected`       | #898084 on #280f1a |  4.67 |     3 |
| `color-focus-ring`            | `color-surface-default`        | #e799b9 on #120e10 |  8.81 |     3 |
| `color-focus-ring`            | `color-surface-subtle`         | #e799b9 on #1a1617 |  8.24 |     3 |
| `color-focus-ring`            | `color-surface-sunken`         | #e799b9 on #120e10 |  8.81 |     3 |
| `color-focus-ring`            | `color-surface-raised`         | #e799b9 on #241f21 |  7.47 |     3 |
| `color-focus-ring`            | `color-surface-hover`          | #e799b9 on #30292c |  6.53 |     3 |
| `color-focus-ring`            | `color-surface-selected`       | #e799b9 on #280f1a |  8.23 |     3 |
| `color-accent-default`        | `color-surface-default`        | #d1789e on #120e10 |  6.29 |     3 |
| `color-accent-default`        | `color-surface-subtle`         | #d1789e on #1a1617 |  5.88 |     3 |
| `color-accent-default`        | `color-surface-sunken`         | #d1789e on #120e10 |  6.29 |     3 |
| `color-accent-default`        | `color-surface-raised`         | #d1789e on #241f21 |  5.33 |     3 |
| `color-accent-default`        | `color-surface-hover`          | #d1789e on #30292c |  4.66 |     3 |
| `color-accent-default`        | `color-surface-selected`       | #d1789e on #280f1a |  5.87 |     3 |
| `button-primary-fg`           | `button-primary-bg`            | #120e10 on #d1789e |  6.29 |   4.5 |
| `button-primary-fg`           | `button-primary-bg-hover`      | #120e10 on #e799b9 |  8.81 |   4.5 |
| `button-primary-fg`           | `button-primary-bg-active`     | #120e10 on #f4c0d4 | 12.17 |   4.5 |
| `button-secondary-fg`         | `button-secondary-bg`          | #faf5f7 on #120e10 | 17.76 |   4.5 |
| `button-secondary-fg`         | `button-secondary-bg-hover`    | #faf5f7 on #30292c | 13.16 |   4.5 |
| `button-secondary-border`     | `button-secondary-bg`          | #898084 on #120e10 |  5.00 |     3 |
| `button-secondary-border`     | `button-secondary-bg-hover`    | #898084 on #30292c |  3.71 |     3 |
| `input-fg`                    | `input-bg`                     | #faf5f7 on #120e10 | 17.76 |   4.5 |
| `input-placeholder`           | `input-bg`                     | #aba2a5 on #120e10 |  7.70 |   4.5 |
| `input-border`                | `input-bg`                     | #898084 on #120e10 |  5.00 |     3 |
| `input-border-focus`          | `input-bg`                     | #e799b9 on #120e10 |  8.81 |     3 |
| `code-block-fg`               | `code-block-bg`                | #faf5f7 on #1a1617 | 16.62 |   4.5 |
| `link-fg`                     | `card-bg`                      | #d1789e on #241f21 |  5.33 |   4.5 |
| `link-fg-hover`               | `card-bg`                      | #e799b9 on #241f21 |  7.47 |   4.5 |
| `link-fg`                     | `color-surface-default`        | #d1789e on #120e10 |  6.29 |   4.5 |
| `link-fg-hover`               | `color-surface-default`        | #e799b9 on #120e10 |  8.81 |   4.5 |
| `nav-item-fg-active`          | `nav-item-bg-active`           | #d1789e on #280f1a |  5.87 |   4.5 |
| `nav-item-fg-active`          | `nav-item-bg-hover`            | #d1789e on #30292c |  4.66 |   4.5 |
| `badge-neutral-fg`            | `badge-neutral-bg`             | #cdc5c8 on #120e10 | 11.33 |   4.5 |
| `callout-info-icon`           | `callout-info-bg`              | #60aaf3 on #0d1e2f |  6.87 |     3 |
| `callout-info-fg`             | `callout-info-bg`              | #8ac3fe on #0d1e2f |  9.10 |   4.5 |
| `callout-info-border`         | `callout-info-bg`              | #60aaf3 on #0d1e2f |  6.87 |     3 |
| `callout-success-icon`        | `callout-success-bg`           | #6ed889 on #0e2213 |  9.43 |     3 |
| `callout-success-fg`          | `callout-success-bg`           | #89d298 on #0e2213 |  9.34 |   4.5 |
| `callout-success-border`      | `callout-success-bg`           | #6ed889 on #0e2213 |  9.43 |     3 |
| `callout-warning-icon`        | `callout-warning-bg`           | #fec582 on #291906 | 10.94 |     3 |
| `callout-warning-fg`          | `callout-warning-bg`           | #ebb16c on #291906 |  8.93 |   4.5 |
| `callout-warning-border`      | `callout-warning-bg`           | #fec582 on #291906 | 10.94 |     3 |
| `callout-danger-icon`         | `callout-danger-bg`            | #d24d45 on #2d1512 |  3.98 |     3 |
| `callout-danger-fg`           | `callout-danger-bg`            | #fda297 on #2d1512 |  8.79 |   4.5 |
| `callout-danger-border`       | `callout-danger-bg`            | #d24d45 on #2d1512 |  3.98 |     3 |

## Tightest pairs

- light: `color-text-tertiary` on `color-surface-sunken` at 4.85:1
- dark: `color-accent-text` on `color-surface-hover` at 4.66:1

## Components

Every text/surface and mark/surface pair the component previews paint, including the surfaces a component is likely to sit on (page, card, sidebar). Values are resolved from `tokens.json` per theme. axe-core's colour-contrast rule on the rendered previews also passed in both themes.

### Callout

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

### CodeBlock

| Pair                     | Tokens                                         | Light |  Dark | Floor |
| ------------------------ | ---------------------------------------------- | ----: | ----: | ----: |
| code                     | `color-text-primary` on `color-surface-code`   | 16.62 | 16.62 |   4.5 |
| comments, header         | `color-text-secondary` on `color-surface-code` |  7.59 | 10.60 |   4.5 |
| inline code on page      | `color-text-primary` on `color-surface-hover`  | 15.66 | 13.16 |   4.5 |
| scroll-region focus ring | `color-focus-ring` on `color-surface-default`  | 10.39 |  8.81 |     3 |

### Badge

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

### Button

| Pair                           | Tokens                                            | Light |  Dark | Floor |
| ------------------------------ | ------------------------------------------------- | ----: | ----: | ----: |
| primary                        | `color-text-on-accent` on `color-accent-default`  | 10.39 |  6.29 |   4.5 |
| primary hover                  | `color-text-on-accent` on `color-accent-hover`    | 13.45 |  8.81 |   4.5 |
| primary active                 | `color-text-on-accent` on `color-accent-active`   | 16.06 | 12.17 |   4.5 |
| primary edge vs page           | `color-accent-default` on `color-surface-default` | 10.39 |  6.29 |     3 |
| primary edge vs card           | `color-accent-default` on `color-surface-raised`  | 10.39 |  5.33 |     3 |
| secondary                      | `color-text-primary` on `color-surface-default`   | 17.55 | 17.76 |   4.5 |
| secondary/ghost hover + active | `color-text-primary` on `color-surface-hover`     | 15.66 | 13.16 |   4.5 |
| secondary border               | `color-border-control` on `color-surface-default` |  3.75 |  5.00 |     3 |
| secondary border, hover        | `color-border-control` on `color-surface-hover`   |  3.34 |  3.71 |     3 |
| secondary border on card       | `color-border-control` on `color-surface-raised`  |  3.75 |  4.24 |     3 |
| ghost on card                  | `color-text-primary` on `color-surface-raised`    | 17.55 | 15.06 |   4.5 |
| focus ring                     | `color-focus-ring` on `color-surface-default`     | 10.39 |  8.81 |     3 |
| focus ring on card             | `color-focus-ring` on `color-surface-raised`      | 10.39 |  7.47 |     3 |

### Input

| Pair                | Tokens                                                  | Light |  Dark | Floor |
| ------------------- | ------------------------------------------------------- | ----: | ----: | ----: |
| label, value        | `color-text-primary` on `color-surface-default`         | 17.55 | 17.76 |   4.5 |
| placeholder         | `color-text-tertiary` on `color-surface-default`        |  5.44 |  7.70 |   4.5 |
| hint, optional      | `color-text-secondary` on `color-surface-default`       |  8.02 | 11.33 |   4.5 |
| error message       | `color-status-danger-text` on `color-surface-default`   |  7.12 |  9.85 |   4.5 |
| error border, icon  | `color-status-danger-border` on `color-surface-default` |  7.19 |  4.46 |     3 |
| border              | `color-border-control` on `color-surface-default`       |  3.75 |  5.00 |     3 |
| focus border + ring | `color-focus-ring` on `color-surface-default`           | 10.39 |  8.81 |     3 |
| label on card       | `color-text-primary` on `color-surface-raised`          | 17.55 | 15.06 |   4.5 |
| border on card      | `color-border-control` on `color-surface-raised`        |  3.75 |  4.24 |     3 |
| error on card       | `color-status-danger-text` on `color-surface-raised`    |  7.12 |  8.35 |   4.5 |

### Card

| Pair                                | Tokens                                           | Light |  Dark | Floor |
| ----------------------------------- | ------------------------------------------------ | ----: | ----: | ----: |
| title                               | `color-text-primary` on `color-surface-raised`   | 17.55 | 15.06 |   4.5 |
| body                                | `color-text-secondary` on `color-surface-raised` |  8.02 |  9.60 |   4.5 |
| meta                                | `color-text-tertiary` on `color-surface-raised`  |  5.44 |  6.53 |   4.5 |
| focus ring (drawn outside the card) | `color-focus-ring` on `color-surface-default`    | 10.39 |  8.81 |     3 |
| focus ring on subtle band           | `color-focus-ring` on `color-surface-subtle`     |  9.84 |  8.24 |     3 |

### Nav

| Pair                  | Tokens                                            | Light |  Dark | Floor |
| --------------------- | ------------------------------------------------- | ----: | ----: | ----: |
| item in sidebar       | `color-text-secondary` on `color-surface-subtle`  |  7.59 | 10.60 |   4.5 |
| item in header        | `color-text-secondary` on `color-surface-default` |  8.02 | 11.33 |   4.5 |
| group heading         | `color-text-primary` on `color-surface-subtle`    | 16.62 | 16.62 |   4.5 |
| item hover            | `color-text-primary` on `color-surface-hover`     | 15.66 | 13.16 |   4.5 |
| current item          | `color-accent-text` on `color-surface-selected`   |  9.53 |  5.87 |   4.5 |
| focus ring in sidebar | `color-focus-ring` on `color-surface-subtle`      |  9.84 |  8.24 |     3 |
| focus ring in header  | `color-focus-ring` on `color-surface-default`     | 10.39 |  8.81 |     3 |
