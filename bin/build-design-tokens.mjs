#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Generates `design/tokens.css` from the vendored m3l-design DTCG source
 * (`design/source/dtcg/`), using the resolver in `bin/lib/design-tokens.mjs`.
 * m3l-design's own format documents this file as something its artifact
 * page would compile, but the artifact never actually publishes it (there
 * is no upstream copy to vendor), so this repo builds it itself: light/dark
 * custom properties, the non-color scale, `@font-face` rules, and one
 * `.<style>` class per typography style.
 *
 * `--check` regenerates it in memory and fails (without writing) if it
 * differs from what is already on disk -- the drift gate wired into
 * `bin/lib/verify-steps.mjs` as the `design-tokens` step. Plain `node
 * bin/build-design-tokens.mjs` (no flag) writes it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { format as formatWithPrettier, resolveConfig } from "prettier";
import {
  DesignTokenError,
  loadDesignSystem,
  resolveTheme,
  requireLeafValue,
  deriveTypeTreatment,
  flattenFamily,
  flattenColors,
  formatColor,
  formatDimension,
  formatEasing,
  formatShadow,
  STYLE_NAMES,
  MONO_STYLES,
} from "./lib/design-tokens.mjs";
import { repoRoot } from "./lib/report.mjs";

const GENERATED_BANNER_LINES = [
  "GENERATED FILE -- do not hand-edit. Run `node bin/build-design-tokens.mjs`",
  "to regenerate from design/source/dtcg (the vendored m3l-design tokens).",
  "`--check` (used by `pnpm verify`) fails instead of writing on drift.",
];

/** Formats an em-unit number the way m3l-design's own tokens do: `0`, never `0em`. */
function formatEm(value) {
  return value === 0 ? "0" : `${value}em`;
}

/** Renders one `:root`-scoped block of `--name: value;` declarations. */
function renderVars(tokens, indent = "  ") {
  return tokens
    .map(({ name, value }) => `${indent}--${name}: ${value};`)
    .join("\n");
}

/** Renders a `@font-face`-suitable font-family list from a resolved `font-family.*` value. */
function renderFontFamilyList(value) {
  if (!Array.isArray(value)) {
    throw new DesignTokenError(
      `not a DTCG fontFamily value: ${JSON.stringify(value)}`,
    );
  }
  return value
    .map((name) => (name.includes(" ") ? `"${name}"` : name))
    .join(", ");
}

/** Renders the non-color, theme-invariant custom properties shared by every theme. */
function renderSharedVars(light, text) {
  const families = [
    flattenFamily(light, "space", "space", formatDimension),
    flattenFamily(light, "radius", "radius", formatDimension),
    flattenFamily(light, "duration", "duration", formatDimension),
    flattenFamily(light, "easing", "easing", formatEasing),
    flattenFamily(light, "breakpoint", "breakpoint", formatDimension),
    flattenFamily(light, "z-index", "z-index", (v) => String(v)),
    flattenFamily(light, "border-width", "border-width", formatDimension),
    flattenFamily(light, "focus-ring", "focus-ring", formatDimension),
    flattenFamily(light, "measure", "measure", formatDimension),
    flattenFamily(light, "shape", "shape", formatDimension),
    flattenFamily(light, "inset", "inset", formatDimension),
  ].flat();

  const paragraphSpacingNode = light["paragraph-spacing"];
  const paragraphSpacingEm =
    paragraphSpacingNode?.$extensions?.["org.monte3l.m3l-design"]?.em;
  if (paragraphSpacingEm === undefined) {
    throw new DesignTokenError(
      "design/source/dtcg: semantic.tokens.json's paragraph-spacing has no org.monte3l.m3l-design.em extension",
    );
  }

  const lines = [
    ...families.map(({ name, value }) => `  --${name}: ${value};`),
    `  --paragraph-spacing: ${formatEm(paragraphSpacingEm)};`,
    `  --font-sans: ${renderFontFamilyList(requireLeafValue(light, "font-family.sans"))};`,
    `  --font-mono: ${renderFontFamilyList(requireLeafValue(light, "font-family.mono"))};`,
    `  --text-align: ${text.textAlign};`,
    `  --text-emphasis-style: ${text.fontStyle};`,
    `  --text-emphasis-weight: ${text.emphasisWeight};`,
    `  --text-line-height: ${text.lineHeight};`,
    `  --text-word-spacing: ${formatEm(text.wordSpacing)};`,
    `  --font-variant-numeric: ${text.fontVariantNumeric};`,
    `  --font-variant-ligatures: ${text.fontVariantLigatures};`,
    ...[...text.letterSpacing.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([weight, em]) => `  --text-letter-spacing-${weight}: ${formatEm(em)};`,
      ),
  ];
  return lines.join("\n");
}

