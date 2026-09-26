// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Root twin of `packages/cli/src/term.ts` -- see that file's own header for
 * the shared contract (`supportsColor`, `paint`, the NO_COLOR/FORCE_COLOR/
 * COLORTERM/COLORFGBG rules). This copy resolves its own palette directly
 * from `design/source/dtcg/` (via `design-tokens.mjs`'s resolver) rather
 * than importing a generated `palette.ts`, since root tooling has no build
 * step of its own to emit one into. Root callers (`report.mjs`, `verify.mjs`,
 * `lint-commit.mjs`, `eval.mjs`, the statusline hook) import this module; the
 * one-time DTCG read happens via a module-level top-level `await`, so by the
 * time any of those callers' own top-level code runs, `PALETTE` is already
 * populated -- see loadDesignSystem's own doc comment for why that read is
 * async in the first place (it's a `readFile`, not a `readFileSync`).
 *
 * Not compared against `term.ts` by any parity test, unlike the harness/
 * toolchain grader twins -- see CLAUDE.md's "Design system" note. A drift
 * here is a cosmetic difference in two separate terminals' output, not a
 * behavioral contract two code paths must agree on.
 *
 * Loading the palette can fail (a corrupted `design/source/dtcg/` re-sync,
 * or this file copied somewhere without its `design/` tree) -- and this
 * module is imported, directly or transitively, by every root gate
 * (`report.mjs` alone reaches every `bin/check-*.mjs` script) plus the
 * statusline hook, which promises to always print SOMETHING rather than go
 * blank (see `statusline.mjs`'s own header). A load failure here must
 * therefore never throw at import time: `PALETTE` always resolves to a
 * valid (real or neutral) value, and `paintUnavailable()` lets a caller
 * that needs to know (the statusline hook) detect the degraded case and
 * skip coloring rather than trust a placeholder color to mean anything.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadDesignSystem,
  resolveTheme,
  requireLeafValue,
  formatColor,
} from "./design-tokens.mjs";

const DTCG_DIR = fileURLToPath(
  new URL("../../design/source/dtcg", import.meta.url),
);

// The CLI's six `PaletteRoleColors` roles, plus two root-only accent shades
// (`accentHover`/`accentActive`) the statusline hook uses to keep its three
// decorative (non-status) segment colors distinguishable while staying
// on-brand -- see statusline-layout.mjs's own header comment.
const PALETTE_ROLES = [
  ["success", "color.status.success.text"],
  ["info", "color.status.info.text"],
  ["warning", "color.status.warning.text"],
  ["danger", "color.status.danger.text"],
  ["accent", "color.accent.text"],
  ["secondary", "color.text.secondary"],
  ["accentHover", "color.accent.hover"],
  ["accentActive", "color.accent.active"],
];

function buildRoleColors(tree) {
  const out = {};
  for (const [role, dottedPath] of PALETTE_ROLES) {
    out[role] = formatColor(requireLeafValue(tree, dottedPath));
  }
  return out;
}

async function buildPalette() {
  const system = await loadDesignSystem(DTCG_DIR);
  return {
    light: buildRoleColors(resolveTheme(system, "light", "default")),
    dark: buildRoleColors(resolveTheme(system, "dark", "default")),
  };
}

// A neutral, always-hex-shaped placeholder -- used only when `design/source/dtcg`
// can't be read or resolved. `paint()` never actually formats these colors
// (it checks `paintUnavailable()` first and returns identity text instead),
// but the statusline hook reads `PALETTE` directly, so every role must still
// be a value `truecolorSgr`/`nearest16Sgr` won't throw on.
function neutralPalette() {
  const placeholder = Object.fromEntries(
    PALETTE_ROLES.map(([role]) => [role, "#808080"]),
  );
  return { light: placeholder, dark: placeholder };
}

let paletteLoadError = null;

/** `{ light: {...8 roles}, dark: {...8 roles} }`, hex/rgba CSS color strings -- a neutral placeholder if the real load failed, see `paintUnavailable()`. */
export const PALETTE = await buildPalette().catch((error) => {
  paletteLoadError = error;
  return neutralPalette();
});

/** True once loading the real palette from `design/source/dtcg/` has failed -- `PALETTE` is a neutral placeholder in that case, not a real color. */
export function paintUnavailable() {
  return paletteLoadError !== null;
}

/**
 * True when `env` (NO_COLOR present, at any value -- see no-color.org)
 * requests color be suppressed; false when `FORCE_COLOR` is set to anything
 * other than `"0"` (which explicitly forces color OFF, the same as
 * NO_COLOR); otherwise whether `stream` is a TTY. NO_COLOR wins over
 * FORCE_COLOR when both are set, matching the precedence every other
 * NO_COLOR-aware tool uses.
 */
function supportsColor(stream, env) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return stream?.isTTY === true;
}

/** True when `env.COLORTERM` names a 24-bit-capable terminal. */
function isTruecolor(env) {
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
}

/**
 * Picks light vs. dark from `env.COLORFGBG` (`"fg;bg"`, the convention xterm
 * and its descendants set) when present; defaults to dark otherwise -- a
 * dark terminal background is the common case this project's own
 * contributors use, and a `COLORFGBG` with no `;` separator at all doesn't
 * fit the "fg;bg" shape, so it's treated the same as absent.
 */
export function resolveThemeId(env) {
  const colorfgbg = env.COLORFGBG;
  if (typeof colorfgbg !== "string" || !colorfgbg.includes(";")) {
    return "dark";
  }
  const bg = colorfgbg.slice(colorfgbg.lastIndexOf(";") + 1);
  return bg === "15" || bg === "7" ? "light" : "dark";
}

/** `#rrggbb` -> `[r, g, b]`. Throws on anything else -- every hex this module paints with comes from `formatColor`, which never emits a 3-digit or alpha-suffixed form. */
function parseHex(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new Error(
      `term.mjs: not a 6-digit hex color: ${JSON.stringify(hex)}`,
    );
  }
  const [, r, g, b] = match;
  return [r, g, b].map((component) => Number.parseInt(component, 16));
}

