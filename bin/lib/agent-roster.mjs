/**
 * The writer-spoke roster: the only subagent names a PreToolUse[Write|Edit]
 * hook trusts to write into a guarded `src/`/`tests/` path. Kept as one
 * small, static source so `guard-hub-src-writes.mjs` and this project's
 * `code-implementer`/`test-author` agent definitions can't silently drift
 * apart on who's authorized to write what.
 */
export const WRITER_SPOKES = new Set(["test-author", "code-implementer"]);
