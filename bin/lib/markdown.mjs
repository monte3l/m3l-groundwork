// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A restricted, zero-dependency GFM-to-HTML renderer -- covers exactly the
 * markdown inventory `bin/build-docs.mjs`'s site pages (its own `PAGES`
 * list) actually use: ATX headings (h1-h3, GitHub-compatible slug ids),
 * pipe tables (no alignment), `bash`/untagged fenced code, ordered/
 * unordered/nested lists, blockquotes (a GitHub alert
 * `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`, or a neutral aside otherwise),
 * footnotes (assurance-case style: an indented, possibly multi-paragraph
 * body under a bare `[^label]:` line), code spans, `**bold**`/`__bold__`,
 * `*italic*`/`_italic_`, images (including a link wrapping a badge image),
 * and a thematic break. Everything outside that inventory -- an HTML
 * comment (stripped), a heading inside a blockquote or list item, an
 * unsupported heading level, an unclosed code fence, a duplicate/empty/
 * unreferenced footnote definition, an unknown footnote reference -- is a
 * loud `MarkdownError`, never a silent guess. All text is HTML-escaped;
 * a raw HTML tag outside a code span is not parsed as markup, only ever
 * escaped and printed as literal text.
 */

/** Thrown for a markdown construct this renderer cannot render correctly. */
export class MarkdownError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MarkdownError";
  }
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE_LINE_RE = /^ {0,3}>\s?(.*)$/;
const ORDERED_ITEM_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const UNORDERED_ITEM_RE = /^(\s*)[-*]\s+(.*)$/;
const FOOTNOTE_DEF_START_RE = /^\[\^([^\]]+)\]:\s*$/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

const ALERT_MAP = {
  NOTE: { status: "info", title: "Note" },
  TIP: { status: "info", title: "Tip" },
  IMPORTANT: { status: "info", title: "Important" },
  WARNING: { status: "warning", title: "Warning" },
  CAUTION: { status: "danger", title: "Caution" },
};

// Pasted verbatim from design/source/components/Callout/README.md's status
// glyphs -- currentColor strokes, so they inherit the callout's icon color.
const STATUS_ICONS = {
  info: '<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.5v.01"/></svg>',
  warning:
    '<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2Z"/><path d="M10 8v3.5M10 14.5v.01"/></svg>',
  danger:
    '<svg class="m3l-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2h6l5 5v6l-5 5H7l-5-5V7Z"/><path d="m7.5 7.5 5 5m0-5-5 5"/></svg>',
};

const HEADING_CLASS = { 1: "heading-1", 2: "heading-2", 3: "heading-3" };

export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function leadingSpaces(line) {
  const match = /^ */.exec(line);
  return match[0].length;
}

function flattenInlineToText(text) {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/\*([^*]+?)\*/g, "$1")
    .replace(/_([^_]+?)_/g, "$1");
}

/**
 * GitHub's own heading-anchor algorithm: lowercase, drop everything but
 * letters/numbers/marks/underscore/hyphen/space, then turn each space into
 * a hyphen -- deliberately without collapsing runs of hyphens, which is
 * what GitHub itself does for a heading like "plugin / marketplace"
 * (-> "plugin--marketplace").
 */
export function slugifyHeading(text) {
  return flattenInlineToText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-");
}

function scanHeadingLines(source) {
  const lines = stripHtmlComments(source).split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (match) out.push({ level: match[1].length, text: match[2].trim() });
  }
  return out;
}

/**
 * Every ATX heading (h1-h6) in document order, with a GitHub-compatible,
 * page-scoped-deduplicated slug -- computed once and shared between a
 * standalone call (site-wide anchor validation) and `renderMarkdown` itself,
 * so the two can never disagree about a page's ids.
 */
