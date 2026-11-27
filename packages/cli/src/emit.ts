// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Copies `templates/core` into a target directory, applying token
 * substitution to both file contents and path segments (so a token in a
 * directory or file NAME, not just its content, is honored). A published
 * tarball stores `.gitignore`/`.npmrc`/`package-lock.json` as
 * `_gitignore`/`_npmrc`/`_package-lock.json` (npm strips the real names);
 * they are restored here -- see `assets.ts`.
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
  resolveRealPath,
} from "./fs-guard.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

// Extensions copied byte-for-byte, never text-decoded -- token substitution
// only makes sense for text content.
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico"]);

/**
 * True when `target` is `root` itself or lies inside it, both lexically and
 * once every symlink on the way is resolved. The lexical test is exact match
 * or proper prefix plus a separator -- never a bare `startsWith`, which would
 * wrongly accept a sibling path that merely shares `root`'s name as a prefix
 * (e.g. `/foo/bar-evil` against `/foo/bar`). The real-path test
 * ({@link resolveRealPath}) then refuses a `target` that reaches outside
 * `root` through a symlinked directory below it, and answers false when a
 * path cannot be resolved safely (a dangling link, a loop, a permission
 * error). Paths that do not exist yet are resolved from their longest
 * existing prefix, so a planned destination can be checked before it is
 * written. `root` is taken as given: a caller whose root may itself be a
 * symlink uses {@link isRealPathContained} with a root built on a real base.
 *
 * @example
 * ```ts
 * isPathContained("/foo/bar/x", "/foo/bar"); // true
 * isPathContained("/foo/bar", "/foo/bar"); // true
 * isPathContained("/foo/bar-evil/x", "/foo/bar"); // false
 * // /foo/bar/link -> /etc, so a path under it leaves the root:
 * isPathContained("/foo/bar/link/passwd", "/foo/bar"); // false
 * ```
 */
export function isPathContained(target: string, root: string): boolean {
  if (!isLexicallyContained(target, root)) return false;
  const realRoot = resolveRealPath(root);
  return realRoot !== undefined && isRealPathContained(target, realRoot);
}

/**
 * True when `target`, with every symlink on its way resolved
 * ({@link resolveRealPath}), is `realRoot` itself or lies inside it. `realRoot`
 * must already be a real path: it is not resolved here, so a root that is
 * itself a symlink out of the tree cannot vouch for what lies behind it.
 * False when `target` cannot be resolved safely.
 *
 * @example
 * ```ts
 * isRealPathContained("/work/app/.groundwork/x", "/work/app/.groundwork");
 * ```
 */
export function isRealPathContained(target: string, realRoot: string): boolean {
  const realTarget = resolveRealPath(target);
  return realTarget !== undefined && isLexicallyContained(realTarget, realRoot);
}

/**
 * The string-only half of {@link isPathContained}: `target`, once resolved, is
 * `root` itself or lies under it by proper prefix plus a separator. It never
 * touches the filesystem, for the invariants that check paths built from
 * constants rather than what is on disk.
 *
 * @example
 * ```ts
 * isLexicallyContained("/foo/bar/x", "/foo/bar"); // true
 * isLexicallyContained("/foo/bar-evil/x", "/foo/bar"); // false
 * ```
 */
export function isLexicallyContained(target: string, root: string): boolean {
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
        isLexicallyContained(targetPath, targetRoot),
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