/** `#rrggbb` -> a 24-bit-color SGR foreground escape (`\x1b[38;2;r;g;bm`). */
export function truecolorSgr(hex) {
  const [r, g, b] = parseHex(hex);
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}

// The 16 standard ANSI foreground colors (xterm's own default RGB values for
// each), used to pick the nearest one when the terminal hasn't announced
// truecolor support. SGR 30-37 for the base eight, 90-97 for their bright
// counterparts.
const ANSI_16 = [
  [30, [0, 0, 0]],
  [31, [205, 0, 0]],
  [32, [0, 205, 0]],
  [33, [205, 205, 0]],
  [34, [0, 0, 238]],
  [35, [205, 0, 205]],
  [36, [0, 205, 205]],
  [37, [229, 229, 229]],
  [90, [127, 127, 127]],
  [91, [255, 0, 0]],
  [92, [0, 255, 0]],
  [93, [255, 255, 0]],
  [94, [92, 92, 255]],
  [95, [255, 0, 255]],
  [96, [0, 255, 255]],
  [97, [255, 255, 255]],
];

/** `#rrggbb` -> the nearest of the 16 standard ANSI colors' SGR foreground escape, by squared Euclidean RGB distance. */
function nearest16Sgr(hex) {
  const target = parseHex(hex);
  let bestCode = ANSI_16[0][0];
  let bestDistance = Infinity;
  for (const [code, rgb] of ANSI_16) {
    const distance = rgb.reduce(
      (sum, component, i) => sum + (component - target[i]) ** 2,
      0,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCode = code;
    }
  }
  return `\x1b[${String(bestCode)}m`;
}

const RESET = "\x1b[0m";

/**
 * Wraps `text` in the SGR escape for `role` (one of the six CLI-parity roles
 * `packages/cli/src/palette.ts` also defines -- `PALETTE`'s two extra
 * root-only roles, `accentHover`/`accentActive`, are never passed here; the
 * statusline hook reads those directly instead), themed via
 * `resolveThemeId(env)` and rendered as truecolor or the nearest 16-color
 * code per `isTruecolor(env)` -- or returns `text` unchanged when
 * `supportsColor(stream, env)` is false, or when `paintUnavailable()`.
 */
export function paint(stream, role, text, env = process.env) {
  if (paintUnavailable() || !supportsColor(stream, env)) return text;
  const hex = PALETTE[resolveThemeId(env)][role];
  const sgr = isTruecolor(env) ? truecolorSgr(hex) : nearest16Sgr(hex);
  return `${sgr}${text}${RESET}`;
}