export function extractHeadings(source) {
  const seen = new Map();
  return scanHeadingLines(source).map(({ level, text }) => {
    const base = slugifyHeading(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { level, text, slug: count === 0 ? base : `${base}-${count}` };
  });
}

function extractFootnoteDefs(lines) {
  const remaining = [];
  const defs = new Map();
  let i = 0;
  while (i < lines.length) {
    const match = FOOTNOTE_DEF_START_RE.exec(lines[i]);
    if (!match) {
      remaining.push(lines[i]);
      i++;
      continue;
    }
    const label = match[1];
    if (defs.has(label)) {
      throw new MarkdownError(`duplicate footnote definition: [^${label}]`);
    }
    i++;
    const bodyLines = [];
    while (
      i < lines.length &&
      (lines[i].trim() === "" || /^ {4}/.test(lines[i]))
    ) {
      bodyLines.push(lines[i].trim() === "" ? "" : lines[i].slice(4));
      i++;
    }
    while (bodyLines.length > 0 && bodyLines.at(-1) === "") bodyLines.pop();
    const body = bodyLines.join("\n");
    if (body.trim() === "") {
      throw new MarkdownError(`empty footnote body: [^${label}]`);
    }
    defs.set(label, body);
  }
  return { lines: remaining, footnoteDefs: defs };
}

function isTableSeparator(line) {
  const trimmed = line.trim();
  return (
    /^\|?[\s:|-]+\|?$/.test(trimmed) &&
    trimmed.includes("-") &&
    trimmed.includes("|")
  );
}

function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|");
}

function isListItemLine(line) {
  return ORDERED_ITEM_RE.test(line) || UNORDERED_ITEM_RE.test(line);
}

function matchListItem(line) {
  const ordered = ORDERED_ITEM_RE.exec(line);
  if (ordered) {
    const markerLength = ordered[1].length + ordered[2].length + 2; // "N. "
    return { ordered: true, indent: ordered[1].length, markerLength };
  }
  const unordered = UNORDERED_ITEM_RE.exec(line);
  const markerLength = unordered[1].length + 2; // "- "
  return { ordered: false, indent: unordered[1].length, markerLength };
}

function dedent(line, columns) {
  let cut = 0;
  while (cut < columns && cut < line.length && line[cut] === " ") cut++;
  return line.slice(cut);
}

/** Splits a list's raw member lines (all at or below the marker indent) into per-item, dedented line arrays. */
function splitListItems(lines, indent) {
  const items = [];
  let current = null;
  let contentColumn = indent;
  for (const line of lines) {
    if (leadingSpaces(line) === indent && isListItemLine(line.slice(indent))) {
      if (current) items.push(current);
      const { markerLength } = matchListItem(line.slice(indent));
      contentColumn = indent + markerLength;
      // The marker itself ("- ", "12. ") is never all spaces, so `dedent`
      // (which only strips space characters) would leave it untouched --
      // slice it off unconditionally instead, since `contentColumn` chars
      // are guaranteed present (indent + the marker just matched above).
      current = [line.slice(contentColumn)];
    } else if (current) {
      current.push(line.trim() === "" ? "" : dedent(line, contentColumn));
    }
  }
  if (current) items.push(current);
  return items;
}

/**
 * True while `lines[i]` still belongs to a list block whose items start at
 * `indent`. A line indented *more* than `indent` is unconditionally a
 * continuation (a wrapped line, or nested content); a line at *exactly*
 * `indent` continues the list only if it is itself another list-item
 * marker (a sibling item) -- anything else at that indent (a plain
 * paragraph, a heading) ends the list. An earlier version of this function
 * treated `leadingSpaces(line) >= indent` alone as "continues", which for a
 * top-level list (`indent === 0`) is true for every line in the rest of the
 * document -- silently swallowing every following paragraph and heading
 * into the list's last item. A blank line only continues the list if the
 * next non-blank line would.
 */
function listContinues(lines, i, indent) {
  const line = lines[i];
  if (line.trim() === "") {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      return listContinues(lines, j, indent);
    }
    return false;
  }
  const spaces = leadingSpaces(line);
  if (spaces > indent) return true;
  if (spaces === indent) return isListItemLine(line.slice(indent));
  return false;
}

/**
 * Parses a flat line array (already footnote-def-free) into an array of
 * block nodes. `nested` is true when parsing a blockquote's or a list
 * item's own inner content: `extractHeadings`/`scanHeadingLines` (the
 * heading queue every heading block is checked against, see `renderBlock`)
 * never look inside a blockquote or a list item, so a heading found there
 * would desync that queue -- rejected loudly instead, since it's outside
 * this renderer's supported inventory rather than silently mis-slugged.
 */
