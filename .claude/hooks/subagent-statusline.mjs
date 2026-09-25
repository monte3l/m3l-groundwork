#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * subagentStatusLine: renders a custom row body for each subagent shown in
 * the agent panel (code.claude.com/docs/en/statusline#subagent-status-lines).
 *
 * The command receives one JSON object on stdin per refresh tick: the base
 * hook fields, a `columns` field (usable row width), and a `tasks` array.
 * Each task may carry `id`, `name`, `type`, `status`, `description`, `label`,
 * `startTime`, `model`, `effort`, `contextWindowSize`, `tokenCount`,
 * `tokenSamples`, `cwd` -- `model`/`contextWindowSize` require Claude Code
 * v2.1.205+ and `effort` v2.1.214+. On an older version those fields are
 * simply absent and the row omits them.
 *
 * Output is one JSON line per row to override: `{"id": "<task id>", "content":
 * "<row body>"}`. A task is left with Claude Code's own default rendering
 * (name · description · token count) by omitting it from the output entirely
 * -- this happens whenever `id` or `name` is missing/unusable, rather than
 * guessing at a row.
 *
 * The elapsed-time color thresholds (15/30 minutes) mark a subagent worth a
 * glance and one that has probably stalled.
 *
 * Invariant: **no subprocess, no network** -- same as `statusline.mjs`: this
 * is a plain local `node` invocation with no I/O beyond stdin/stdout.
 *
 * Advisory-only: any parse failure or malformed payload exits 0 with no
 * output, leaving every row at Claude Code's own default rendering.
 */
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  YELLOW,
  formatTokenCount,
  truncateToWidth,
} from "./statusline-layout.mjs";

/** Elapsed-time threshold, in seconds, past which a row turns yellow. */
export const ELAPSED_WARN_THRESHOLD_SEC = 15 * 60;
/** Elapsed-time threshold, in seconds, past which a row turns red. */
export const ELAPSED_HIGH_THRESHOLD_SEC = 30 * 60;

/**
 * @param {unknown} value a task's `startTime` field. The documented
 *   `subagentStatusLine` payload shape does not pin down whether this is an
 *   epoch-millisecond number or an ISO 8601 string, so both are accepted.
 * @returns {number | null} epoch milliseconds, or null when unparseable.
 */
export function parseStartTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * @param {number} elapsedSec seconds elapsed, always non-negative when
 *   called from {@link formatSubagentRow}.
 * @returns {string} `"0m"`, `"NNm"`, or `"NhMMm"`.
 */
export function formatElapsed(elapsedSec) {
  const clamped = Math.max(0, Math.floor(elapsedSec));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * @param {number} elapsedSec
 * @returns {string} GREEN under 15 minutes, YELLOW at 15-30, RED at 30+.
 */
export function elapsedColor(elapsedSec) {
  if (elapsedSec >= ELAPSED_HIGH_THRESHOLD_SEC) return RED;
  if (elapsedSec >= ELAPSED_WARN_THRESHOLD_SEC) return YELLOW;
  return GREEN;
}

/**
 * @param {unknown} tokenCount
 * @param {unknown} contextWindowSize
 * @returns {string | null} `"12k/200k (6%)"`, or null when either field is
 *   absent/non-finite/non-positive — both require Claude Code v2.1.205+ and
 *   are omitted for a task whose model isn't resolved yet.
 */
export function formatTokenFraction(tokenCount, contextWindowSize) {
  if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount))
    return null;
  if (
    typeof contextWindowSize !== "number" ||
    !Number.isFinite(contextWindowSize) ||
    contextWindowSize <= 0
  )
    return null;
  const pct = Math.round((tokenCount / contextWindowSize) * 100);
  return `${formatTokenCount(tokenCount)}/${formatTokenCount(contextWindowSize)} (${pct}%)`;
}

/**
 * @param {unknown} effort a task's `effort` field — one of the effort level
 *   strings, or a numeric token budget.
 * @returns {string | null}
 */
export function formatEffort(effort) {
  if (typeof effort === "string" && effort.length > 0) return effort;
  if (typeof effort === "number" && Number.isFinite(effort))
    return formatTokenCount(effort);
  return null;
}

/**
 * @param {unknown} task one entry of the `tasks` array on the
 *   `subagentStatusLine` payload.
 * @param {{ now?: unknown } | undefined} env `now` overrides `Date.now()`
 *   for deterministic tests.
 * @returns {{ id: string, content: string } | null} an override line for
 *   this task, or null to leave Claude Code's default row rendering.
 */
export function formatSubagentRow(task, env) {
  if (typeof task !== "object" || task === null) return null;
  const { id, name, effort, startTime, tokenCount, contextWindowSize } =
    /** @type {Record<string, unknown>} */ (task);
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;

  const segments = [name];

  const effortText = formatEffort(effort);
  if (effortText !== null) segments.push(`${MAGENTA}${effortText}${RESET}`);

  const tokenText = formatTokenFraction(tokenCount, contextWindowSize);
  if (tokenText !== null) segments.push(tokenText);

  const startMs = parseStartTime(startTime);
  if (startMs !== null) {
    const nowMs = typeof env?.now === "number" ? env.now : Date.now();
    const elapsedSec = Math.max(0, (nowMs - startMs) / 1000);
    const color = elapsedColor(elapsedSec);
    segments.push(`${color}${formatElapsed(elapsedSec)}${RESET}`);
  }

  return { id, content: segments.join(`${DIM} · ${RESET}`) };
}

/**
 * Whether this module is the process's entry point (as opposed to being
 * imported by a test). `import.meta.url` is always the symlink-resolved path,
 * but `process.argv[1]` is kept exactly as typed, so comparing them directly
 * is false for any project under a symlinked directory -- macOS's `/tmp` and
 * `/var`, a symlinked home or volume, a symlinked workspace on Linux -- and the
 * script would then exit 0 having printed nothing at all.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Only run when invoked directly, not when imported for testing.
if (isEntryPoint()) {
  const raw = await readStdin();
  try {
    const payload = JSON.parse(raw);
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const columns =
      typeof payload?.columns === "number" && payload.columns > 0
        ? payload.columns
        : null;
    const env = { now: Date.now() };

    const lines = [];
    for (const task of tasks) {
      const row = formatSubagentRow(task, env);
      if (row === null) continue;
      const content =
        columns === null ? row.content : truncateToWidth(row.content, columns);
      lines.push(JSON.stringify({ id: row.id, content }));
    }

    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
  } catch {
    // Advisory-only: any parse failure or unexpected payload shape exits 0
    // with no output, leaving every row at Claude Code's own default
    // rendering — matches the file header's documented contract.
  }
  process.exit(0);
}
