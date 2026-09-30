#!/usr/bin/env node
/**
 * SessionStart (matcher `compact|resume|startup`): reads the handoff
 * artifact `write-compact-handoff.mjs` (`PreCompact`) wrote and re-injects
 * it as `additionalContext` -- so state reconstruction doesn't depend on the
 * summary having retained it, whether the next session started because of a
 * compaction, a `--resume`/`--continue`, or a fresh `startup` that inherits
 * a worktree an earlier, since-killed session left dirty.
 *
 * `resume`/`startup` are included alongside `compact` because a
 * `compact`-only registration would leave a handoff written by a
 * `PreCompact` whose session was then killed (crash, OOM, Ctrl-C) sitting
 * in `tmp/` forever -- the next session, on any source, would never see it.
 * `SessionEnd` has no guaranteed abnormal-termination signal, so the fix is
 * on this read side, not a new write-side hook.
 *
 * Rooted the same way the write hook is: the git toplevel of the payload's
 * `cwd` (`resolveRoot` + `currentWorktree`), never a bare
 * `CLAUDE_PROJECT_DIR`, which stays pinned to the session's original checkout
 * inside a linked worktree. The artifact is session-keyed
 * (`tmp/compact-handoff-<session_id>.json`): `findHandoffPath` reads this
 * session's own file first, and only on `resume`/`startup` falls back to the
 * newest other handoff (keyed or legacy unkeyed) for orphan recovery -- never
 * on `compact`, where another session's file belongs to a live session. Only
 * the file actually read is deleted.
 *
 * Orphan recovery honours an age window on OTHER sessions' files (by mtime;
 * the session's own file has no age limit): younger than
 * `ORPHAN_MIN_AGE_MS` (10 min) is skipped, since it may belong to a live
 * session about to compact and reinject it itself; older than
 * `STALE_THRESHOLD_MS` (24h) is skipped and pruned; between the two, the
 * newest wins. Every candidate, own file included, must parse as a JSON
 * object -- an empty/corrupt one is deleted and skipped, and one entry that
 * vanishes or cannot be stat'd mid-scan is skipped rather than aborting the
 * scan. Only a missing/unreadable `tmp/` itself means "nothing to recover".
 *
 * A `resume`/`startup` read has no one-compaction freshness guarantee the
 * way a `compact` read does (it may be reading a handoff several sessions
 * old), so `formatHandoff` flags anything older than 24h as likely stale,
 * and says "git status unavailable at capture time" when the write side
 * recorded `uncommittedFiles: null` (git failed) rather than `[]` (clean).
 *
 * Advisory-only: always exits 0. A missing or unreadable artifact (first
 * compaction ever, or the write hook failed) means nothing to inject --
 * silently no-op rather than surfacing a confusing "handoff not found"
 * line every time the artifact is legitimately absent.
 */
import process from "node:process";
import {
  readFileSync,
  existsSync,
  unlinkSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  HANDOFF_GLOB_PREFIX,
  currentWorktree,
  handoffRelPath,
  resolveRoot,
} from "./write-compact-handoff.mjs";

/** Age past which a handoff is flagged stale, and another session's is pruned. */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum mtime age before another session's handoff is eligible for orphan
 * recovery -- a younger one may belong to a live session about to reinject it.
 */
export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * True when `handoff.capturedAt` parses to a timestamp more than 24h before
 * `nowMs`. A malformed or missing `capturedAt` is never treated as stale --
 * silence here means "no age signal available", not "definitely fresh".
 *
 * @param {Record<string, any>} handoff
 * @param {number} [nowMs] injectable for testing; defaults to `Date.now()`
 * @returns {boolean}
 */
export function isStale(handoff, nowMs = Date.now()) {
  const capturedAt = handoff.capturedAt;
  if (typeof capturedAt !== "string") return false;
  const capturedMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedMs)) return false;
  return nowMs - capturedMs > STALE_THRESHOLD_MS;
}

/**
 * Render a handoff payload (as built by `write-compact-handoff.mjs`) into
 * the `additionalContext` string.
 *
 * @param {Record<string, any>} handoff
 * @param {number} [nowMs] injectable for testing; defaults to `Date.now()`
 * @returns {string}
 */
export function formatHandoff(handoff, nowMs = Date.now()) {
  const lines = [
    "Prior-session handoff -- state captured just before an earlier " +
      "compaction, possibly from a session that has since ended:",
    `  • Branch: \`${handoff.branch || "(unknown)"}\` at \`${
      handoff.worktree || "(unknown)"
    }\``,
  ];

  const lastCommit = handoff.lastCommit;
  if (
    lastCommit &&
    typeof lastCommit === "object" &&
    typeof lastCommit.sha === "string"
  ) {
    lines.push(
      `  • Last commit: \`${lastCommit.sha.slice(0, 12)}\` ` +
        `(signature: \`${lastCommit.signature ?? "?"}\`)`,
    );
  }

  const uncommitted = Array.isArray(handoff.uncommittedFiles)
    ? handoff.uncommittedFiles
    : [];
  if (handoff.uncommittedFiles === null) {
    lines.push(
      "  • Uncommitted: unknown -- git status unavailable at capture time",
    );
  } else if (uncommitted.length > 0) {
    const shown = uncommitted.slice(0, 10);
    const more = uncommitted.length - shown.length;
    lines.push(
      `  • Uncommitted (${uncommitted.length}): ${shown.join(", ")}` +
        (more > 0 ? ` (+${more} more)` : ""),
    );
  }

  const journals = Array.isArray(handoff.journals) ? handoff.journals : [];
  if (journals.length > 0) {
    lines.push(`  • Scratchpad journal(s): ${journals.join(", ")}`);
  }

  if (isStale(handoff, nowMs)) {
    lines.push(
      "  ⚠ This handoff is more than 24h old -- likely stale, verify " +
        "carefully before trusting it.",
    );
  }

  lines.push(
    "Re-verify this against current `git status` before acting on it -- it " +
      "is a snapshot from just before compaction, not necessarily still " +
      "current.",
  );
  return lines.join("\n");
}