function parseBlocks(lines, nested = false) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[2] ?? "";
      i++;
      const codeLines = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        throw new MarkdownError(`unterminated code fence: ${line.trim()}`);
      }
      i++; // consume the closing fence
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (nested) {
        throw new MarkdownError(
          `heading not supported inside a blockquote or list item: ${line}`,
        );
      }
      const level = heading[1].length;
      if (level > 3) {
        throw new MarkdownError(
          `unsupported heading level h${level} (only h1-h3 are supported): ${line}`,
        );
      }
      blocks.push({ type: "heading", level, text: heading[2].trim() });
      i++;
      continue;
    }

    if (BLOCKQUOTE_LINE_RE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        if (BLOCKQUOTE_LINE_RE.test(lines[i])) {
          inner.push(BLOCKQUOTE_LINE_RE.exec(lines[i])[1]);
          i++;
          continue;
        }
        if (
          lines[i].trim() === "" &&
          i + 1 < lines.length &&
          BLOCKQUOTE_LINE_RE.test(lines[i + 1])
        ) {
          inner.push("");
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "blockquote", lines: inner });
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        lines[i].includes("|")
      ) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    if (isListItemLine(line)) {
      const indent = leadingSpaces(line);
      const { ordered } = matchListItem(line.slice(indent));
      const itemLines = [];
      while (i < lines.length && listContinues(lines, i, indent)) {
        itemLines.push(lines[i]);
        i++;
      }
      const items = splitListItems(itemLines, indent).map((raw) => ({
        blocks: parseBlocks(raw, true),
      }));
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !BLOCKQUOTE_LINE_RE.test(lines[i]) &&
      !isListItemLine(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }
  return blocks;
}

