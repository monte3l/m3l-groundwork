#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks any hub-authored write into a
 * guarded source or test path, on any branch -- only the designated writer
 * subagents (`code-implementer`, `test-author`) may edit that code; every
 * other caller, including the hub itself, gets refused.
 *
 * Problem: `guard-branch-isolation.mjs` only fires while `HEAD` is `main`.
 * On a feature branch nothing else stops the hub itself from writing
 * directly into a guarded path instead of dispatching the write to a writer
 * spoke, as CLAUDE.md's Agent Operating Model requires.
 *
 * The seam: the PreToolUse payload carries a top-level `agent_type` field
 * when the tool call fires inside a subagent context. The field is absent
 * (or empty) for hub-level calls, and contains the subagent's name for
 * spoke calls.
 *
 * The decision: block when BOTH conditions hold:
 *   (a) the target path is a guarded source/test path, AND
 *   (b) `agent_type` is NOT the name of an authorised writer spoke
 *       (`code-implementer` or `test-author`, per WRITER_SPOKES in
 *        bin/lib/agent-roster.mjs).
 *
 * Hub calls (absent/empty agent_type) and non-writer subagents are treated
 * identically -- both are blocked from guarded paths. Writer spokes are
 * allowed through. All other paths are allowed through unconditionally.
 *
 * Fail-open: an unparseable payload or missing file_path exits 0 so a
 * malformed hook input never wedges the session.
 */
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isProtectedPath } from "../../bin/lib/protected-paths.mjs";
import { WRITER_SPOKES } from "../../bin/lib/agent-roster.mjs";

/**
 * Pure decision function -- exported for unit testing.
 *
 * @param {string | undefined} filePath  The file_path from the tool_input payload.
 * @param {unknown} agentType            The top-level agent_type from the payload.
 * @returns {boolean} true = block, false = allow.
 */
export function shouldBlockHubSrcWrite(filePath, agentType) {
  if (!filePath || typeof filePath !== "string") return false;
  if (!isProtectedPath(filePath)) return false;
  if (
    typeof agentType === "string" &&
    agentType.length > 0 &&
    WRITER_SPOKES.has(agentType)
  ) {
    return false;
  }
  return true;
}

// Kept as a duplicated, self-contained block in every hook file rather than
// imported from a shared helper -- each hook stays a single independent
// file, which keeps this project's hook count easy to reason about against
// CLAUDE.md's hook budget. `import.meta.url` is symlink-resolved but
// `process.argv[1]` is not, so comparing them directly would be false under
// a symlinked invocation path -- and the guard below would then never run,
// i.e. silently fail open (exit 0) instead of blocking.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }
  const filePath = input.tool_input?.file_path ?? "";
  const agentType = input.agent_type;
  if (!shouldBlockHubSrcWrite(filePath, agentType)) process.exit(0);
  process.stderr.write(
    "guard-hub-src-writes: Hub-authored write to a guarded path detected.\n" +
      `  Path: ${filePath}\n` +
      "  Dispatch the write to 'code-implementer' (src/**) or 'test-author' (tests/**) instead.\n" +
      "  See: CLAUDE.md's Agent Operating Model.\n",
  );
  process.exit(2);
}
