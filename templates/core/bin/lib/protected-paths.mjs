// Single source of truth for the guarded source/test path shape used by the
// Claude hook layer to prevent hub-authored or branch-isolation writes into
// source and test trees. Shared by:
//   - .claude/hooks/guard-branch-isolation.mjs  (blocks writes while HEAD is main)
//   - .claude/hooks/guard-hub-src-writes.mjs    (blocks hub writes on any branch)
//
// Keeping the regex in one place means neither guard can silently diverge
// from the other when the protected glob set evolves.

/**
 * Returns true if `filePath` has any `src/` or `tests/` path segment --
 * this single check covers a flat `src/`/`tests/` layout AND a nested one
 * (`packages/<pkg>/src/`), since both contain the literal substring
 * `/src/` preceded by a path boundary.
 *
 * Matches both relative and absolute paths (the `(^|\/)` anchor).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProtectedPath(filePath) {
  return /(^|\/)src\//.test(filePath) || /(^|\/)tests\//.test(filePath);
}
