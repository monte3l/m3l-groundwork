#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared structured-reporter contract every bin/check-*.mjs and bin/verify.mjs
 * gate routes through, so output is consistent (human-readable by default,
 * `--json` for machine consumption) without each gate reimplementing it.
 */
import { execFileSync } from "node:child_process";

/** True when `--json` is present in the given argv. */
export function parseJsonFlag(argv) {
  return argv.includes("--json");
}

/** The repository root, via `git rev-parse --show-toplevel`. */
export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

/**
 * Creates a reporter that accumulates `ok`/`warn`/`fail` lines, printing each
 * immediately (unless `json`, in which case only `finish()` prints, as one
 * JSON object). `finish()` sets `process.exitCode` (1 if anything failed) and
 * returns whether the run passed.
 */
export function createReporter(json) {
  const lines = [];
  let failed = false;

  function ok(message) {
    lines.push({ level: "ok", message });
    if (!json) console.log(`  ok  ${message}`);
  }

  function warn(message) {
    lines.push({ level: "warn", message });
    if (!json) console.warn(`warn  ${message}`);
  }

  function fail(message) {
    failed = true;
    lines.push({ level: "fail", message });
    if (!json) console.error(`fail  ${message}`);
  }

  function finish() {
    if (json) {
      console.log(JSON.stringify({ ok: !failed, lines }, null, 2));
    }
    process.exitCode = failed ? 1 : 0;
    return !failed;
  }

  return { ok, warn, fail, finish };
}
