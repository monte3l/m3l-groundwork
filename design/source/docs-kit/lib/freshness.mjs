// SPDX-FileCopyrightText: 2026 Enrico Lionello (enri3l), Giulia Montevecchi (giulmonte), monte3l
// SPDX-License-Identifier: MIT

/**
 * Page freshness: how long ago each documentation page was last touched, and
 * which pages are older than a limit.
 *
 * A page's age comes from two dates, and the newer one wins:
 *
 * - the date of the last commit that changed its file, and
 * - the `reviewed` date in its frontmatter, which a person sets after reading
 *   the page again and finding it still true, without editing it.
 *
 * So an author writes nothing up front, and a page that is correct but never
 * edited can still be marked as checked. A `reviewed` date that is not a date,
 * or that has not happened yet, is reported and then ignored for the age, so
 * it can never hide a page.
 *
 * Everything here is a pure function except `gitLastDates`, which asks git and
 * takes the call as a parameter so tests need no repository.
 */
import { execFileSync } from "node:child_process";
import { globToRegExp } from "./checks.mjs";

export const DEFAULT_MAX_AGE_DAYS = 180;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const CONFIG_KEYS = ["maxAgeDays", "exclude", "lastmod"];

/** A problem reading dates from git. `code` is `shallow` (history is missing) or `git` (a call failed). */
export class FreshnessError extends Error {
  /**
   * @param {string} message
   * @param {"shallow" | "git"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "FreshnessError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean} whether `value` is a real calendar date written YYYY-MM-DD
 */
export function isDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @returns {number} whole days from `from` to `to`, negative when `to` is earlier
 */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * The `reviewed` key of a page's leading frontmatter. Only that one line is
 * read, so a page's other frontmatter keys (a wiki page's `sources`, a skill's
 * `name`) never matter. A trailing ` # comment` and one pair of quotes are
 * allowed.
 *
 * @param {string} source the page's Markdown
 * @returns {{ state: "absent" } | { state: "valid", date: string } | { state: "invalid", raw: string }}
 */