/** Renders one `.<style-name>` type-style class. */
function renderStyleClass(name, text) {
  const style = text.styles.get(name);
  const family = MONO_STYLES.has(name) ? "mono" : "sans";
  return [
    `.${name} {`,
    `  font-family: var(--font-${family});`,
    `  font-size: ${formatDimension(style.value.fontSize)};`,
    `  font-weight: ${style.value.fontWeight};`,
    `  line-height: var(--text-line-height);`,
    `  letter-spacing: ${formatEm(style.letterSpacingEm)};`,
    `  font-style: var(--text-emphasis-style);`,
    `  font-variant-numeric: var(--font-variant-numeric);`,
    `  font-variant-ligatures: var(--font-variant-ligatures);`,
    `  text-align: var(--text-align);`,
    `  word-spacing: ${formatEm(style.ext.wordSpacingEm)};`,
    `}`,
  ].join("\n");
}

const FONT_FACES = [
  {
    family: "Atkinson Hyperlegible Next",
    file: "fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2",
  },
  {
    family: "Atkinson Hyperlegible Mono",
    file: "fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2",
  },
];
const FONT_WEIGHT_RANGE = "200 800";

/**
 * Renders one `@font-face` rule. `file` is a path relative to `design/`
 * itself (`fonts/atkinson-…-normal.woff2`); the vendored copy sits one
 * level deeper, at `design/source/fonts/`.
 */
function renderFontFace({ family, file }) {
  return [
    `@font-face {`,
    `  font-family: "${family}";`,
    `  src: url("source/${file}") format("woff2");`,
    `  font-weight: ${FONT_WEIGHT_RANGE};`,
    `  font-style: normal;`,
    `  font-display: swap;`,
    `}`,
  ].join("\n");
}

// The six terminal status/text roles `packages/cli/src/term.ts` paints with
// -- each a dotted DTCG alias path, read from the already-resolved (per
// theme) tree via `requireLeafValue` and rendered through `formatColor`.
// Kept in this generator, not `design-tokens.mjs`, because it is
// `palette.ts`-specific: a consumer of the resolver, not a shape the
// resolver itself understands.
const PALETTE_ROLES = [
  ["success", "color.status.success.text"],
  ["info", "color.status.info.text"],
  ["warning", "color.status.warning.text"],
  ["danger", "color.status.danger.text"],
  ["accent", "color.accent.text"],
  ["secondary", "color.text.secondary"],
];

/** Reads every `PALETTE_ROLES` entry off one resolved theme tree, formatted as hex/rgba CSS color strings. */
function buildPaletteRoleColors(tree) {
  const out = {};
  for (const [role, dottedPath] of PALETTE_ROLES) {
    out[role] = formatColor(requireLeafValue(tree, dottedPath));
  }
  return out;
}

/** Renders one theme's `PaletteRoleColors` object literal, one field per `PALETTE_ROLES` entry, in that fixed order. */
function renderPaletteRoleObject(colors) {
  return PALETTE_ROLES.map(
    ([role]) => `    ${role}: ${JSON.stringify(colors[role])},`,
  ).join("\n");
}

/**
 * Builds `packages/cli/src/palette.ts`: the light/dark terminal status
 * colors `packages/cli/src/term.ts` paints console output with. Generated
 * (not hand-written) for the same reason `design/tokens.css` is -- so a
 * `design/source/dtcg/` re-sync can't silently drift the CLI's palette out
 * of step with the design system's actual color decisions.
 */
