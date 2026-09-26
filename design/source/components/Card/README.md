# Card

A raised container for one self-contained item: a feature, a guide, a project. It can be static, or the whole card can be one link.

## Use it for

- Grids of peers (docs landing, project lists). A card holds one title, a short body and optional meta. Don't nest cards.

## Markup (the consumer provides)

```html
<article class="m3l-card m3l-card--link">
  <h3 class="m3l-card__title heading-4">
    <a href="/docs/start">Getting started</a>
  </h3>
  <p class="m3l-card__body body">Bootstrap a repo in one command.</p>
  <p class="m3l-card__meta caption">5 min read</p>
</article>
```

- Link card: the title link stretches over the whole card, so there is one tab stop and one accessible name. The focus ring is drawn around the card. The title underlines on hover.
- Choose a heading level that fits the page outline. `heading-4` is only the visual style.

## Tokens

- `color-surface-raised` fill, `color-border-subtle` border, title `color-text-primary`, body `color-text-secondary`, meta `color-text-tertiary`.
- Elevation `shadow-1`, hover `shadow-2` + `color-border-default` (link cards only; the transition is shadow/colour, `duration-fast`).
- Shape `radius-lg`, padding `space-6`, internal gap `space-2`.
- Component-tier aliases: `card-bg`, `card-border`.

## Contrast (WCAG 2.2 AA)

| Pair                                | Tokens                                           | Light |  Dark | Floor |
| ----------------------------------- | ------------------------------------------------ | ----: | ----: | ----: |
| title                               | `color-text-primary` on `color-surface-raised`   | 17.55 | 15.06 |   4.5 |
| body                                | `color-text-secondary` on `color-surface-raised` |  8.02 |  9.60 |   4.5 |
| meta                                | `color-text-tertiary` on `color-surface-raised`  |  5.44 |  6.53 |   4.5 |
| focus ring (drawn outside the card) | `color-focus-ring` on `color-surface-default`    | 10.39 |  8.81 |     3 |
| focus ring on subtle band           | `color-focus-ring` on `color-surface-subtle`     |  9.84 |  8.24 |     3 |
