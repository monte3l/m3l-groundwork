#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Reports the documentation pages that nobody has touched or reviewed for a while.
 *
 *   node freshness.mjs [--config <docs.config.mjs>] [--today <YYYY-MM-DD>] [--max-age <days>]
 *
 * A page's age is the newer of the date of the last commit that changed its file
 * and the `reviewed` date in its frontmatter (see `lib/freshness.mjs`). The limit
 * is `--max-age`, else the config's `freshness.maxAgeDays`, else 180 days.
 *
 * It reads the repository and writes nothing. The report is Markdown on standard
 * output, so a workflow can use it as the body of an issue. It is a report, not a
 * gate: `build.mjs --check` never fails on a page being old.
 *
 * Exit codes: 0 every page is fresh, 1 a page needs a look, 2 usage or config,
 * 3 git could not give the dates (a shallow clone is the usual cause: check out
 * with `fetch-depth: 0`) or a page could not be read.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./lib/config.mjs";
import { DEFAULT_MAX_AGE_DAYS, collectPageDates, freshnessFindings, isDate } from "./lib/freshness.mjs";

const USAGE = "usage: node freshness.mjs [--config <docs.config.mjs>] [--today <YYYY-MM-DD>] [--max-age <days>]";

/**
 * @param {string[]} argv
 * @returns {{ config: string, today: string | null, maxAge: number | null } | { error: string }}
 */
function parseArgs(argv) {
  const options = { config: "docs.config.mjs", today: null, maxAge: null };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name !== "--config" && name !== "--today" && name !== "--max-age") return { error: `cannot use "${name}"` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` };
    i += 1;
    if (name === "--config") options.config = value;
    else if (name === "--today") {
      if (!isDate(value)) return { error: `--today must be a date written YYYY-MM-DD, got "${value}"` };
      options.today = value;
    } else {
      if (!/^[1-9]\d*$/.test(value)) return { error: `--max-age must be a positive whole number of days, got "${value}"` };
      options.maxAge = Number(value);
    }
  }
  return options;
}

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   git?: (args: string[], cwd: string) => string,
 *   now?: () => string,
 * }} [io] injected by tests
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.err ?? ((text) => process.stderr.write(`${text}\n`));
  const usage = (message) => {
    err(`docs-kit freshness: ${message}`);
    err(USAGE);
    return 2;
  };
  const options = parseArgs(argv);
  if ("error" in options) return usage(options.error);

  let config;
  try {
    config = await loadConfig(options.config);
  } catch (error) {
    return usage(error instanceof ConfigError ? error.message : `cannot load the config: ${error?.message ?? error}`);
  }

  const today = options.today ?? (io.now ?? (() => new Date().toISOString().slice(0, 10)))();
  const maxAgeDays = options.maxAge ?? config.freshness?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  let pages;
  try {
    pages = collectPageDates(config, { read: (src) => readFileSync(path.join(config.root, src), "utf8"), git: io.git });
  } catch (error) {
    // Whatever stopped the read (no history, an unreadable page, git failing) is "could not check": 3, never 1,
    // because 1 means a page needs a look and a workflow would open an issue for it.
    err(`docs-kit freshness: ${error?.message ?? error}`);
    return 3;
  }

  const findings = freshnessFindings({ pages, today, maxAgeDays });
  if (findings.length === 0) {
    out(`All ${pages.length} pages were committed or reviewed within ${maxAgeDays} days (today is ${today}).`);
    return 0;
  }
  const flagged = new Set(findings.map((finding) => finding.src)).size;
  out(`${flagged} of ${pages.length} pages need a look (limit ${maxAgeDays} days, today is ${today}).`);
  out("");
  out("| Page | Finding | Detail |");
  out("| --- | --- | --- |");
  for (const finding of findings) out(`| \`${finding.src}\` | ${finding.kind} | ${finding.detail} |`);
  out("");
  out(
    "To clear a page, read it and fix what is out of date. If it is still true, set `reviewed: YYYY-MM-DD` in its frontmatter to the day you read it. Never set a date you did not earn: the report exists to be trusted.",
  );
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