function buildPaletteTs({ light, dark }) {
  const banner = GENERATED_BANNER_LINES.map((line) => ` * ${line}`).join("\n");
  return `// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
${banner}
 * Source of truth: design/source/dtcg (DTCG 2025.10). See design/README.md.
 */

/** One role's resolved terminal color, per theme -- see term.ts's \`paint()\`. */
export interface PaletteRoleColors {
  readonly success: string;
  readonly info: string;
  readonly warning: string;
  readonly danger: string;
  readonly accent: string;
  readonly secondary: string;
}

/** {@link PaletteRoleColors} for each theme -- see term.ts's \`resolveThemeId()\`. */
export interface Palette {
  readonly light: PaletteRoleColors;
  readonly dark: PaletteRoleColors;
}

/** The resolved terminal palette, light and dark -- see term.ts's \`paint()\`. */
export const PALETTE: Palette = {
  light: {
${renderPaletteRoleObject(buildPaletteRoleColors(light))}
  },
  dark: {
${renderPaletteRoleObject(buildPaletteRoleColors(dark))}
  },
};
`;
}

/** Builds the full `design/tokens.css` text from the three already-resolved themed trees. */
function buildTokensCss({ light, dark, reduced }) {
  const text = deriveTypeTreatment(light);

  const lightColors = flattenColors(light);
  const darkColors = flattenColors(dark);
  const lightShadows = flattenFamily(light, "shadow", "shadow", formatShadow);
  const darkShadows = flattenFamily(dark, "shadow", "shadow", formatShadow);
  const reducedDurations = flattenFamily(
    reduced,
    "duration",
    "duration",
    formatDimension,
  );

  const styleClasses = STYLE_NAMES.map((name) =>
    renderStyleClass(name, text),
  ).join("\n\n");
  const fontFaces = FONT_FACES.map(renderFontFace).join("\n\n");

  const cssBanner = [
    ...GENERATED_BANNER_LINES,
    "Source of truth: design/source/dtcg (DTCG 2025.10). See design/README.md.",
  ]
    .map((line) => `   ${line}`)
    .join("\n");

  return `/*
${cssBanner}
*/

${fontFaces}

:root, [data-theme="light"] {
${renderVars(lightColors)}
${renderVars(lightShadows)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${renderVars(darkColors, "    ")}
${renderVars(darkShadows, "    ")}
  }
}

[data-theme="dark"] {
${renderVars(darkColors)}
${renderVars(darkShadows)}
}

:root {
${renderSharedVars(light, text)}
}

@media (prefers-reduced-motion: reduce) {
  :root {
${renderVars(reducedDurations, "    ")}
  }
}

${styleClasses}
`;
}

/**
 * Regenerates (or, under `--check`, diffs without writing) one generated
 * file. `content` is already run through this repo's own Prettier config,
 * so the checked-in file is never a step behind `pnpm format:check` -- a
 * hand run of `prettier --write` would otherwise silently put it back out
 * of sync with this step's `--check`. Returns whether the file was found
 * current (`--check` only; always `true` when writing).
 */
async function syncGeneratedFile(root, filePath, content, check) {
  const relPath = path.relative(root, filePath);
  if (check) {
    let existing;
    try {
      existing = await readFile(filePath, "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      existing = null;
    }
    if (existing !== content) {
      console.error(
        `fail  ${relPath} is out of date -- run \`node bin/build-design-tokens.mjs\` and commit the result`,
      );
      return false;
    }
    console.log(`  ok  ${relPath} is current`);
    return true;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log(`wrote ${relPath}`);
  return true;
}

async function main() {
  const root = repoRoot();
  const check = process.argv.includes("--check");
  const system = await loadDesignSystem(path.join(root, "design/source/dtcg"));

  const trees = {
    light: resolveTheme(system, "light", "default"),
    dark: resolveTheme(system, "dark", "default"),
    reduced: resolveTheme(system, "light", "reduced"),
  };

  const prettierConfig = (await resolveConfig(root)) ?? {};
  const tokensCssPath = path.join(root, "design/tokens.css");
  const paletteTsPath = path.join(root, "packages/cli/src/palette.ts");

  const [tokensCss, paletteTs] = await Promise.all([
    formatWithPrettier(buildTokensCss(trees), {
      ...prettierConfig,
      filepath: tokensCssPath,
    }),
    formatWithPrettier(buildPaletteTs(trees), {
      ...prettierConfig,
      filepath: paletteTsPath,
    }),
  ]);

  const results = await Promise.all([
    syncGeneratedFile(root, tokensCssPath, tokensCss, check),
    syncGeneratedFile(root, paletteTsPath, paletteTs, check),
  ]);

  if (check && results.some((current) => !current)) {
    process.exitCode = 1;
  }
}

await main();
