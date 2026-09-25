// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one place that decides where the CLI's data trees live: `templates/`
 * (the baseline and its packs) and the `/customize` plugin payload.
 *
 * Two layouts exist. In a **source checkout** they sit at the repo root, three
 * directories above `src/` or `dist/`. In a **published tarball** they are
 * vendored beside `dist/` (`scripts/vendor-assets.mjs` copies them in at
 * `prepack`), because a tarball cannot reach outside its own package.
 *
 * The checkout is probed first, and only by a positive marker. A vendored copy
 * can be left behind by a crashed `pnpm pack`; preferring it would make every
 * later dev run read a stale tree. And an unmarked three-hop walk from an
 * installed package lands in the consumer's `node_modules` (scoped) or, for an
 * unscoped name, on the consumer's own project root -- where an unrelated
 * `templates/` directory could be mistaken for ours.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where an asset lives in each layout, relative to that layout's root. */
export interface AssetPaths {
  /** Path from the repo root, in a source checkout. */
  repo: string;
  /** Path from the package root, in a published tarball. */
  local: string;
}

/**
 * Files npm-family tooling strips from a tarball no matter what `files` says
 * (`pnpm pack` keeps `.gitignore`, `npm pack` drops it; both drop `.npmrc`).
 * The vendored copy stores each under `_<name-without-dot>` and the walkers
 * (`emit.ts`, `conflicts.ts`) restore the real name on the way out.
 */
const ESCAPED_DOTFILES = [".gitignore", ".npmrc", ".npmignore"] as const;

/** The vendored spelling of a stripped dotfile: `.gitignore` becomes `_gitignore`. */
export function escapeDotfileName(name: string): string {
  return (ESCAPED_DOTFILES as readonly string[]).includes(name)
    ? `_${name.slice(1)}`
    : name;
}

/** Inverse of `escapeDotfileName`: `_gitignore` becomes `.gitignore`; every other name is unchanged. */
export function restoreDotfileName(name: string): string {
  const restored = `.${name.slice(1)}`;
  return name.startsWith("_") &&
    (ESCAPED_DOTFILES as readonly string[]).includes(restored)
    ? restored
    : name;
}

/** `restoreDotfileName` applied to the final segment of a `/`- or `\`-separated relative path. */
export function restoreDotfilePath(relPath: string): string {
  const cut = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  return relPath.slice(0, cut + 1) + restoreDotfileName(relPath.slice(cut + 1));
}

/** True when `dir` is this project's own source checkout, by two independent markers. */
function isSourceCheckout(dir: string): boolean {
  if (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    return false;
  }
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    return (
      typeof pkg === "object" &&
      pkg !== null &&
      "name" in pkg &&
      pkg.name === "m3l-groundwork"
    );
  } catch {
    return false;
  }
}

/**
 * Resolves an asset for whichever layout is running. `fromDir` is the
 * directory of a module at `src/` or `dist/` depth; it defaults to this
 * file's own, and is injectable so both layouts can be tested from one.
 */
export function resolveAsset(
  paths: AssetPaths,
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const repoRoot = join(fromDir, "..", "..", "..");
  if (isSourceCheckout(repoRoot)) {
    return join(repoRoot, paths.repo);
  }

  const vendored = join(fromDir, "..", paths.local);
  if (existsSync(vendored)) {
    return vendored;
  }

  throw new Error(
    `cannot locate "${paths.local}": not inside the m3l-groundwork checkout, and no vendored copy at ${vendored} -- ` +
      "a published package should ship one (see scripts/vendor-assets.mjs)",
  );
}
