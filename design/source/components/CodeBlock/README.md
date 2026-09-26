# CodeBlock

Monospaced code in docs: a block with an optional language/filename header, plus an inline variant for short names inside prose.

## Use it for

- Commands, config and source the reader will copy. Inline (`m3l-code-inline`) for identifiers, flags and paths inside a sentence.

## Markup (the consumer provides)

```html
<figure class="m3l-code-block">
  <figcaption class="m3l-code-block__header caption">
    <span class="m3l-code-block__lang">bash</span><span>install.sh</span>
  </figcaption>
  <pre
    tabindex="0"
    aria-label="bash, install.sh"
  ><code class="code">npx @monte3l/m3l-groundwork init</code></pre>
</figure>
<p class="body">
  Set <code class="code m3l-code-inline">GROUNDWORK_DIR</code> first.
</p>
```

- `tabindex="0"` plus an `aria-label` on `<pre>` lets keyboard users scroll long lines. The focus ring goes on the figure, because the figure clips its children.
- Lines never wrap; the block scrolls horizontally.
- Mark comments with `m3l-code-comment` and highlighted tokens with `m3l-code-strong` (bold, never italic).
- Type: the `code` style (Atkinson Hyperlegible Mono, 0.9375rem, line-height 1.5, no tracking at 400). No ligatures; figures are tabular by construction.

## Tokens

- Fill `color-surface-code`, text `color-text-primary`, comments and header `color-text-secondary`, border `color-border-subtle`, focus `color-focus-ring`.
- Inline code: `color-surface-hover` fill, `color-text-primary` text, `radius-xs`.
- Shape `radius-lg`, padding `space-4`.
- Component-tier aliases: `code-block-bg`, `-fg`, `-border`.

## Syntax colour

Syntax-highlighting tokens are out of v1 scope. Use only the two treatments above. Brackets `[]` and `{}` are the mono face's weakest glyphs, so keep spacing around them.

## Contrast (WCAG 2.2 AA)

| Pair                     | Tokens                                         | Light |  Dark | Floor |
| ------------------------ | ---------------------------------------------- | ----: | ----: | ----: |
| code                     | `color-text-primary` on `color-surface-code`   | 16.62 | 16.62 |   4.5 |
| comments, header         | `color-text-secondary` on `color-surface-code` |  7.59 | 10.60 |   4.5 |
| inline code on page      | `color-text-primary` on `color-surface-hover`  | 15.66 | 13.16 |   4.5 |
| scroll-region focus ring | `color-focus-ring` on `color-surface-default`  | 10.39 |  8.81 |     3 |
