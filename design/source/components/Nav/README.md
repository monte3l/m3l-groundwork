# Nav

Navigation links: a vertical docs sidebar with group headings, or a horizontal site header.

## Use it for

- The sidebar is for docs sections. The horizontal nav is for 3–6 top-level site destinations. Use one `<nav>` per region, each with its own `aria-label`.

## Markup (the consumer provides)

```html
<nav class="m3l-nav" aria-label="Docs">
  <p class="m3l-nav__group label" id="g1">Guides</p>
  <ul class="m3l-nav__list" aria-labelledby="g1">
    <li>
      <a class="m3l-nav__link body" href="/start" aria-current="page"
        >Getting started</a
      >
    </li>
  </ul>
</nav>
<nav class="m3l-nav" data-orientation="horizontal" aria-label="Site">…</nav>
```

- The current page is marked three ways: `aria-current="page"`, the accent colour, and bold weight (700, with its tracking). It never relies on colour alone.
- The container (sidebar surface, width, sticky position) belongs to the consumer. The preview uses `color-surface-subtle` with `radius-lg`.
- Type: `body` for items, `label` for group headings. No all-caps headings.

## Tokens

- Items `color-text-secondary`; hover `color-surface-hover` + `color-text-primary`; current `color-surface-selected` + `color-accent-text`.
- Group headings `color-text-primary`. Focus `color-focus-ring`.
- Shape `radius-md`, item padding `space-1 space-3`, list gap `space-0-5` (horizontal: `space-1`).
- Component-tier aliases: `nav-item-bg-hover`, `nav-item-bg-active`, `nav-item-fg-active`.

## Contrast (WCAG 2.2 AA)

| Pair                  | Tokens                                            | Light |  Dark | Floor |
| --------------------- | ------------------------------------------------- | ----: | ----: | ----: |
| item in sidebar       | `color-text-secondary` on `color-surface-subtle`  |  7.59 | 10.60 |   4.5 |
| item in header        | `color-text-secondary` on `color-surface-default` |  8.02 | 11.33 |   4.5 |
| group heading         | `color-text-primary` on `color-surface-subtle`    | 16.62 | 16.62 |   4.5 |
| item hover            | `color-text-primary` on `color-surface-hover`     | 15.66 | 13.16 |   4.5 |
| current item          | `color-accent-text` on `color-surface-selected`   |  9.53 |  5.87 |   4.5 |
| focus ring in sidebar | `color-focus-ring` on `color-surface-subtle`      |  9.84 |  8.24 |     3 |
| focus ring in header  | `color-focus-ring` on `color-surface-default`     | 10.39 |  8.81 |     3 |