/** `SessionStart` `source` values this hook re-injects the handoff for. */
export const REINJECT_SOURCES = new Set(["compact", "resume", "startup"]);

/**
 * Belt-and-suspenders alongside the settings.json
 * `matcher: "compact|resume|startup"` registration -- if the harness ever
 * routes an unmatched `SessionStart` here, stay silent rather than
 * injecting a handoff into a `clear`/`fork` session it wasn't meant for.
 * `input` can itself be `null` (valid JSON, e.g. a bare `null` payload) or
 * any other shape -- read defensively rather than assume it's an object.
 * Extracted from the CLI entry block so this check is unit-testable without
 * spawning the script as a subprocess.
 *
 * @param {unknown} input the parsed `SessionStart` hook payload
 * @returns {boolean} true when this SessionStart's source is one this hook
 *   should re-inject the handoff for (compaction, resume, or startup)
 */
export function shouldReinject(input) {
  if (typeof input !== "object" || input === null) return false;
  const source = /** @type {{ source?: unknown }} */ (input).source;
  return typeof source === "string" && REINJECT_SOURCES.has(source);
}

/**
 * @param {string} handoffPath absolute path to the handoff artifact
 * @returns {Record<string, any> | null} parsed payload, or null if absent,
 *   unreadable, malformed, or not a JSON object
 */
export function readHandoff(handoffPath) {
  if (!existsSync(handoffPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(handoffPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** `SessionStart` sources allowed to pick up another session's handoff. */
const ORPHAN_RECOVERY_SOURCES = new Set(["resume", "startup"]);

const HANDOFF_FILE = new RegExp(`^${HANDOFF_GLOB_PREFIX}.*\\.json$`);

/**
 * Best-effort delete of a handoff candidate that must not be read again.
 *
 * @param {string} path
 */
function prune(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone or undeletable -- either way it is skipped, not read.
  }
}

/**
 * True when `path` holds a parseable handoff; an unparseable/empty one is
 * pruned so it can never shadow a valid candidate on a later scan.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isValidCandidate(path) {
  if (readHandoff(path) !== null) return true;
  prune(path);
  return false;
}

/**
 * Locate the handoff this session should re-inject.
 *
 * @param {string} root git toplevel the handoff lives under
 * @param {unknown} sessionId the payload's `session_id`
 * @param {string} source the payload's `source`
 * @param {number} [nowMs] injectable for testing; defaults to `Date.now()`
 * @returns {string | null} this session's own file when present and valid
 *   (any age); else, for `resume`/`startup` only, the newest-by-mtime valid
 *   other handoff in `tmp/` (keyed or legacy unkeyed) aged between
 *   `ORPHAN_MIN_AGE_MS` and `STALE_THRESHOLD_MS`; else null. Corrupt
 *   candidates and stale other-session files are pruned along the way.
 */
export function findHandoffPath(root, sessionId, source, nowMs = Date.now()) {
  const own = join(root, handoffRelPath(sessionId));
  if (existsSync(own) && isValidCandidate(own)) return own;
  if (!ORPHAN_RECOVERY_SOURCES.has(source)) return null;

  const tmpDir = join(root, "tmp");
  let entries;
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    // Missing/unreadable tmp/ -- nothing to recover.
    return null;
  }

  /** @type {Array<{ path: string, mtimeMs: number }>} */
  const eligible = [];
  for (const entry of entries) {
    if (!entry.isFile() || !HANDOFF_FILE.test(entry.name)) continue;
    const candidate = join(tmpDir, entry.name);
    if (candidate === own) continue;
    let mtimeMs;
    try {
      mtimeMs = statSync(candidate).mtimeMs;
    } catch {
      // Vanished or unstat-able mid-scan -- skip this entry, keep scanning.
      continue;
    }
    const ageMs = nowMs - mtimeMs;
    if (ageMs < ORPHAN_MIN_AGE_MS) continue;
    if (ageMs > STALE_THRESHOLD_MS) {
      prune(candidate);
      continue;
    }
    eligible.push({ path: candidate, mtimeMs });
  }

  eligible.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of eligible) {
    if (isValidCandidate(path)) return path;
  }
  return null;
}

// Deliberately inlined in every hook rather than shared, so each hook stays
// one self-contained file.
// `import.meta.url` is symlink-resolved but `process.argv[1]` is not, so
// comparing them directly is false under any symlinked path and the body would
// never run -- exit 0.
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

  if (!shouldReinject(input)) process.exit(0);

  const root = currentWorktree(resolveRoot(input, process.env, process.cwd()));
  const handoffPath = findHandoffPath(root, input.session_id, input.source);
  if (handoffPath === null) process.exit(0);
  const handoff = readHandoff(handoffPath);
  if (handoff === null) process.exit(0);

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatHandoff(handoff),
    },
  };
  process.stdout.write(JSON.stringify(output));

  // One-shot: a stale handoff re-injected after a SECOND compaction would
  // describe state from before the FIRST, no longer current. Consumed once --
  // and only the file actually read, never another session's.
  try {
    unlinkSync(handoffPath);
  } catch {
    // Not fatal -- the next PreCompact overwrites it regardless.
  }
  process.exit(0);
}
