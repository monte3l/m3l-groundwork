#!/usr/bin/env node
/**
 * statusLine: renders a fixed five-row layout -- session, model, context,
 * quota, work -- built entirely from the JSON Claude Code pipes to stdin
 * (code.claude.com/docs/en/statusline). The five-row guarantee is
 * `renderStatusLine`'s own contract on the success path only: the CLI entry's
 * `catch` (bottom of this file) falls back to a single minimal `ctx --%` line
 * on a JSON-parse failure, by design -- the fallback must never itself risk
 * throwing, so it does not attempt to build five gutter+placeholder rows.
 *
 * Each row is width-fit against the real terminal width via
 * `statusline-layout.mjs`'s `fitRow`/`terminalColumns`/`displayWidth`: Anthropic's
 * docs state that `COLUMNS` must be read from the environment (`tput cols`
 * does not work inside a statusLine subprocess), and that reading is what lets
 * a narrow terminal drop its lowest-priority segments instead of wrapping
 * mid-line.
 *
 * `statusLine` is the one documented surface exposing live
 * `context_window.used_percentage` -- no hook event receives token/context
 * data -- so this is the one place a "when to compact" signal can live.
 *
 * Invariant: **no subprocess, no network.** The script runs on every new
 * assistant message (debounced 300ms; a new trigger cancels an in-flight
 * run), so a spawn here would be the most frequently paid cost in the whole
 * harness. Git state is read straight from `.git/HEAD` via `node:fs` -- a
 * local synchronous file read, not a `git` shell-out -- and memory from
 * `process.availableMemory()`/`os.totalmem()`, local syscalls (see
 * {@link resolveMemory} for why not `os.freemem()`). Every other field
 * (`context_window.*`, `workspace.*`, `model`, `effort`, `cost`,
 * `rate_limits`, `prompt_cache`, `agent`, ...) already arrives on stdin.
 *
 * Threshold values (70 / 90) match Anthropic's own documented multi-line
 * status-line example (green under 70, yellow 70-89, red 90+) rather than
 * inventing project-specific numbers.
 *
 * Advisory-only: any parse or read failure falls back to a minimal
 * `ctx --%` segment rather than an empty or broken status line.
 */
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BLUE,
  CYAN,
  DIM,
  GREEN,
  GUTTER_WIDTH,
  MAGENTA,
  PLACEHOLDER,
  RED,
  RESET,
  SEGMENT_SEPARATOR,
  YELLOW,
  displayWidth,
  fitRow,
  formatDuration,
  formatTokenCount,
  terminalColumns,
} from "./statusline-layout.mjs";

export const WARN_THRESHOLD_PERCENT = 70;
export const HIGH_THRESHOLD_PERCENT = 90;
export const CONTEXT_BAR_WIDTH = 20;
export const QUOTA_BAR_WIDTH = 10;

/**
 * @typedef {{ id: string, priority: number, text: string, minWidth: number }} RowSegment
 */

/**
 * Safe nested read: returns `undefined` as soon as any step along `path` is
 * not an object, so every segment below can probe a payload field without a
 * wall of `typeof` checks.
 *
 * @param {unknown} value
 * @param {...string} path
 * @returns {unknown}
 */
function pick(value, ...path) {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = /** @type {Record<string, unknown>} */ (current)[key];
  }
  return current;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Strips C0/C1 control characters and DEL from a payload string before it is
 * rendered. Branch names, session names, and repo names are user- or
 * remote-controlled text; an embedded escape sequence must not be able to
 * repaint the terminal or forge a segment of its own.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeDisplayText(text) {
  const controlChars = new RegExp(
    "[" +
      String.fromCharCode(0) +
      "-" +
      String.fromCharCode(31) +
      String.fromCharCode(127) +
      "-" +
      String.fromCharCode(159) +
      "]",
    "g",
  );
  return text.replace(controlChars, "");
}

/**
 * @param {unknown} payload the parsed statusLine stdin JSON
 * @returns {number | null} `context_window.used_percentage`, rounded and
 *   clamped to `[0, 100]`, or null when the session has no context-window
 *   data yet (before the first API response, or immediately after
 *   `/compact`).
 */
