// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  isLexicallyContained,
  isPathContained,
  isRealPathContained,
} from "./emit.js";
import { resolveRealPath } from "./fs-guard.js";
import {
  CLAUDE_DEST_SEGMENTS,
  GROUNDWORK_DEST_SEGMENTS,
} from "./customize-paths.js";

/**
 * Adopt mode's write-scope invariant (docs/assurance-case.md's trust
 * boundary around the adopted project): every path it writes resolves under
 * `<targetDir>/.groundwork/` or the guarded `/customize` install at
 * `<targetDir>/.claude/skills/customize/` -- never an existing project file.
 * `paths` may be absolute or relative to `targetDir`. Containment is
 * {@link isPathContained}'s, so a sibling that merely shares a root's name
 * as a prefix (`.groundwork-evil/`) is rejected. Both roots are derived from
 * `customize-paths.ts`'s segment constants, so they cannot drift from where
 * the install actually writes. The lexical check is followed by a real-path
 * one: `targetDir` is resolved first, and each path, with its symlinks
 * resolved, must lie under that real directory plus the root's segments, so a
 * `.groundwork` or `.claude/skills` that is a symlink out of the project is
 * refused. A path that cannot be resolved safely (a dangling link, a loop) is
 * refused too. The writers still refuse a symlinked component themselves
 * (`fs-guard.ts`); this is the second, independent check.
 *
 * @throws `AssertionError` (from `node:assert/strict`) naming the first path
 * that escapes both allowed roots.
 *
 * @example
 * ```ts
 * import { assertAdoptWriteScope } from "./write-scope.js";
 *
 * assertAdoptWriteScope("/work/app", [".groundwork/inventory.json"]); // ok
 * assertAdoptWriteScope("/work/app", ["/work/app/package.json"]); // throws
 * ```
 */
export function assertAdoptWriteScope(
  targetDir: string,
  paths: readonly string[],
): void {
  const segmentSets = [
    GROUNDWORK_DEST_SEGMENTS.slice(0, 1),
    CLAUDE_DEST_SEGMENTS,
  ];
  const allowedRoots = segmentSets.map((segments) =>
    resolve(targetDir, ...segments),
  );
  const realBase = resolveRealPath(targetDir);
  const realRoots =
    realBase === undefined
      ? []
      : segmentSets.map((segments) => resolve(realBase, ...segments));
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    const lexical = allowedRoots.some((root) =>
      isLexicallyContained(resolved, root),
    );
    const real = realRoots.some((root) => isRealPathContained(resolved, root));
    assert.ok(
      lexical && real,
      lexical
        ? `adopt mode wrote outside its scope: ${resolved} (a symlink on its path leads outside the project, or the path cannot be resolved)`
        : `adopt mode wrote outside its scope: ${resolved}`,
    );
  }
}

/**
 * `--update`'s write-scope invariant: every path it writes resolves under
 * `<targetDir>/.groundwork/update/` -- never a project file, the lock beside
 * it, adopt's inventory or add-pack's staging. `paths` may be absolute or
 * relative to `targetDir`; containment is {@link isPathContained}'s, so a
 * look-alike `.groundwork/update-evil/` is rejected. Lexical only: symlinked
 * components are refused by the writer itself (`fs-guard.ts`).
 *
 * @throws `AssertionError` (from `node:assert/strict`) naming the first path
 * outside the scope.
 *
 * @example
 * ```ts
 * import { assertUpdateWriteScope } from "./write-scope.js";
 *
 * assertUpdateWriteScope("/work/app", [".groundwork/update/plan.json"]); // ok
 * assertUpdateWriteScope("/work/app", ["package.json"]); // throws
 * ```
 */
export function assertUpdateWriteScope(
  targetDir: string,
  paths: readonly string[],
): void {
  const root = resolve(targetDir, GROUNDWORK_DEST_SEGMENTS[0], "update");
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    assert.ok(
      isPathContained(resolved, root),
      isLexicallyContained(resolved, root)
        ? `update mode wrote outside its scope: ${resolved} (a symlink on its path leads outside it, or the path cannot be resolved)`
        : `update mode wrote outside its scope: ${resolved}`,
    );
  }
}

/**
 * The string-only form of {@link assertAdoptWriteScope}, for paths built from
 * `customize-paths.ts`'s constants before anything is written. It reads no
 * filesystem state, so a symlinked `.claude` -- which the `/customize`
 * install answers by falling back to `.groundwork/customize/` -- does not
 * fail it; what the install then actually wrote is checked with
 * {@link assertAdoptWriteScope}.
 *
 * @throws `AssertionError` (from `node:assert/strict`) naming the first path
 * that escapes both allowed roots.
 *
 * @example
 * ```ts
 * import { assertAdoptPlannedScope } from "./write-scope.js";
 *
 * assertAdoptPlannedScope("/work/app", [".groundwork/inventory.json"]); // ok
 * ```
 */
export function assertAdoptPlannedScope(
  targetDir: string,
  paths: readonly string[],
): void {
  const allowedRoots = [
    resolve(targetDir, GROUNDWORK_DEST_SEGMENTS[0]),
    resolve(targetDir, ...CLAUDE_DEST_SEGMENTS),
  ];
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    assert.ok(
      allowedRoots.some((root) => isLexicallyContained(resolved, root)),
      `adopt mode planned a write outside its scope: ${resolved}`,
    );
  }
}
