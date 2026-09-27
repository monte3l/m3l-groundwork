// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared plumbing for a Claude Code hook script reading its PreToolUse/
 * PostToolUse JSON payload from stdin. Both `.claude/hooks/post-edit-verify.mjs`
 * and `.claude/hooks/nudge-invariants.mjs` parse the same stdin shape and
 * exclude the same handful of paths (an escape outside the project,
 * vendored dependencies, and this project's own generated-output
 * directories) -- kept here once so neither script can drift from the
 * other, the same reason `bin/lib/protected-paths.mjs` exists.
 */
import process from "node:process";

/**
 * Reads and JSON-parses the hook's stdin payload. Returns `undefined` on
 * any read/parse failure, or when the payload parses to something other
 * than an object (e.g. literal `null` or a bare number) -- the caller's
 * job is to decide what "no usable payload" means (every hook here treats
 * it as "silently allow/skip", never as a failure to report).
 */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? parsed : undefined;
}

/**
 * True when `rel` (a `/`-joined path already made relative to the project
 * root) should never be acted on by an in-loop hook: outside the project
 * entirely, a vendored dependency, or this project's own generated-output
 * directories (`dist/`, `coverage/`).
 */
export function isExcludedHookPath(rel) {
  return (
    rel.startsWith("..") ||
    rel.includes("node_modules/") ||
    /(^|\/)dist\//.test(rel) ||
    /(^|\/)coverage\//.test(rel)
  );
}
