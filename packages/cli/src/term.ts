// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Zero-dependency terminal coloring over the generated {@link PALETTE}
 * (`./palette.ts`, built from the vendored m3l-design tokens). Every function
 * here is pure: color support, theme and color depth are all decided from
 * the stream and environment the caller passes in.
 */
import process from "node:process";
import { PALETTE, type PaletteRoleColors } from "./palette.js";

/**
 * A semantic color role the palette defines for both themes.
 *
 * @example
 * ```ts
 * import type { PaletteRole } from "./term.js";
 * const role: PaletteRole = "success";
 * ```
 */
export type PaletteRole = keyof PaletteRoleColors;

/** One color channel triple, 0-255 each. */
type Rgb = readonly [r: number, g: number, b: number];

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The 16 standard ANSI foreground colors, as xterm's default RGB values. */
const ANSI_16: readonly { readonly code: number; readonly rgb: Rgb }[] = [
  { code: 30, rgb: [0, 0, 0] },
  { code: 31, rgb: [205, 0, 0] },
  { code: 32, rgb: [0, 205, 0] },
  { code: 33, rgb: [205, 205, 0] },
  { code: 34, rgb: [0, 0, 238] },
  { code: 35, rgb: [205, 0, 205] },
  { code: 36, rgb: [0, 205, 205] },
  { code: 37, rgb: [229, 229, 229] },
  { code: 90, rgb: [127, 127, 127] },
  { code: 91, rgb: [255, 0, 0] },
  { code: 92, rgb: [0, 255, 0] },
  { code: 93, rgb: [255, 255, 0] },
  { code: 94, rgb: [92, 92, 255] },
  { code: 95, rgb: [255, 0, 255] },
  { code: 96, rgb: [0, 255, 255] },
  { code: 97, rgb: [255, 255, 255] },
];

const RESET = "\x1b[0m";

/** Parses a strict `#rrggbb` string; throws a `RangeError` naming the value otherwise. */
function parseHex(hex: string): Rgb {
  const match = HEX_COLOR.exec(hex);
  const [, r, g, b] = match ?? [];
  if (r === undefined || g === undefined || b === undefined) {
    throw new RangeError(
      `invalid hex color ${JSON.stringify(hex)}: expected #rrggbb`,
    );
  }
  return [
    Number.parseInt(r, 16),
    Number.parseInt(g, 16),
    Number.parseInt(b, 16),
  ];
}

/**
 * Decides whether `stream` should receive color escapes. `NO_COLOR` (any
 * value, even empty) disables color outright; otherwise `FORCE_COLOR` set to
 * anything but `"0"` enables it; otherwise color follows `stream.isTTY`.
 *
 * @example
 * ```ts
 * import process from "node:process";
 * import { supportsColor } from "./term.js";
 * if (supportsColor(process.stdout, process.env)) {
 *   // safe to emit escapes
 * }
 * ```
 */
export function supportsColor(
  stream: { readonly isTTY?: boolean },
  env: NodeJS.ProcessEnv,
): boolean {
  if (env["NO_COLOR"] !== undefined) return false;
  const forceColor = env["FORCE_COLOR"];
  if (forceColor !== undefined) return forceColor !== "0";
  return stream.isTTY === true;
}

/**
 * Converts a `#rrggbb` color into a 24-bit SGR foreground escape.
 *
 * @throws RangeError if `hex` is not exactly `#` plus six hex digits.
 * @example
 * ```ts
 * import { truecolorSgr } from "./term.js";
 * truecolorSgr("#086d31"); // "\x1b[38;2;8;109;49m"
 * ```
 */
export function truecolorSgr(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}

/**
 * Converts a `#rrggbb` color into the SGR foreground escape of the nearest
 * of the 16 standard ANSI colors (squared Euclidean RGB distance).
 *
 * @throws RangeError if `hex` is not exactly `#` plus six hex digits.
 * @example
 * ```ts
 * import { nearest16Sgr } from "./term.js";
 * nearest16Sgr("#cd0000"); // "\x1b[31m"
 * ```
 */
export function nearest16Sgr(hex: string): string {
  const [r, g, b] = parseHex(hex);
  let bestCode = 30;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const { code, rgb } of ANSI_16) {
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCode = code;
    }
  }
  return `\x1b[${String(bestCode)}m`;
}

/**
 * Picks the palette theme from `COLORFGBG` (`"fg;bg"`): `"light"` when the
 * last segment is `15` or `7` (a white/light-grey background), `"dark"`
 * otherwise, including when the variable is absent or malformed.
 *
 * @example
 * ```ts
 * import { resolveThemeId } from "./term.js";
 * resolveThemeId({ COLORFGBG: "0;15" }); // "light"
 * ```
 */
export function resolveThemeId(env: NodeJS.ProcessEnv): "light" | "dark" {
  const colorfgbg = env["COLORFGBG"];
  if (colorfgbg?.includes(";") !== true) return "dark";
  const background = colorfgbg.slice(colorfgbg.lastIndexOf(";") + 1);
  return background === "15" || background === "7" ? "light" : "dark";
}

/**
 * Wraps `text` in the palette color for `role`, or returns it unchanged when
 * {@link supportsColor} says `stream` should not receive color. Uses a 24-bit
 * escape when `COLORTERM` is `truecolor`/`24bit`, the nearest ANSI-16 color
 * otherwise.
 *
 * @example
 * ```ts
 * import process from "node:process";
 * import { paint } from "./term.js";
 * console.log(paint(process.stdout, "success", "done"));
 * ```
 */
export function paint(
  stream: { readonly isTTY?: boolean },
  role: PaletteRole,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!supportsColor(stream, env)) return text;
  const hex = PALETTE[resolveThemeId(env)][role];
  const colorterm = env["COLORTERM"];
  const truecolor = colorterm === "truecolor" || colorterm === "24bit";
  const sgr = truecolor ? truecolorSgr(hex) : nearest16Sgr(hex);
  return `${sgr}${text}${RESET}`;
}
