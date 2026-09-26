// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GENERATED FILE -- do not hand-edit. Run `node bin/build-design-tokens.mjs`
 * to regenerate from design/source/dtcg (the vendored m3l-design tokens).
 * `--check` (used by `pnpm verify`) fails instead of writing on drift.
 * Source of truth: design/source/dtcg (DTCG 2025.10). See design/README.md.
 */

/** One role's resolved terminal color, per theme -- see term.ts's `paint()`. */
export interface PaletteRoleColors {
  readonly success: string;
  readonly info: string;
  readonly warning: string;
  readonly danger: string;
  readonly accent: string;
  readonly secondary: string;
}

/** {@link PaletteRoleColors} for each theme -- see term.ts's `resolveThemeId()`. */
export interface Palette {
  readonly light: PaletteRoleColors;
  readonly dark: PaletteRoleColors;
}

/** The resolved terminal palette, light and dark -- see term.ts's `paint()`. */
export const PALETTE: Palette = {
  light: {
    success: "#086d31",
    info: "#065da0",
    warning: "#7d4f0a",
    danger: "#963730",
    accent: "#692746",
    secondary: "#554d50",
  },
  dark: {
    success: "#89d298",
    info: "#8ac3fe",
    warning: "#ebb16c",
    danger: "#fda297",
    accent: "#d1789e",
    secondary: "#cdc5c8",
  },
};
