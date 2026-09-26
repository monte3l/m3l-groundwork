# Button

Triggers an action on the current page: primary for the one main action in a view, secondary for alternatives, ghost for low-emphasis actions such as Cancel.

## Use it for

- At most one `primary` per view. `secondary` for other actions. `ghost` for dismiss/cancel and toolbar actions.
- Anything that navigates is a link (`m3l-link`), not a button.
- There is no destructive (danger-filled) variant, which is out of v1 scope: the tokens have no `on-danger` text colour. Confirm destructive actions in a dialog, with a secondary button labelled with the verb.

## Markup (the consumer provides)

```html
<button class="m3l-button label" data-variant="primary" type="button">
  Run bootstrap
</button>
```

- A text label is always visible. An icon-only button needs an `aria-label`.
- Disabled: the native `disabled` attribute, or `aria-disabled="true"` when it must stay focusable. Hover and press styles skip disabled buttons, so a disabled primary never lights up on hover. Disabled colours are exempt from WCAG 1.4.3 and are **not** readable-contrast: say why an action is unavailable nearby.
- Type: the `label` style. Height comes from line-height 1.5 plus `space-2` padding (about 39px), above the 24px minimum target size (WCAG 2.5.8).

## Tokens

- Primary: `color-accent-default` / `-hover` / `-active` fill, `color-text-on-accent` label.
- Secondary: `color-surface-default` fill, `color-border-control` border, `color-text-primary` label; hover/active `color-surface-hover`.
- Ghost: transparent, `color-text-primary`; hover/active `color-surface-hover`.
- Disabled: `color-surface-hover` fill (interim, see Flags), `color-text-disabled`, `color-border-default` border.
- Focus: `color-focus-ring`, `focus-ring-width`, `focus-ring-offset`.
- Shape `radius-md`, padding `space-2 space-4`, gap `space-2`. Motion: colour only, `duration-fast` + `easing-standard`, `duration-instant` under reduced motion.
- Component-tier aliases: `button-primary-*`, `button-secondary-*`.

## Flags

- `color-surface-sunken` equals `color-surface-default` in dark (both `neutral-1000`), so a sunken disabled fill would not show on the page (1.00:1). The disabled fill uses `color-surface-hover` until a token decision is made. That fill is `neutral-100` in light (the same colour as sunken) and `neutral-850` in dark (1.35:1 against the page). The disabled border is `color-border-default`, not `color-border-subtle`: in dark, subtle is `neutral-850`, the same colour as the fill (1.00:1). `border-default` is 1.18:1 against the fill in light and 1.21:1 in dark, quieter on purpose than the enabled `color-border-control` (3.34 / 3.71).

## Contrast (WCAG 2.2 AA)

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
