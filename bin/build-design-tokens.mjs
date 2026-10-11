#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Generates `packages/cli/src/palette.ts` (the CLI's terminal status colors)
 * from the vendored m3l-design DTCG source (`design/source/dtcg/`), using the
 * resolver in `bin/lib/design-tokens.mjs`. `design/tokens.css` is no longer
 * built here: m3l-design publishes it in each release and `sync-design.sh`
 * copies it verbatim (checked by `design/SHA256SUMS`).
 *
 * `--check` regenerates the file in memory and fails (without writing) if it
 * differs from what is already on disk -- the drift gate wired into
 * `bin/lib/verify-steps.mjs` as the `design-tokens` step. Plain `node
 * bin/build-design-tokens.mjs` (no flag) writes it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { format as formatWithPrettier, resolveConfig } from "prettier";
import {
  loadDesignSystem,
  resolveTheme,
  requireLeafValue,
  formatColor,
} from "./lib/design-tokens.mjs";
import { repoRoot } from "./lib/report.mjs";

const GENERATED_BANNER_LINES = [
  "GENERATED FILE -- do not hand-edit. Run `node bin/build-design-tokens.mjs`",
  "to regenerate from design/source/dtcg (the vendored m3l-design tokens).",
  "`--check` (used by `pnpm verify`) fails instead of writing on drift.",
];

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
  const paletteTsPath = path.join(root, "packages/cli/src/palette.ts");

  const paletteTs = await formatWithPrettier(buildPaletteTs(trees), {
    ...prettierConfig,
    filepath: paletteTsPath,
  });

  const current = await syncGeneratedFile(
    root,
    paletteTsPath,
    paletteTs,
    check,
  );

  if (check && !current) {
    process.exitCode = 1;
  }
}

await main();