// Order matters, and it is a single flat alternation (not a two-pass split)
// on purpose: a code span is tried first so its backtick-delimited content
// is captured whole, but a link's own text group ([^\]]+) still happily
// spans a code span inside it (`[`CLAUDE.md`](CLAUDE.md)`) -- an earlier
// version of this file matched code spans in a *separate* pre-pass before
// ever tokenizing links, which silently broke every such link by handing
// the "[" and "](url)" halves to the tokenizer as two disconnected plain-
// text fragments with the code span spliced out between them. A link
// wrapping a badge image is tried before a plain image (so
// `[![alt](src)](href)` isn't mis-parsed as a plain link whose text happens
// to start with "!["), before a plain link, before a footnote ref, before
// bold, before italic -- `**`/`__` must be tried before the single-char
// forms so `**x**` is never read as two adjacent italics. The underscore
// forms (`__bold__`, `_italic_`) additionally require a non-word character
// (or start/end of string) on both outer sides -- GFM's own intraword rule
// for underscore emphasis -- so `snake_case_name` is never misread as
// `snake<em>case</em>name`; `*`/`**` carry no such restriction, matching
// GFM there too.
const INLINE_TOKEN_RE =
  /`([^`]+)`|\[(!\[[^\]]*\]\([^)]+\))\]\(([^)]+)\)|!\[([^\]]*)\]\(([^)]+)\)|\[\^([^\]]+)\]|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+?)\*\*|(?<![\w_])__([^_]+?)__(?![\w_])|\*([^*]+?)\*|(?<![\w_])_([^_]+?)_(?![\w_])/g;

function renderFootnoteRef(label, ctx) {
  if (!ctx.footnoteDefs.has(label)) {
    throw new MarkdownError(`unknown footnote reference: [^${label}]`);
  }
  if (!ctx.footnoteOrder.has(label)) {
    ctx.footnoteOrder.set(label, ctx.footnoteOrder.size + 1);
  }
  const n = ctx.footnoteOrder.get(label);
  const id = escapeHtml(label);
  return `<sup id="fnref-${id}"><a href="#fn-${id}">${n}</a></sup>`;
}

/**
 * The single inline tokenizer: renders code spans, links, images, footnote
 * refs, bold and italic within `text`. `String.prototype.matchAll` clones
 * the regex it's given (per the spec), so recursing back into `renderInline`
 * for a link's text or bold/italic's inner content never fights over a
 * single shared `lastIndex` the way a manual `while (re.exec(text))` loop
 * over a module-level global regex would -- that shared-state bug is
 * exactly what made an early version of this function loop forever on its
 * own output until the string overflowed.
 */
function renderInline(text, ctx) {
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      result += `<code class="code m3l-code-inline">${escapeHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      result += `<a class="m3l-link" href="${escapeHtml(ctx.resolveLink(match[3]))}">${renderInline(match[2], ctx)}</a>`;
    } else if (match[4] !== undefined) {
      result += `<img src="${escapeHtml(ctx.resolveLink(match[5]))}" alt="${escapeHtml(match[4])}">`;
    } else if (match[6] !== undefined) {
      result += renderFootnoteRef(match[6], ctx);
    } else if (match[7] !== undefined) {
      result += `<a class="m3l-link" href="${escapeHtml(ctx.resolveLink(match[8]))}">${renderInline(match[7], ctx)}</a>`;
    } else if (match[9] !== undefined) {
      result += `<strong>${renderInline(match[9], ctx)}</strong>`;
    } else if (match[10] !== undefined) {
      result += `<strong>${renderInline(match[10], ctx)}</strong>`;
    } else if (match[11] !== undefined) {
      ctx.italics.push(match[0]);
      result += `<em>${renderInline(match[11], ctx)}</em>`;
    } else if (match[12] !== undefined) {
      ctx.italics.push(match[0]);
      result += `<em>${renderInline(match[12], ctx)}</em>`;
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function renderCodeBlock(lang, text) {
  const label = lang || "text";
  return [
    `<figure class="m3l-code-block">`,
    `<figcaption class="m3l-code-block__header caption"><span class="m3l-code-block__lang">${escapeHtml(label)}</span></figcaption>`,
    `<pre tabindex="0" aria-label="${escapeHtml(label)}"><code class="code">${escapeHtml(text)}</code></pre>`,
    `</figure>`,
  ].join("");
}

function renderBlockquote(lines, ctx) {
  const first = (lines[0] ?? "").trim();
  const alertMatch = ALERT_RE.exec(first);
  const bodyLines = alertMatch ? lines.slice(1) : lines;
  const innerHtml = renderBlocks(parseBlocks(bodyLines, true), ctx);
  if (!alertMatch) {
    return [
      `<aside class="m3l-callout" role="note" aria-label="Note">`,
      `<div class="m3l-callout__content">`,
      innerHtml,
      `</div>`,
      `</aside>`,
    ].join("");
  }
  const { status, title } = ALERT_MAP[alertMatch[1].toUpperCase()];
  return [
    `<aside class="m3l-callout" data-status="${status}" role="note" aria-label="${title}">`,
    STATUS_ICONS[status],
    `<div class="m3l-callout__content">`,
    `<p class="m3l-callout__title label">${title}</p>`,
    innerHtml,
    `</div>`,
    `</aside>`,
  ].join("");
}

function renderTable(header, rows, ctx) {
  const thead = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell.trim(), ctx)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell.trim(), ctx)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function renderListItem(item, ctx) {
  if (item.blocks.length === 1 && item.blocks[0].type === "paragraph") {
    return `<li>${renderInline(item.blocks[0].text, ctx)}</li>`;
  }
  return `<li>${renderBlocks(item.blocks, ctx)}</li>`;
}

function renderList(block, ctx) {
  const tag = block.ordered ? "ol" : "ul";
  return `<${tag}>${block.items.map((item) => renderListItem(item, ctx)).join("")}</${tag}>`;
}

