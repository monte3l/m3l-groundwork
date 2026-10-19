// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pure presentation primitives shared by both status-line entry points
 * (`statusline.mjs`, `subagent-statusline.mjs`): terminal-width fitting, ANSI
 * colors, and the two small formatters both scripts need. No shebang, no
 * direct-run block -- this module is only ever imported, and neither entry
 * point imports the other. The color constants below are the one exception
 * to "no I/O": they're read from `bin/lib/term.mjs`'s `PALETTE`, which
 * resolves `design/source/dtcg/` once at import time -- see that module's
 * own header.
 *
 * Anthropic's own statusLine docs (code.claude.com/docs/en/statusline) state
 * that a statusLine script must read the `COLUMNS`/`LINES` env vars to learn
 * the terminal width; `tput cols` does not work inside a statusLine
 * subprocess. `terminalColumns` is the read side of that contract;
 * `displayWidth`/`truncateToWidth`/`fitRow` are what make a real width
 * budget actionable -- segment-level priority dropping plus
 * ANSI/OSC-8-aware truncation, so a narrow terminal degrades by omitting the
 * least important segments first rather than wrapping mid-line.
 */
import process from "node:process";
import {
  PALETTE,
  paintUnavailable,
  resolveThemeId,
  truecolorSgr,
} from "../../bin/lib/term.mjs";

/**
 * SGR (`\x1b[...m`) and OSC-8 (`\x1b]8;;URL\x07...\x1b]8;;\x07`) sequences.
 *
 * Carries the `/g` flag, so `.lastIndex` is stateful across calls to
 * `.test()`/`.exec()` on this exact object — every internal use in this file
 * either goes through `.replace()` (which resets `lastIndex` itself) or
 * explicitly resets `lastIndex` before use (see `tokenize` below). A caller
 * that runs `.test()`/`.exec()` on this constant directly, more than once,
 * must reset `.lastIndex = 0` between calls or clone the pattern first.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC (\x1b) and BEL (\x07) control characters that delimit ANSI/OSC-8 sequences
export const ESCAPE_SEQUENCE_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

const COMBINING_RANGES = [
  [0x03_00, 0x03_6f],
  [0x1a_b0, 0x1a_ff],
  [0x1d_c0, 0x1d_ff],
  [0x20_d0, 0x20_ff],
  [0xfe_20, 0xfe_2f],
];

const PUA_RANGES = [
  [0xe0_00, 0xf8_ff],
  [0xf_00_00, 0xf_ff_fd],
  [0x10_00_00, 0x10_ff_fd],
];

const WIDE_RANGES = [
  [0x11_00, 0x11_5f],
  [0x2e_80, 0x30_3e],
  [0x30_41, 0x33_ff],
  [0x34_00, 0x4d_bf],
  [0x4e_00, 0x9f_ff],
  [0xa0_00, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x2_00_00, 0x3_ff_fd],
];

/**
 * Codepoints a terminal draws two cells wide because the font renders them as
 * an emoji, not a text glyph. Asked of the engine's own Unicode tables rather
 * than a hand-kept range: the old blanket `U+2600-27BF` / `U+1F300-1FAFF` ranges
 * were wrong in both directions (`⚠ U+26A0`, `✓ U+2713` and `➜ U+279C` are one
 * cell, only the `Emoji_Presentation` subset of those blocks is two), and a
 * table would go stale as Unicode adds emoji. A property escape is built into
 * V8, so it costs no dependency. It does not cover East Asian Wide text, which
 * is why `WIDE_RANGES` stays.
 */
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;

/** Codepoints that *can* be drawn as an emoji when followed by U+FE0F. */
const EMOJI_CAPABLE_RE = /^\p{Emoji}$/u;

const ZERO_WIDTH_JOINER = 0x20_0d;
const VARIATION_SELECTOR_16 = 0xfe_0f;

/**
 * @param {number} code a Unicode codepoint.
 * @param {ReadonlyArray<readonly [number, number]>} ranges inclusive
 *   `[start, end]` pairs.
 * @returns {boolean} whether `code` falls in any of `ranges`.
 */
