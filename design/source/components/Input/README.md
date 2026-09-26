# Input

A single-line text field with a visible label, an optional hint and an inline error message.

## Use it for

- Short free text: names, ports, URLs. Always inside `m3l-field` with a `<label>`. A placeholder is an example, never the label.

## Markup (the consumer provides)

```html
<div class="m3l-field">
  <label class="m3l-field__label label" for="port"
    >Dev server port
    <span class="m3l-field__optional caption">(optional)</span></label
  >
  <input
    class="m3l-input body"
    id="port"
    aria-invalid="true"
    aria-describedby="port-err"
  />
  <p class="m3l-field__error caption" id="port-err">
    <svg class="m3l-icon" …>…</svg
    ><span
      ><span class="m3l-visually-hidden">Error: </span>Use a port from 1024 to
      65535.</span
    >
  </p>
</div>
```

- Mark optional fields in words ("(optional)"). Never rely on an asterisk alone.
- The error message has three cues, not just a red border: the danger glyph, the text, and a hidden "Error:" prefix for screen readers. Link it with `aria-describedby` and set `aria-invalid`.
- Type: `label` for the label, `body` for the value (with word spacing and tabular figures), `caption` for hint and error.

## Tokens

- Field: `color-surface-default` fill, `color-border-control` border, `color-text-primary` value, `color-text-tertiary` placeholder.
- Hint and "(optional)": `color-text-secondary`. Error: `color-status-danger-text` text, `color-status-danger-border` border and icon.
- Focus: the border turns `color-focus-ring`, plus the standard outside ring.
- Disabled: `color-surface-hover` fill (interim, see Flags), `color-text-disabled`, `color-border-default` border.
- Shape `radius-md`, padding `space-2 space-3`, field gap `space-1`, width capped at `measure-prose`.
- Component-tier aliases: `input-bg`, `-border`, `-border-focus`, `-fg`, `-placeholder`.
- There is no hover-border token, so there is no hover state (out of v1 scope).

## Flags

- `color-surface-sunken` equals `color-surface-default` in dark (both `neutral-1000`), so a sunken disabled field would look the same as an enabled one (1.00:1 against the page and the field fill). The disabled fill uses `color-surface-hover` until a token decision is made. That fill is `neutral-100` in light (the same colour as sunken) and `neutral-850` in dark (1.35:1 against the page). The disabled border is `color-border-default`, not `color-border-subtle`: in dark, subtle is `neutral-850`, the same colour as the fill (1.00:1). `border-default` is 1.18:1 against the fill in light and 1.21:1 in dark, quieter on purpose than the enabled `color-border-control` (3.34 / 3.71).

## Contrast (WCAG 2.2 AA)

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
