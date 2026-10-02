// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Copies `templates/core` into a target directory, applying token
 * substitution to both file contents and path segments (so a token in a
 * directory or file NAME, not just its content, is honored). A published
 * tarball stores `.gitignore`/`.npmrc` as `_gitignore`/`_npmrc` (npm strips
 * the real names); they are restored here -- see `assets.ts`.
 *
 * Every destination path is planned and `lstat`-checked before the first
 * write ({@link assertSafeEmitDestinations}), so a symlink or a misplaced
 * file below the target refuses the whole emit rather than redirecting a
 * write outside it.
 */
import {
  readdirSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import { join, relative, dirname, extname, resolve, sep } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import {
  assertDirectoryComponent,
  assertFileDestination,
  FRESH_SYMLINK_ADVICE,
} from "./fs-guard.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

// Extensions copied byte-for-byte, never text-decoded -- token substitution
// only makes sense for text content.
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico"]);

/**
 * True when `target`, once resolved, is `root` itself or lies inside it.
 * Exact match or proper prefix plus a separator -- never a bare
 * `startsWith`, which would wrongly accept a sibling path that merely shares
 * `root`'s name as a prefix (e.g. `/foo/bar-evil` against `/foo/bar`).
 *
 * @example
 * ```ts
 * isPathContained("/foo/bar/x", "/foo/bar"); // true
 * isPathContained("/foo/bar", "/foo/bar"); // true
 * isPathContained("/foo/bar-evil/x", "/foo/bar"); // false
 * ```
 */
export function isPathContained(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + sep)
  );
}

export interface EmitResult {
  filesWritten: string[];
}

/** One planned destination: where it comes from, where it goes (relative to the target), and whether it is a directory. */
interface EmitEntry {
  readonly sourcePath: string;
  readonly relPath: string;
  readonly isDirectory: boolean;
}

/** Every destination `sourceDir` would emit under `targetRoot`, in walk order (a directory before its contents). */
function planEmit(
  sourceDir: string,
  targetRoot: string,
  tokens: TokenTable,
): EmitEntry[] {
  const entries: EmitEntry[] = [];
  const visit = (currentSourceDir: string): void => {
    for (const entry of readdirSync(currentSourceDir, {
      withFileTypes: true,
    })) {
      const sourcePath = join(currentSourceDir, entry.name);
      const relPath = restoreDotfilePath(
        applyTokens(relative(sourceDir, sourcePath), tokens),
      );
      const targetPath = join(targetRoot, relPath);

      // CWE-22 invariant (docs/assurance-case.md): a token value substituted
      // into a path segment must never walk the write out of `targetRoot`.
      assert.ok(
        isPathContained(targetPath, targetRoot),
        `emitTemplate: target path ${resolve(targetPath)} escapes ${resolve(targetRoot)}`,
      );

      const isDirectory = entry.isDirectory();
      entries.push({ sourcePath, relPath, isDirectory });
      if (isDirectory) visit(sourcePath);
    }
  };
  visit(sourceDir);
  return entries;
}

/**
 * `lstat`-checks every destination of `entries` under `targetRoot`: each
 * directory component strictly below `targetRoot` must be missing or a real
 * directory, and each destination file must not be a symlink. Ancestors are
 * checked before descendants, so the topmost offending path is the one named.
 */
function assertPlanSafe(
  targetRoot: string,
  entries: readonly EmitEntry[],
): void {
  const checked = new Set<string>();
  for (const { relPath, isDirectory } of entries) {
    const segments = relPath.split(sep);
    const dirCount = isDirectory ? segments.length : segments.length - 1;
    for (let depth = 1; depth <= dirCount; depth++) {
      const dirPath = join(targetRoot, ...segments.slice(0, depth));
      if (checked.has(dirPath)) continue;
      checked.add(dirPath);
      assertDirectoryComponent(dirPath, FRESH_SYMLINK_ADVICE);
    }
    if (!isDirectory) {
      assertFileDestination(join(targetRoot, relPath), FRESH_SYMLINK_ADVICE);
    }
  }
}

/**
 * Refuses, before anything is written, when any destination that emitting
 * each of `sourceDirs` into `targetDir` would touch is a symlink (dangling
 * or not) or a non-directory where a directory is needed. `targetDir`
 * itself and its ancestors are not checked -- only paths strictly below it.
 * The error names the offending path and ends with fresh mode's single
 * `--fresh --force` retry instruction; nothing is written either way.
 *
 * @throws `Error` naming the first offending destination path.
 *
 * @example
 * ```ts
 * import { assertSafeEmitDestinations, emitTemplate } from "./emit.js";
 *
 * // Validate the baseline AND a pack's payload before writing either.
 * assertSafeEmitDestinations(["/tpl/core", "/tpl/packs/x/files"], "/work/app", {});
 * emitTemplate("/tpl/core", "/work/app", {});
 * ```
 */
export function assertSafeEmitDestinations(
  sourceDirs: readonly string[],
  targetDir: string,
  tokens: TokenTable,
): void {
  for (const sourceDir of sourceDirs) {
    assertPlanSafe(targetDir, planEmit(sourceDir, targetDir, tokens));
  }
}

/**
 * Recursively copies `sourceDir` into `targetDir`, applying `tokens`. Every
 * destination is validated first (see {@link assertSafeEmitDestinations}),
 * so a refusal writes nothing.
 *
 * @throws `Error` naming a symlinked or non-directory destination component.
 *
 * @example
 * ```ts
 * import { emitTemplate } from "./emit.js";
 *
 * const { filesWritten } = emitTemplate("/tpl/core", "/work/app", {
 *   PROJECT_NAME: "app",
 * });
 * ```
 */
export function emitTemplate(
  sourceDir: string,
  targetDir: string,
  tokens: TokenTable,
): EmitResult {
  const entries = planEmit(sourceDir, targetDir, tokens);
  assertPlanSafe(targetDir, entries);

  const filesWritten: string[] = [];
  for (const { sourcePath, relPath, isDirectory } of entries) {
    const targetPath = join(targetDir, relPath);
    if (isDirectory) {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });

    if (BINARY_EXTENSIONS.has(extname(sourcePath))) {
      copyFileSync(sourcePath, targetPath);
    } else {
      const content = readFileSync(sourcePath, "utf8");
      writeFileSync(targetPath, applyTokens(content, tokens));
    }

    filesWritten.push(relPath);
  }
  return { filesWritten };
}