export function resolveUsedPercentage(payload) {
  const pct = pick(payload, "context_window", "used_percentage");
  return isFiniteNumber(pct)
    ? Math.min(100, Math.max(0, Math.round(pct)))
    : null;
}

/**
 * @param {number | null} pct
 * @returns {"unknown" | "ok" | "warn" | "high"}
 */
export function zoneForPercentage(pct) {
  if (pct === null) return "unknown";
  if (pct >= HIGH_THRESHOLD_PERCENT) return "high";
  if (pct >= WARN_THRESHOLD_PERCENT) return "warn";
  return "ok";
}

/**
 * @param {"unknown" | "ok" | "warn" | "high"} zone
 * @returns {string} the ANSI color for a usage zone.
 */
function zoneColor(zone) {
  if (zone === "high") return RED;
  if (zone === "warn") return YELLOW;
  return GREEN;
}

/**
 * @param {number} pct clamped to `[0, 100]`.
 * @param {number} width
 * @returns {string} a `█`/`░` bar `width` cells wide.
 */
function renderBar(pct, width) {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * @param {unknown} headContent raw `.git/HEAD` file content.
 * @returns {string | null} the branch name, or null for detached HEAD / a
 *   raw SHA / garbage.
 */
export function parseHeadRef(headContent) {
  if (typeof headContent !== "string") return null;
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(headContent.trim());
  return match ? match[1].trim() : null;
}

/**
 * @param {unknown} content raw `.git` file content (linked worktree /
 *   submodule case).
 * @returns {string | null} the pointed-to gitdir path, or null.
 */
export function parseGitdirPointer(content) {
  if (typeof content !== "string") return null;
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  return match ? match[1].trim() : null;
}

/**
 * Walks upward from `startDir` looking for `.git` (a directory, the normal
 * case, or a file pointing at the real gitdir, the linked-worktree /
 * submodule case) and returns the directory that holds it -- the resolved
 * workspace root. Pure with respect to actual disk I/O -- all reads go
 * through the injected `readFile` -- so this is directly unit-testable
 * without touching a real filesystem.
 *
 * `payload.workspace.current_dir` is not always the repo root: it diverges the
 * moment a session `cd`s into a subdirectory or enters a worktree
 * in-session, so the branch is resolved by walking up rather than trusting
 * `startDir` verbatim.
 *
 * @param {(path: string) => string | null} readFile injected file reader;
 *   returns the file content or null when unreadable/absent.
 * @param {unknown} startDir directory to start the upward walk from; a
 *   non-string or empty value returns null rather than throwing.
 * @returns {string | null} the resolved workspace root, or null when no
 *   `.git` is found within the walk bound.
 */
export function resolveWorkspaceRoot(readFile, startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return null;

  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    if (typeof readFile(join(dir, ".git", "HEAD")) === "string") return dir;
    if (typeof readFile(join(dir, ".git")) === "string") return dir;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolves the current branch from the workspace root {@link resolveWorkspaceRoot}
 * finds by walking upward from `startDir` -- handling both a `.git` directory
 * (the normal case) and a `.git` file pointing at the real gitdir (the
 * linked-worktree / submodule case).
 *
 * @param {(path: string) => string | null} readFile injected file reader;
 *   returns the file content or null when unreadable/absent.
 * @param {unknown} startDir directory to start the upward walk from; a
 *   non-string or empty value returns null rather than throwing.
 * @returns {string | null} the branch name, or null when it can't be
 *   resolved.
 */
export function resolveBranch(readFile, startDir) {
  const dir = resolveWorkspaceRoot(readFile, startDir);
  if (dir === null) return null;

  const headContent = readFile(join(dir, ".git", "HEAD"));
  if (typeof headContent === "string") {
    return parseHeadRef(headContent);
  }

  const gitEntry = readFile(join(dir, ".git"));
  if (typeof gitEntry === "string") {
    const pointer = parseGitdirPointer(gitEntry);
    if (pointer === null || pointer.length === 0) return null;
    const resolvedGitDir = isAbsolute(pointer) ? pointer : join(dir, pointer);
    const linkedHead = readFile(join(resolvedGitDir, "HEAD"));
    return typeof linkedHead === "string" ? parseHeadRef(linkedHead) : null;
  }

  return null;
}

/**
 * Builds a `{ id, priority, text, minWidth }` row segment, or `null` when
 * `text` is absent -- the shared shape every `format*Segment` function below
 * returns so `fitRow` can budget/drop them uniformly. Higher `priority`
 * survives longer as a row narrows.
 *
 * @param {string} id
 * @param {number} priority
 * @param {string | null | undefined} text
 * @param {number} minWidth
 * @returns {RowSegment | null}
 */
function seg(id, priority, text, minWidth) {
  return text === null || text === undefined
    ? null
    : { id, priority, text, minWidth };
}

/**
 * @param {string} label
 * @returns {string} the dim, fixed-width row label.
 */
function gutter(label) {
  return `${DIM}${label.padEnd(GUTTER_WIDTH)}${RESET}`;
}

/**
 * @param {string} label
 * @param {ReadonlyArray<RowSegment | null>} segments
 * @param {number} columns
 * @returns {string} one rendered row: a fixed gutter label plus the
 *   width-fit, separator-joined segments -- `PLACEHOLDER` when every segment
 *   is absent, so every row always renders exactly one non-empty line.
 */
function buildRow(label, segments, columns) {
  const g = gutter(label);
  const nonEmpty = /** @type {RowSegment[]} */ (
    segments.filter((s) => s !== null)
  );
  if (nonEmpty.length === 0) return `${g}${PLACEHOLDER}`;
  const budget = columns - displayWidth(g);
  return `${g}${fitRow(nonEmpty, budget, SEGMENT_SEPARATOR)}`;
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} dim `↳ agent-name` segment, or null when absent.
 */
export function formatAgentSegment(payload) {
  const name = pick(payload, "agent", "name");
  if (!isNonEmptyString(name)) return null;
  return seg("agent", 55, `${DIM}↳ ${sanitizeDisplayText(name)}${RESET}`, 6);
}

/**
 * Always renders, unlike most segments here: a session with no name is itself
 * worth seeing, and `payload.session_name` is absent until a `--name`,
 * `/rename`, or an AI-generated title exists.
 *
 * @param {unknown} payload
 * @returns {RowSegment} the session name, or a dim `unnamed` marker -- never
 *   null.
 */
export function formatSessionNameSegment(payload) {
  const name = pick(payload, "session_name");
  const text = isNonEmptyString(name)
    ? sanitizeDisplayText(name)
    : `${DIM}unnamed${RESET}`;
  return /** @type {RowSegment} */ (seg("session_name", 100, text, 12));
}

/**
 * @param {string | null} branchName the resolved branch, or null.
 * @returns {RowSegment | null} the branch segment. `main` is flagged as a
 *   warning: the baseline's workflow is feature branches and PRs, never work
 *   directly on `main`.
 */
export function formatBranchSegment(branchName) {
  if (!isNonEmptyString(branchName)) return null;
  const text =
    branchName === "main"
      ? `${RED}⚠ main${RESET}`
      : `${BLUE}🌿 ${sanitizeDisplayText(branchName)}${RESET}`;
  return seg("branch", 95, text, 6);
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the `🌳 name` segment, or null when
 *   `workspace.git_worktree` is absent/empty.
 */
export function formatWorktreeSegment(payload) {
  const name = pick(payload, "workspace", "git_worktree");
  if (!isNonEmptyString(name)) return null;
  return seg(
    "worktree",
    85,
    `${BLUE}🌳 ${sanitizeDisplayText(name)}${RESET}`,
    6,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} dim `owner/name` for the `origin` remote, with
 *   the host prefixed unless it is github.com; null outside a git repository
 *   or when no `origin` remote is configured.
 */
export function formatOriginRepoSegment(payload) {
  const host = pick(payload, "workspace", "repo", "host");
  const owner = pick(payload, "workspace", "repo", "owner");
  const name = pick(payload, "workspace", "repo", "name");
  if (!isNonEmptyString(owner) || !isNonEmptyString(name)) return null;
  const prefix =
    isNonEmptyString(host) && host !== "github.com" ? `${host}/` : "";
  return seg(
    "origin_repo",
    40,
    `${DIM}${sanitizeDisplayText(`${prefix}${owner}/${name}`)}${RESET}`,
    10,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the model's display name (falling back to its
 *   id), or null when neither is present.
 */
export function formatModelSegment(payload) {
  const display = pick(payload, "model", "display_name");
  const id = pick(payload, "model", "id");
  const name = isNonEmptyString(display) ? display : id;
  if (!isNonEmptyString(name)) return null;
  return seg("model", 100, `${CYAN}${sanitizeDisplayText(name)}${RESET}`, 6);
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} `effort.level`, or null when the current model
 *   doesn't support the effort parameter.
 */
export function formatEffortSegment(payload) {
  const level = pick(payload, "effort", "level");
  if (!isNonEmptyString(level)) return null;
  return seg(
    "effort",
    80,
    `${DIM}effort${RESET} ${MAGENTA}${sanitizeDisplayText(level)}${RESET}`,
    8,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} a `thinking` marker when extended thinking is
 *   enabled; hidden when it is off, since off is the uninteresting case.
 */
export function formatThinkingSegment(payload) {
  return pick(payload, "thinking", "enabled") === true
    ? seg("thinking", 60, `${MAGENTA}thinking${RESET}`, 8)
    : null;
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} a `⚡ fast` marker when fast mode is on.
 */
export function formatFastModeSegment(payload) {
  return pick(payload, "fast_mode") === true
    ? seg("fast_mode", 70, `${YELLOW}⚡ fast${RESET}`, 6)
    : null;
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the output style's name, hidden for `default`.
 */
export function formatOutputStyleSegment(payload) {
  const name = pick(payload, "output_style", "name");
  if (!isNonEmptyString(name) || name === "default") return null;
  return seg(
    "output_style",
    40,
    `${DIM}style ${sanitizeDisplayText(name)}${RESET}`,
    8,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the vim mode, or null when vim mode is off.
 */
export function formatVimModeSegment(payload) {
  const mode = pick(payload, "vim", "mode");
  if (!isNonEmptyString(mode)) return null;
  return seg("vim_mode", 50, `${CYAN}${sanitizeDisplayText(mode)}${RESET}`, 6);
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the context-window usage bar, colored by
 *   zone; null when the session has no context data yet.
 */
export function formatContextBarSegment(payload) {
  const pct = resolveUsedPercentage(payload);
  if (pct === null) return null;
  const color = zoneColor(zoneForPercentage(pct));
  return seg(
    "context_bar",
    50,
    `${color}${renderBar(pct, CONTEXT_BAR_WIDTH)}${RESET}`,
    10,
  );
}

/**
 * Always renders: a dim `--%` stands in before the first API response and
 * right after `/compact`, when `used_percentage` is `null`.
 *
 * @param {unknown} payload
 * @returns {RowSegment}
 */
export function formatContextPercentSegment(payload) {
  const pct = resolveUsedPercentage(payload);
  const text =
    pct === null
      ? `${DIM}--%${RESET}`
      : `${zoneColor(zoneForPercentage(pct))}${pct}%${RESET}`;
  return /** @type {RowSegment} */ (seg("context_pct", 100, text, 3));
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} `45k/200k`: tokens in the window over the
 *   window's size; null when either is absent or non-positive.
 */
export function formatContextDenominatorSegment(payload) {
  const numerator = pick(payload, "context_window", "total_input_tokens");
  const denominator = pick(payload, "context_window", "context_window_size");
  if (
    !isFiniteNumber(numerator) ||
    numerator <= 0 ||
    !isFiniteNumber(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  const text = `${formatTokenCount(numerator)}/${formatTokenCount(denominator)}`;
  return seg("context_denom", 80, text, 10);
}

/**
 * @param {"unknown" | "ok" | "warn" | "high"} zone
 * @returns {string | null} a `/compact` nudge once the window is filling up,
 *   null while there is plenty of room. This is the "when to compact" signal;
 *   what survives a compaction is a separate concern.
 */
export function buildCompactSuggestion(zone) {
  if (zone === "high") return "/compact now";
  if (zone === "warn") return "/compact soon";
  return null;
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} `~155k left`, plus a compact suggestion once
 *   the window passes the warn threshold; null when the remaining share or
 *   window size is absent.
 */
export function formatContextHeadroomSegment(payload) {
  const remainingPct = pick(payload, "context_window", "remaining_percentage");
  const windowSize = pick(payload, "context_window", "context_window_size");
  if (
    !isFiniteNumber(remainingPct) ||
    !isFiniteNumber(windowSize) ||
    windowSize <= 0
  ) {
    return null;
  }
  const clamped = Math.min(100, Math.max(0, remainingPct));
  const color = zoneColor(zoneForPercentage(Math.round(100 - clamped)));
  const left = `~${formatTokenCount((clamped / 100) * windowSize)} left`;
  const suggestion = buildCompactSuggestion(
    zoneForPercentage(Math.round(100 - clamped)),
  );
  const text =
    suggestion === null
      ? `${color}${left}${RESET}`
      : `${color}${left}${RESET}${SEGMENT_SEPARATOR}${color}${suggestion}${RESET}`;
  return seg("context_headroom", 60, text, 10);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number} priority
 * @param {unknown} window one of `rate_limits.five_hour` / `seven_day` /
 *   `spend_limit`.
 * @param {number} nowMs
 * @returns {RowSegment | null} `5h ███░░░░░░░ 23% ↻2h10m`; null when the
 *   window is absent (each window is independently absent, and Claude Code
 *   drops one once its `resets_at` passes).
 */
function formatQuotaWindow(id, label, priority, window, nowMs) {
  const used = pick(window, "used_percentage");
  if (!isFiniteNumber(used)) return null;

  const barPct = Math.min(100, Math.max(0, used));
  const color = zoneColor(zoneForPercentage(Math.round(barPct)));
  const resetsAt = pick(window, "resets_at");
  const resetText = isFiniteNumber(resetsAt)
    ? ` ${DIM}↻${formatDuration(Math.floor(resetsAt - nowMs / 1000))}${RESET}`
    : "";
  const text = `${DIM}${label}${RESET} ${color}${renderBar(barPct, QUOTA_BAR_WIDTH)}${RESET} ${Math.round(used)}%${resetText}`;
  return seg(id, priority, text, 8);
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @returns {RowSegment | null}
 */
export function formatFiveHourSegment(payload, nowMs) {
  return formatQuotaWindow(
    "five_hour",
    "5h",
    100,
    pick(payload, "rate_limits", "five_hour"),
    nowMs,
  );
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @returns {RowSegment | null}
 */
export function formatSevenDaySegment(payload, nowMs) {
  return formatQuotaWindow(
    "seven_day",
    "7d",
    90,
    pick(payload, "rate_limits", "seven_day"),
    nowMs,
  );
}

/**
 * @param {unknown} payload
 * @param {number} nowMs
 * @returns {RowSegment | null} present only behind a Claude apps gateway that
 *   sets a spend limit for the user.
 */
export function formatSpendLimitSegment(payload, nowMs) {
  return formatQuotaWindow(
    "spend_limit",
    "spend",
    70,
    pick(payload, "rate_limits", "spend_limit"),
    nowMs,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} the estimated session cost in USD.
 */
export function formatCostSegment(payload) {
  const cost = pick(payload, "cost", "total_cost_usd");
  if (!isFiniteNumber(cost) || cost < 0) return null;
  return seg("cost", 100, `$${cost.toFixed(2)}`, 5);
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} elapsed wall-clock time since the session
 *   started; hidden at zero, where `formatDuration` would read `now`.
 */
export function formatDurationSegment(payload) {
  const ms = pick(payload, "cost", "total_duration_ms");
  if (!isFiniteNumber(ms) || ms <= 0) return null;
  return seg(
    "duration",
    90,
    `${DIM}${formatDuration(Math.floor(ms / 1000))}${RESET}`,
    3,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} `+156/-23`; null when nothing has changed.
 */
export function formatLinesChangedSegment(payload) {
  const added = pick(payload, "cost", "total_lines_added");
  const removed = pick(payload, "cost", "total_lines_removed");
  const a = isFiniteNumber(added) ? added : 0;
  const r = isFiniteNumber(removed) ? removed : 0;
  if (a <= 0 && r <= 0) return null;
  return seg(
    "lines",
    70,
    `${GREEN}+${a}${RESET}${DIM}/${RESET}${RED}-${r}${RESET}`,
    6,
  );
}

/**
 * @param {unknown} payload
 * @returns {RowSegment | null} `cache 91%`: the prompt-cache hit ratio, green
 *   while the cache is warm and yellow once it has gone cold (the next request
 *   then pays to rebuild it); null before the first API response.
 */
export function formatCacheSegment(payload) {
  const ratio = pick(payload, "prompt_cache", "hit_ratio");
  if (!isFiniteNumber(ratio)) return null;
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const color = pick(payload, "prompt_cache", "warm") === true ? GREEN : YELLOW;
  return seg("cache", 60, `${DIM}cache${RESET} ${color}${pct}%${RESET}`, 8);
}

/**
 * @param {number} bytes
 * @returns {string} gibibytes to one decimal, trailing `.0` dropped.
 */
function gigabytes(bytes) {
  return String(Math.round((bytes / 2 ** 30) * 10) / 10);
}

/**
 * Picks the free/total memory figures to display, identically on macOS and
 * Linux, with no subprocess.
 *
 * `os.freemem()` is not portable in meaning: on Linux it is `MemAvailable`
 * (free plus reclaimable cache), but on macOS it is only the free and
 * speculative pages, leaving out the large inactive/purgeable share the
 * kernel will happily reclaim -- so it understates what is available and can
 * leave the segment needlessly red on a healthy machine. `process.availableMemory()`
 * (Node 22+) counts that reclaimable share on both platforms, and on Linux also
 * respects a cgroup limit, so it is preferred. When it is missing (an older
 * Node in an adopted project) macOS shows no memory segment at all rather
 * than a number that means something else, while Linux falls back to
 * `os.freemem()`, whose meaning is right there.
 *
 * `total` is likewise capped at the cgroup limit when one applies, so a
 * container with a small limit on a large host reads as a fraction of the
 * container, not of the host.
 *
 * Pure and dependency-injected so both platforms' branches are testable from
 * either one.
 *
 * @param {{
 *   platform: string;
 *   totalmem: number;
 *   freemem: number;
 *   availableMemory?: unknown;
 *   constrainedMemory?: unknown;
 * }} sources
 * @returns {{ freemem: number, totalmem: number } | Record<string, never>}
 *   the figures in bytes, or `{}` when no trustworthy free figure exists.
 */
export function resolveMemory(sources) {
  const { platform, availableMemory, constrainedMemory } = sources;
  let total = sources.totalmem;
  if (
    isFiniteNumber(constrainedMemory) &&
    constrainedMemory > 0 &&
    constrainedMemory < total
  ) {
    total = constrainedMemory;
  }
  if (!isFiniteNumber(total) || total <= 0) return {};

  let free;
  if (isFiniteNumber(availableMemory) && availableMemory >= 0) {
    free = availableMemory;
  } else if (platform === "darwin") {
    return {};
  } else {
    free = sources.freemem;
  }
  if (!isFiniteNumber(free)) return {};

  return { freemem: Math.min(free, total), totalmem: total };
}

/**
 * @param {{ freemem?: unknown, totalmem?: unknown } | undefined} env
 * @returns {RowSegment | null} `9.2/32G free`, colored by how much is in use;
 *   null when either figure is absent.
 */
export function formatMemorySegment(env) {
  const freemem = env?.freemem;
  const totalmem = env?.totalmem;
  if (
    typeof freemem !== "number" ||
    !Number.isFinite(freemem) ||
    typeof totalmem !== "number" ||
    !Number.isFinite(totalmem) ||
    totalmem <= 0
  ) {
    return null;
  }
  const freePct = (freemem / totalmem) * 100;
  const zone = zoneForPercentage(100 - freePct);
  const text = `${zoneColor(zone)}${gigabytes(freemem)}/${gigabytes(totalmem)}G free${RESET}`;
  return seg("memory", 50, text, 10);
}

/**
 * @param {unknown} payload
 * @param {{ branch?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the session row: session name, branch, worktree, agent,
 *   origin repo.
 */
export function buildSessionRow(payload, env, columns) {
  return buildRow(
    "session",
    [
      formatSessionNameSegment(payload),
      formatBranchSegment(typeof env?.branch === "string" ? env.branch : null),
      formatWorktreeSegment(payload),
      formatAgentSegment(payload),
      formatOriginRepoSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {number} columns
 * @returns {string} the model row: model, effort, thinking, fast mode, output
 *   style, vim mode.
 */
export function buildModelRow(payload, columns) {
  return buildRow(
    "model",
    [
      formatModelSegment(payload),
      formatEffortSegment(payload),
      formatThinkingSegment(payload),
      formatFastModeSegment(payload),
      formatOutputStyleSegment(payload),
      formatVimModeSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {number} columns
 * @returns {string} the context row: usage bar, percent, denominator,
 *   headroom (with a compact suggestion once the window fills).
 */
export function buildContextRow(payload, columns) {
  return buildRow(
    "context",
    [
      formatContextBarSegment(payload),
      formatContextPercentSegment(payload),
      formatContextDenominatorSegment(payload),
      formatContextHeadroomSegment(payload),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{ now?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the quota row: 5-hour, 7-day, and spend-limit windows.
 *   Renders a placeholder for anyone without a subscription rate limit.
 */
export function buildQuotaRow(payload, env, columns) {
  const nowMs = isFiniteNumber(env?.now) ? env.now : Date.now();
  return buildRow(
    "quota",
    [
      formatFiveHourSegment(payload, nowMs),
      formatSevenDaySegment(payload, nowMs),
      formatSpendLimitSegment(payload, nowMs),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{ freemem?: unknown, totalmem?: unknown } | undefined} env
 * @param {number} columns
 * @returns {string} the work row: cost, duration, lines changed, cache, memory.
 */
export function buildWorkRow(payload, env, columns) {
  return buildRow(
    "work",
    [
      formatCostSegment(payload),
      formatDurationSegment(payload),
      formatLinesChangedSegment(payload),
      formatCacheSegment(payload),
      formatMemorySegment(env),
    ],
    columns,
  );
}

/**
 * @param {unknown} payload
 * @param {{
 *   now?: unknown;
 *   freemem?: unknown;
 *   totalmem?: unknown;
 *   branch?: unknown;
 *   COLUMNS?: unknown;
 * }} [env] local-only, non-payload context: current time (ms), free/total
 *   memory (bytes), the resolved git branch name, and the terminal `COLUMNS`
 *   width. Defaults to `{}` so a bare `renderStatusLine(payload)` call works.
 * @returns {string} the full, always-five-line status-line output.
 */
export function renderStatusLine(payload, env = {}) {
  const columns = terminalColumns(env);
  return [
    buildSessionRow(payload, env, columns),
    buildModelRow(payload, columns),
    buildContextRow(payload, columns),
    buildQuotaRow(payload, env, columns),
    buildWorkRow(payload, env, columns),
  ].join("\n");
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
  let output;
  try {
    const payload = JSON.parse(await readStdin());
    const startDir =
      pick(payload, "workspace", "current_dir") ?? pick(payload, "cwd");
    output = renderStatusLine(payload, {
      now: Date.now(),
      branch: resolveBranch(safeReadFile, startDir),
      COLUMNS: process.env["COLUMNS"],
      ...resolveMemory({
        platform: process.platform,
        totalmem: os.totalmem(),
        freemem: os.freemem(),
        availableMemory: process.availableMemory?.(),
        constrainedMemory: process.constrainedMemory?.(),
      }),
    });
  } catch {
    output = "ctx --%";
  }
  process.stdout.write(`${output}\n`);
}
