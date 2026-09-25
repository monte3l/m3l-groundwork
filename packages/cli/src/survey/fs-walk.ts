// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A bounded directory walk shared by every survey collector. Adopt mode may
 * run against an arbitrarily large pre-existing repository (dependency
 * trees, build output, a decade of history), so nothing under this package
 * ever does an unbounded recursive scan -- every walk skips the common
 * dependency/build directories and stops at an explicit depth.
 */
import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm",
  "out",
  ".nx",
]);

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the walk root, using forward slashes. */
  relPath: string;
  isDirectory: boolean;
}

/**
 * Recursively lists `root`, skipping known dependency/build directories and
 * stopping once a descendant is more than `maxDepth` directories below
 * `root`. Missing or unreadable directories are skipped, not thrown.
 */
export function walkBounded(root: string, maxDepth: number): WalkEntry[] {
  const results: WalkEntry[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absPath = join(dir, entry.name);
      const relPath = relative(root, absPath).split("\\").join("/");
      results.push({
        path: absPath,
        relPath,
        isDirectory: entry.isDirectory(),
      });

      if (entry.isDirectory()) {
        visit(absPath, depth + 1);
      }
    }
  };

  visit(root, 0);
  return results;
}
