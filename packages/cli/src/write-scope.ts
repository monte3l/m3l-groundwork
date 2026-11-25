// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { isPathContained } from "./emit.js";
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
 * the install actually writes. The check is lexical -- it never touches the
 * filesystem, so it does not detect a symlinked directory component; that
 * refusal lives in the writers themselves (`fs-guard.ts`).
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
  const allowedRoots = [
    resolve(targetDir, GROUNDWORK_DEST_SEGMENTS[0]),
    resolve(targetDir, ...CLAUDE_DEST_SEGMENTS),
  ];
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    assert.ok(
      allowedRoots.some((root) => isPathContained(resolved, root)),
      `adopt mode wrote outside its scope: ${resolved}`,
    );
  }
}