function inRanges(code, ranges) {
  return ranges.some(([start, end]) => code >= start && code <= end);
}

/**
 * The display width of a single codepoint on its own, per this module's East
 * Asian/emoji/Nerd-Font/combining-mark rules. Sequence-dependent codepoints
 * (a ZWJ, or a VS16 that widens the glyph before it) are resolved by
 * {@link clusters}, not here.
 *
 * @param {string} cp a single codepoint (as produced by iterating a string
 *   with `[...str]`).
 * @returns {0 | 1 | 2}
 */
function codepointWidth(cp) {
  const code = cp.codePointAt(0) ?? 0;
  if (
    code === VARIATION_SELECTOR_16 ||
    code === ZERO_WIDTH_JOINER ||
    inRanges(code, COMBINING_RANGES)
  ) {
    return 0;
  }
  if (inRanges(code, PUA_RANGES)) return 1;
  if (EMOJI_PRESENTATION_RE.test(cp) || inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Splits escape-free text into terminal cells' worth of glyphs: one entry per
 * visible glyph, with anything that only modifies the glyph before it folded
 * into that entry. Folding matters twice over -- the width is right (a
 * `👨‍💻` ZWJ sequence is two cells, not the four its three codepoints sum
 * to; `⚠️` is two because U+FE0F asks for emoji presentation), and
 * {@link truncateToWidth} can never cut a sequence in half.
 *
 * Not handled: a regional-indicator flag pair (`🇮🇹`) is two cells but
 * measures four, and the width of an emoji sequence is taken from its first
 * codepoint. Both only ever over-count, so a row drops a segment early rather
 * than wrapping.
 *
 * @param {string} text text containing no ANSI/OSC-8 sequences.
 * @returns {Array<{ raw: string, width: 0 | 1 | 2 }>}
 */
function clusters(text) {
  /** @type {Array<{ raw: string, width: 0 | 1 | 2 }>} */
  const out = [];
  let afterJoiner = false;
  for (const cp of text) {
    const code = cp.codePointAt(0) ?? 0;
    const previous = out.at(-1);

    if (previous !== undefined && (afterJoiner || codepointWidth(cp) === 0)) {
      previous.raw += cp;
      if (
        code === VARIATION_SELECTOR_16 &&
        previous.width === 1 &&
        EMOJI_CAPABLE_RE.test([...previous.raw][0] ?? "")
      ) {
        previous.width = 2;
      }
      afterJoiner = code === ZERO_WIDTH_JOINER;
      continue;
    }

    out.push({ raw: cp, width: codepointWidth(cp) });
    afterJoiner = code === ZERO_WIDTH_JOINER;
  }
  return out;
}

/**
 * The terminal-column width of `str` once ANSI/OSC-8 escape sequences are
 * stripped, accounting for zero-width combining marks and joiners, emoji
 * sequences, Nerd Font/PUA single-width glyphs, and East Asian Wide/emoji
 * double-width codepoints.
 *
 * @param {string} str
 * @returns {number}
 */
export function displayWidth(str) {
  const stripped = str.replace(ESCAPE_SEQUENCE_RE, "");
  let width = 0;
  for (const cluster of clusters(stripped)) width += cluster.width;
  return width;
}

/**
 * @typedef {{ type: "esc", raw: string }} EscToken
 * @typedef {{ type: "char", raw: string, width: 0 | 1 | 2 }} CharToken
 */

/**
 * Tokenizes `str` into an ordered list of escape-sequence and visible-glyph
 * tokens, preserving original order.
 *
 * @param {string} str
 * @returns {Array<EscToken | CharToken>}
 */
function tokenize(str) {
  /** @type {Array<EscToken | CharToken>} */
  const tokens = [];
  let cursor = 0;
  ESCAPE_SEQUENCE_RE.lastIndex = 0;
  let match = ESCAPE_SEQUENCE_RE.exec(str);
  while (match !== null) {
    if (match.index > cursor) {
      for (const { raw, width } of clusters(str.slice(cursor, match.index))) {
        tokens.push({ type: "char", raw, width });
      }
    }
    tokens.push({ type: "esc", raw: match[0] });
    cursor = match.index + match[0].length;
    match = ESCAPE_SEQUENCE_RE.exec(str);
  }
  if (cursor < str.length) {
    for (const { raw, width } of clusters(str.slice(cursor))) {
      tokens.push({ type: "char", raw, width });
    }
  }
  return tokens;
}

/**
 * Whether `raw` is an SGR sequence that opens a color/style (anything other
 * than the exact reset `\x1b[0m`).
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isColorOpen(raw) {
  return raw.startsWith("\x1b[") && raw !== "\x1b[0m";
}

/**
 * Truncates `str` to fit within `maxWidth` display columns, preserving ANSI
 * color/OSC-8 sequences and never cutting mid-codepoint or mid-escape. If a
 * color was left open by the truncation point, appends a reset so the
 * cut-off segment can't bleed color into whatever follows it.
 *
 * @param {string} str
 * @param {number} maxWidth
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncateToWidth(str, maxWidth, ellipsis = "…") {
  if (maxWidth <= 0) return "";
  if (displayWidth(str) <= maxWidth) return str;

  const tokens = tokenize(str);
  const ellipsisWidth = displayWidth(ellipsis);
  const limit = maxWidth - ellipsisWidth;

  let accumulated = 0;
  let colorOpen = false;
  const kept = [];
  for (const token of tokens) {
    if (token.type === "esc") {
      kept.push(token.raw);
      colorOpen =
        token.raw === "\x1b[0m" ? false : colorOpen || isColorOpen(token.raw);
      continue;
    }
    if (accumulated + token.width > limit) break;
    accumulated += token.width;
    kept.push(token.raw);
  }

  return kept.join("") + ellipsis + (colorOpen ? "\x1b[0m" : "");
}

/**
 * @typedef {{ id: string, priority: number, text: string, minWidth: number }} RowSegment
 */

/**
 * @param {ReadonlyArray<RowSegment>} segments original-order segment list.
 * @param {Set<string>} kept ids currently retained.
 * @param {string} separator
 * @returns {number}
 */
function currentWidth(segments, kept, separator) {
  const texts = segments.filter((s) => kept.has(s.id)).map((s) => s.text);
  return displayWidth(texts.join(separator));
}

/**
 * Fits `segments` into `budget` display columns, dropping the
 * lowest-priority segment (right-side ties dropped first) until the joined
 * width fits, then truncating a sole surviving over-budget segment as a last
 * resort. Segments are always joined and returned in their original array
 * order, never priority order. Pure: never mutates the input `segments`.
 *
 * The sole-survivor truncation floors at `Math.max(segment.minWidth, budget)`
 * — a segment is never cut below its own `minWidth`, even when `budget` is
 * smaller. This is a deliberate floor, not a bug: at a pathologically narrow
 * `COLUMNS` (below a segment's `minWidth`, e.g. under ~14 once the fixed
 * 10-column gutter is subtracted) the returned row can still exceed `budget`
 * by a few columns. An unreadably-truncated segment is worse than a row a
 * few columns over budget at a terminal width no real usage reaches.
 *
 * @param {ReadonlyArray<RowSegment>} segments
 * @param {number} budget
 * @param {string} separator
 * @returns {string}
 */
export function fitRow(segments, budget, separator) {
  const kept = new Set(segments.map((s) => s.id));

  while (kept.size > 1 && currentWidth(segments, kept, separator) > budget) {
    let dropId = null;
    let dropPriority = Number.POSITIVE_INFINITY;
    for (const s of segments) {
      if (!kept.has(s.id)) continue;
      if (s.priority <= dropPriority) {
        dropPriority = s.priority;
        dropId = s.id;
      }
    }
    if (dropId === null) break;
    kept.delete(dropId);
  }

  const survivors = segments.filter((s) => kept.has(s.id));

  if (survivors.length === 1 && displayWidth(survivors[0].text) > budget) {
    const [sole] = survivors;
    return truncateToWidth(sole.text, Math.max(sole.minWidth, budget));
  }

  return survivors.map((s) => s.text).join(separator);
}

/**
 * Reads the terminal width a statusLine command was launched with. Per
 * Anthropic's statusLine docs, `COLUMNS`/`LINES` are the only reliable
 * source inside a statusLine subprocess — `tput cols` does not work there.
 *
 * @param {{ COLUMNS?: unknown } | undefined} env
 * @returns {number} the parsed column count, or `80` when absent/invalid.
 */
export function terminalColumns(env) {
  const n = Number.parseInt(String(env?.COLUMNS ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 80;
}

// This project's own `.claude/hooks/` -- unlike `templates/packs/statusline`,
// which stays brand-neutral for whatever project installs the pack -- paints
// with m3l-design's palette instead of the basic ANSI 16 (see CLAUDE.md's
// "Design system" note). The statusLine subprocess always runs piped (there
// is no TTY to check the way `bin/lib/term.mjs`'s own `paint()` does for a
// real terminal command), so `NO_COLOR` is the only toggle honored here.
const STATUSLINE_NO_COLOR = process.env.NO_COLOR !== undefined;
const STATUSLINE_THEME = PALETTE[resolveThemeId(process.env)];

/**
 * One role's truecolor SGR foreground escape, or `""` under `NO_COLOR` --
 * or when `paintUnavailable()` (the real palette failed to load, so `hex`
 * is only `bin/lib/term.mjs`'s neutral placeholder, not a real color; the
 * statusline's own contract is to always print something rather than
 * crash, so it renders these segments uncolored instead of a meaningless
 * grey -- see `statusline.mjs`'s header).
 */
function statuslineColor(hex) {
  return STATUSLINE_NO_COLOR || paintUnavailable() ? "" : truecolorSgr(hex);
}

export const GREEN = statuslineColor(STATUSLINE_THEME.success);
export const YELLOW = statuslineColor(STATUSLINE_THEME.warning);
export const RED = statuslineColor(STATUSLINE_THEME.danger);
// CYAN/BLUE/MAGENTA label decorative segments (model/vim-mode, branch/
// worktree, effort/thinking) rather than status. m3l-design has exactly one
// brand accent, not three separate decorative hues, so each borrows a
// distinct step of that same accent family (default/hover/active) to stay
// visually distinguishable while never inventing an off-palette color.
export const CYAN = statuslineColor(STATUSLINE_THEME.accent);
export const BLUE = statuslineColor(STATUSLINE_THEME.accentHover);
export const MAGENTA = statuslineColor(STATUSLINE_THEME.accentActive);
export const DIM = STATUSLINE_NO_COLOR ? "" : "\x1b[2m";
export const RESET = STATUSLINE_NO_COLOR ? "" : "\x1b[0m";
export const SEGMENT_SEPARATOR = `${DIM} · ${RESET}`;
export const PLACEHOLDER = `${DIM}—${RESET}`;
export const GUTTER_WIDTH = 10;

/**
 * Compact token-count formatter (`45000` -> `"45k"`, `15500` -> `"15.5k"`).
 *
 * @param {number} n always finite when called.
 * @returns {string}
 */
export function formatTokenCount(n) {
  if (Math.abs(n) < 1000) return String(Math.round(n));
  const kk = n / 1000;
  const rounded = Math.round(kk * 10) / 10;
  return Number.isInteger(rounded)
    ? `${rounded.toFixed(0)}k`
    : `${rounded.toFixed(1)}k`;
}

/**
 * @param {number} deltaSec seconds remaining, may be negative/zero.
 * @returns {string} `"now"`, `"NNm"`, or `"NhMMm"`.
 */
export function formatDuration(deltaSec) {
  if (deltaSec <= 0) return "now";
  const h = Math.floor(deltaSec / 3600);
  const m = Math.floor((deltaSec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}
