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
import {
  isAbsentError,
  readFailure,
  unreadableNote,
  unresolvableCode,
} from "./internal/read-guard.js";

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

// Claude Code creates git worktrees at `.claude/worktrees/<name>/` -- each a
// full second checkout that must not be walked twice. Matched as an exact
// path relative to the walk root, never by bare name: a directory literally
// named `worktrees` elsewhere (`src/worktrees/`, `.claude/skills/worktrees/`)
// is real project content and must stay visible to every survey.
const SKIP_REL_DIR_PATHS = new Set([".claude/worktrees"]);

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the walk root, using forward slashes. */
  relPath: string;
  isDirectory: boolean;
}

/**
 * The shared bounded walk. `onListFailure` decides what a failed directory
 * listing means: it returns normally to skip the directory, or throws.
 */
function walk(
  root: string,
  maxDepth: number,
  onListFailure: (dir: string, error: unknown) => void,
): WalkEntry[] {
  const results: WalkEntry[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      onListFailure(dir, error);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absPath = join(dir, entry.name);
      const relPath = relative(root, absPath).split("\\").join("/");
      if (entry.isDirectory() && SKIP_REL_DIR_PATHS.has(relPath)) {
        continue;
      }

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

/**
 * Recursively lists `root`, skipping known dependency/build directories and
 * stopping once a descendant is more than `maxDepth` directories below
 * `root`. A missing directory (`ENOENT`/`ENOTDIR`, the same absent set
 * `guardedExists` uses) is skipped silently. An unreadable or unresolvable
 * one (`EACCES`/`EPERM`, or a symlink loop's `ELOOP`) is skipped too, but
 * recorded in `undetermined`. Any other listing
 * failure (`EIO`, `EMFILE`, ...) throws an `Error` naming the directory, with
 * the original as `cause`. For the survey collectors; the graders use
 * {@link walkBoundedForGrading} instead.
 *
 * @example
 * ```ts
 * const undetermined: string[] = [];
 * const markdown = walkBounded("/path/to/project", 2, undetermined).filter(
 *   (entry) => !entry.isDirectory && entry.relPath.endsWith(".md"),
 * );
 * ```
 */
export function walkBounded(
  root: string,
  maxDepth: number,
  undetermined: string[],
): WalkEntry[] {
  return walk(root, maxDepth, (dir, error) => {
    const code = unresolvableCode(error);
    if (code !== undefined) {
      undetermined.push(unreadableNote(dir, code));
      return;
    }
    if (isAbsentError(error)) return;
    throw readFailure(dir, error);
  });
}

/**
 * The same bounded listing as {@link walkBounded}, but a directory whose
 * listing fails for ANY reason is skipped silently, never thrown. For the
 * harness and toolchain graders (`harness/grade.ts`, `toolchain/grade.ts`)
 * only: a grader never throws, and its emitted `.mjs` twins
 * (`templates/core/bin/lib/{harness,toolchain}-rules.mjs`) swallow every
 * listing failure in their own `walkBounded` -- this keeps both sides' grades
 * identical for the same tree. The survey keeps {@link walkBounded}'s errno
 * discrimination.
 *
 * @example
 * ```ts
 * const files = walkBoundedForGrading("/path/to/project", 4).filter(
 *   (entry) => !entry.isDirectory,
 * );
 * ```
 */
export function walkBoundedForGrading(
  root: string,
  maxDepth: number,
): WalkEntry[] {
  return walk(root, maxDepth, () => {
    // Deliberately swallowed: parity with the emitted twins' bare `catch`.
  });
}
