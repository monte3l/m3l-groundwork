// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * subagent-rows: a Claude Code mod that draws each subagent row in the agent
 * panel (code.claude.com/docs/en/plugins/mods/reference#render-sites,
 * `AgentRow`, Claude Code v2.1.326+). It replaces the deprecated
 * `subagentStatusLine` setting.
 *
 * The hook receives the agent's fields on `e.props` (`name`, `type`, `effort`,
 * `startTime` in epoch milliseconds, `tokenCount`, `contextWindowSize`,
 * `columns`) and answers by setting `props.body`: the whole row text, which may
 * hold SGR styles. A row with no usable label is passed on untouched, so Claude
 * Code draws its default row. On an older Claude Code the hook never fires and
 * rows keep their default look.
 *
 * A mod may import only files inside its own plugin directory, so the helpers
 * live in `row-format.mjs` rather than being imported from `.claude/hooks/`.
 *
 * Invariant: **no subprocess, no network, no I/O.** Advisory only: any error
 * passes the event on unchanged and never touches `isHidden`.
 */
import {
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  YELLOW,
  formatTokenCount,
  truncateToWidth,
} from "./row-format.mjs";

/** Elapsed-time threshold, in seconds, past which a row turns yellow. */
export const ELAPSED_WARN_THRESHOLD_SEC = 15 * 60;
/** Elapsed-time threshold, in seconds, past which a row turns red. */
export const ELAPSED_HIGH_THRESHOLD_SEC = 30 * 60;

/**
 * @param {unknown} value an agent's `startTime`: milliseconds since the Unix
 *   epoch. An ISO 8601 string is still accepted leniently.
 * @returns {number | null} epoch milliseconds, or null when unparseable.
 */
export function parseStartTime(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * @param {number} elapsedSec
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
 *   absent, non-finite or non-positive.
 */
export function formatTokenFraction(tokenCount, contextWindowSize) {
  if (
    typeof tokenCount !== "number" ||
    !Number.isFinite(tokenCount) ||
    tokenCount < 0
  )
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
 * @param {unknown} effort an effort level string, or a numeric token budget.
 * @returns {string | null}
 */
export function formatEffort(effort) {
  if (typeof effort === "string" && effort.length > 0) return effort;
  if (typeof effort === "number" && Number.isFinite(effort))
    return formatTokenCount(effort);
  return null;
}

/**
 * @param {unknown} props an `AgentRow` event's `props`.
 * @param {{ now?: unknown } | undefined} env `now` overrides `Date.now()` for
 *   deterministic tests.
 * @returns {string | null} the row body, or null to leave Claude Code's own
 *   row (no usable `name` or `type`).
 */
export function renderAgentRow(props, env) {
  if (typeof props !== "object" || props === null) return null;
  const {
    name,
    type,
    effort,
    startTime,
    tokenCount,
    contextWindowSize,
    columns,
  } = /** @type {Record<string, unknown>} */ (props);
  const label =
    typeof name === "string" && name.length > 0
      ? name
      : typeof type === "string" && type.length > 0
        ? type
        : null;
  if (label === null) return null;

  const segments = [label];

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

  const body = segments.join(`${DIM} · ${RESET}`);
  return typeof columns === "number" && Number.isInteger(columns) && columns > 0
    ? truncateToWidth(body, columns)
    : body;
}

/**
 * Entry point Claude Code calls with its hook registrar.
 *
 * @param {(event: string, matcher: { component: string }, handler: (
 *   _$: unknown, e: { props: Record<string, unknown> }, next: (e: unknown) => unknown
 * ) => unknown) => void} on
 */
export function register(on) {
  on("ui.render", { component: "AgentRow" }, (_$, e, next) => {
    /** @type {string | null} */
    let body = null;
    try {
      body = renderAgentRow(e?.props, { now: Date.now() });
    } catch {
      // Advisory only: a failure in this mod's own formatting leaves the row
      // as Claude Code draws it. Only that work is guarded -- `next` runs
      // exactly once, outside the try, so an error from a later handler or
      // from Claude Code's renderer is never absorbed or retried here. `body`
      // is still null, so the event passes on untouched.
    }
    return body === null
      ? next(e)
      : next({ ...e, props: { ...e.props, body } });
  });
}
