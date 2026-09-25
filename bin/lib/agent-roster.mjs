// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The writer-spoke roster. A "spoke" is a subagent the hub-and-spoke model
 * dispatches to for a specific job (writing tests, writing implementation,
 * reviewing) rather than doing itself; a "roster" here is just the fixed
 * list of spoke names authorized for a given job. This roster names the
 * only subagents a PreToolUse[Write|Edit] hook trusts to write into a
 * guarded `src/`/`tests/` path. Kept as one small, static source so
 * `guard-hub-src-writes.mjs` and this project's `code-implementer`/
 * `test-author` agent definitions can't silently drift apart on who's
 * authorized to write what.
 */
export const WRITER_SPOKES = new Set(["test-author", "code-implementer"]);