export function reviewedOf(source) {
  const block = FRONTMATTER_RE.exec(source);
  if (!block) return { state: "absent" };
  const line = block[1].split(/\r?\n/).find((candidate) => /^reviewed[ \t]*:/.test(candidate));
  if (line === undefined) return { state: "absent" };
  let value = line.slice(line.indexOf(":") + 1);
  const comment = value.search(/\s#/);
  if (comment !== -1) value = value.slice(0, comment);
  value = value.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
  return isDate(value) ? { state: "valid", date: value } : { state: "invalid", raw: value };
}

/**
 * @typedef {{ src: string, gitDate: string | null, reviewed: ReturnType<typeof reviewedOf> }} PageDates
 * @typedef {{ src: string, kind: "STALE" | "FUTURE" | "INVALID", detail: string }} Finding
 */

/**
 * What needs a person's attention, sorted by page.
 *
 * - `INVALID`: `reviewed` is not a date.
 * - `FUTURE`: `reviewed` is after today. Reported, because trusting it would
 *   hide the page from this report for as long as the date lies ahead.
 * - `STALE`: the newer of the last commit and a usable `reviewed` is more than
 *   `maxAgeDays` days ago. A page git has never seen and that has no usable
 *   `reviewed` has no age and is not reported.
 *
 * @param {{ pages: PageDates[], today: string, maxAgeDays?: number }} input
 * @returns {Finding[]}
 */
export function freshnessFindings({ pages, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  /** @type {Finding[]} */
  const findings = [];
  for (const page of pages) {
    let reviewed = null;
    if (page.reviewed.state === "invalid") {
      findings.push({ src: page.src, kind: "INVALID", detail: `reviewed "${page.reviewed.raw}" is not a date written YYYY-MM-DD` });
    } else if (page.reviewed.state === "valid") {
      if (page.reviewed.date > today) {
        findings.push({ src: page.src, kind: "FUTURE", detail: `reviewed ${page.reviewed.date} is after today (${today})` });
      } else {
        reviewed = page.reviewed.date;
      }
    }
    const candidates = [page.gitDate, reviewed].filter((date) => date !== null);
    if (candidates.length === 0) continue;
    // YYYY-MM-DD sorts as text in date order, so the last one is the newest.
    const touched = candidates.sort().at(-1);
    const age = daysBetween(touched, today);
    if (age > maxAgeDays) {
      const how = touched === reviewed ? "reviewed" : "last commit";
      findings.push({ src: page.src, kind: "STALE", detail: `last touched ${touched} (${how}), ${age} days ago` });
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return findings.sort((a, b) => order(a.src, b.src) || order(a.kind, b.kind));
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function runGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const reason = String(error.stderr ?? error.message).trim().split("\n")[0];
    throw new FreshnessError(`git ${args.find((arg) => !arg.startsWith("-"))} failed in ${cwd}: ${reason}`, "git");
  }
}

/**
 * The committer date (YYYY-MM-DD) of the last commit that changed each file,
 * from one `git log`. A file git has never seen is not in the result.
 *
 * A shallow clone has only the newest commits, so every date would be wrong
 * and wrong in a quiet way: that is an error, never an answer. Check out with
 * `fetch-depth: 0`.
 *
 * The paths are relative to `root`, which may be a subdirectory of the
 * repository (`--relative`), and are matched literally (`--literal-pathspecs`),
 * so a name with `[`, `*` or a leading `:` means itself. The log is NUL
 * separated (`-z`), because the default output quotes a name that holds a quote,
 * a backslash or a newline, and a quoted name would never match: that page would
 * silently get no date. It needs git 2.21 or later for `%cs`.
 *
 * @param {string} root the repository
 * @param {string[]} files repository-relative paths
 * @param {(args: string[], cwd: string) => string} [git]
 * @returns {Map<string, string>}
 * @throws {FreshnessError}
 */
export function gitLastDates(root, files, git = runGit) {
  const dates = new Map();
  if (files.length === 0) return dates;
  if (git(["rev-parse", "--is-shallow-repository"], root).trim() === "true") {
    throw new FreshnessError("this is a shallow clone, so the history that holds each page's date is missing. Check out with fetch-depth: 0", "shallow");
  }
  const wanted = new Set(files);
  const log = git(["--literal-pathspecs", "log", "-z", "--format=%x01%cs", "--name-only", "--no-renames", "--relative", "--", ...files], root);
  // With -z a commit is `\x01DATE` and then its names, each ended by NUL. Git puts one newline between the
  // record and the first name, so that one is dropped: a name may itself begin with a newline.
  let current = null;
  let afterHeader = false;
  for (const token of log.split("\0")) {
    if (token.startsWith("\u0001")) {
      current = token.slice(1);
      if (!isDate(current)) throw new FreshnessError(`git printed "${current}" where a date belongs: it needs git 2.21 or later`, "git");
      afterHeader = true;
      continue;
    }
    const name = afterHeader && token.startsWith("\n") ? token.slice(1) : token;
    afterHeader = false;
    if (current !== null && wanted.has(name) && !dates.has(name)) dates.set(name, current);
  }
  return dates;
}

/**
 * The dates of every page the report covers: the pages of the config that no
 * `freshness.exclude` glob names.
 *
 * @param {{ root: string, pages: Array<{ src: string }>, freshness?: { exclude?: Array<{ glob: string }> } }} config
 * @param {{ read: (src: string) => string, git?: (args: string[], cwd: string) => string }} io
 * @returns {PageDates[]}
 * @throws {FreshnessError}
 */
export function collectPageDates(config, { read, git }) {
  const skip = (config.freshness?.exclude ?? []).map((entry) => globToRegExp(entry.glob));
  const pages = config.pages.filter((page) => !skip.some((pattern) => pattern.test(page.src)));
  const dates = gitLastDates(config.root, pages.map((page) => page.src), git);
  return pages.map((page) => ({ src: page.src, gitDate: dates.get(page.src) ?? null, reviewed: reviewedOf(read(page.src)) }));
}

/**
 * The config problems of the `freshness` key, one message each, like `configProblems`.
 *
 * @param {Record<string, any>} c the config object
 * @returns {string[]}
 */
export function freshnessConfigProblems(c) {
  const f = c.freshness;
  if (f === undefined) return [];
  if (f === null || typeof f !== "object" || Array.isArray(f)) return [`"freshness" must be an object`];
  const problems = [];
  for (const key of Object.keys(f)) {
    if (!CONFIG_KEYS.includes(key)) problems.push(`"freshness.${key}" is not a key of "freshness" (use ${CONFIG_KEYS.join(", ")})`);
  }
  if (f.maxAgeDays !== undefined && !(Number.isInteger(f.maxAgeDays) && f.maxAgeDays > 0)) {
    problems.push(`"freshness.maxAgeDays" must be a positive whole number of days`);
  }
  if (f.exclude !== undefined) {
    const valid =
      Array.isArray(f.exclude) &&
      f.exclude.every((entry) => typeof entry?.glob === "string" && typeof entry?.reason === "string" && entry.reason.trim() !== "");
    if (!valid) problems.push(`"freshness.exclude" must be an array of { glob, reason }, each with a non-empty reason`);
  }
  if (f.lastmod !== undefined && typeof f.lastmod !== "boolean") {
    problems.push(`"freshness.lastmod" must be true or false`);
  }
  if (f.lastmod === true && !c.sitemap) {
    problems.push(`"freshness.lastmod" needs "sitemap": true, because the dates are written into sitemap.xml`);
  }
  return problems;
}