function renderBlock(block, ctx) {
  switch (block.type) {
    case "heading": {
      const heading = ctx.headingQueue.shift();
      if (
        !heading ||
        heading.text !== block.text ||
        heading.level !== block.level
      ) {
        throw new MarkdownError(
          `heading queue desynced at: ${block.text} (expected ${heading ? `"${heading.text}"` : "end of queue"})`,
        );
      }
      return `<h${block.level} id="${heading.slug}" class="${HEADING_CLASS[block.level]}">${renderInline(block.text, ctx)}</h${block.level}>`;
    }
    case "code":
      return renderCodeBlock(block.lang, block.text);
    case "hr":
      return "<hr>";
    case "blockquote":
      return renderBlockquote(block.lines, ctx);
    case "table":
      return renderTable(block.header, block.rows, ctx);
    case "list":
      return renderList(block, ctx);
    case "paragraph":
      return `<p class="body">${renderInline(block.text, ctx)}</p>`;
    /* c8 ignore next 2 -- parseBlocks never emits any other block type */
    default:
      throw new MarkdownError(`unreachable block type: ${block.type}`);
  }
}

function renderBlocks(blocks, ctx) {
  return blocks.map((block) => renderBlock(block, ctx)).join("");
}

function renderFootnoteBody(bodyMarkdown, ctx) {
  const paragraphs = bodyMarkdown
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "");
  return paragraphs
    .map(
      (p) =>
        `<p class="body">${renderInline(p.replace(/\n/g, " ").trim(), ctx)}</p>`,
    )
    .join("");
}

/**
 * Renders every referenced footnote's body. A footnote body can itself
 * reference another footnote (`renderFootnoteRef` adds to `ctx.footnoteOrder`
 * as a side effect of rendering), so this renders in passes until no new
 * label appears, rather than snapshotting `ctx.footnoteOrder` once up
 * front and silently missing a label discovered only while rendering a
 * later pass's body -- that snapshot-too-early bug produced a `<sup>`
 * reference with no matching `<li>` for it to link to.
 */
function renderFootnotesSection(ctx) {
  const bodies = new Map();
  let rendered = new Set();
  for (;;) {
    const pending = [...ctx.footnoteOrder.keys()].filter(
      (label) => !rendered.has(label),
    );
    if (pending.length === 0) break;
    for (const label of pending) {
      bodies.set(label, renderFootnoteBody(ctx.footnoteDefs.get(label), ctx));
    }
    rendered = new Set([...rendered, ...pending]);
  }
  const entries = [...ctx.footnoteOrder.entries()].sort((a, b) => a[1] - b[1]);
  const items = entries
    .map(([label, n]) => {
      const id = escapeHtml(label);
      return `<li id="fn-${id}" value="${n}">${bodies.get(label)} <a class="m3l-link" href="#fnref-${id}">↩</a></li>`;
    })
    .join("");
  return `<section class="m3l-footnotes"><hr><ol>${items}</ol></section>`;
}

/**
 * Renders one markdown document to HTML. `resolveLink(href)` is called for
 * every link/image target found (a same-page `#anchor` is passed through
 * unchanged by every caller in this repo); it defaults to the identity
 * function, which is enough for a standalone render but never enough for a
 * real multi-page site -- see `bin/build-docs.mjs`'s own resolver.
 */
export function renderMarkdown(source, options = {}) {
  const resolveLink = options.resolveLink ?? ((href) => href);
  const stripped = stripHtmlComments(source);
  const { lines, footnoteDefs } = extractFootnoteDefs(stripped.split("\n"));
  const headings = extractHeadings(source);
  const ctx = {
    resolveLink,
    footnoteDefs,
    footnoteOrder: new Map(),
    headingQueue: [...headings],
    italics: [],
  };
  const blocks = parseBlocks(lines);
  const bodyHtml = renderBlocks(blocks, ctx);
  const footnotesHtml =
    ctx.footnoteOrder.size > 0 ? renderFootnotesSection(ctx) : "";
  if (ctx.headingQueue.length > 0) {
    throw new MarkdownError(
      `heading queue desynced: ${ctx.headingQueue.length} heading(s) never rendered`,
    );
  }
  const unreferenced = [...footnoteDefs.keys()].filter(
    (label) => !ctx.footnoteOrder.has(label),
  );
  if (unreferenced.length > 0) {
    throw new MarkdownError(
      `unreferenced footnote definition(s): ${unreferenced.map((label) => `[^${label}]`).join(", ")}`,
    );
  }
  return { html: bodyHtml + footnotesHtml, headings, italics: ctx.italics };
}
